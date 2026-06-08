# Collaboration Safety and Scaling Review

Review scope: branch `lody/87ec2365-f4d`, compared with `origin/main`.

Current note: Grove's dedicated relay now lives in `apps/grove-relay`. References
below to `apps/collab-editor` describe the historical implementation reviewed
before the relay was split out.

This document records the collaboration review findings and the recommended
fixes. The review focused on owner-backed single-file sharing, the
`apps/collab-editor` Durable Object relay, and the `apps/local-md-workspace`
client collaboration code.

## Summary

The branch has the right high-level product boundary: guests edit one file
through a relay, and only the owner's browser writes back to local storage or a
Dropbox mirror. The critical problem is that the relay currently has an
authorization bypass through the legacy room WebSocket route. The next most
important work is adding hard resource limits and bounded queues so the relay
and clients fail predictably under abuse or large documents.

Recommended release posture:

1. Block release until the legacy `/api/doc/:shareId/ws` bypass is fixed.
2. Add relay input limits, share creation limits, and queue limits before broad
   exposure.
3. Move the more structural performance work, segmented update logs and
   reconnect delta sync, into follow-up PRs after the safety fixes.

## Current Architecture

- `POST /api/shares` creates a relay share in a Durable Object named by
  `shareId`.
- `POST /api/shares/:shareId/session` verifies a guest or host secret and
  returns a session token.
- `/api/shares/:shareId/ws?sessionToken=...` joins the authenticated share
  WebSocket.
- The owner stores non-secret share metadata in browser storage. Host
  capabilities remain in browser localStorage and are not written to the
  local folder or Dropbox mirror.
- The owner host agent imports relay edits, materializes the merged document to
  the owner's backend, then sends `HostSaveAck`.
- Guests only receive a `/share/:shareId#key=...` link. The guest secret is in
  the URL fragment and is not sent in HTTP request URLs.

## Findings and Recommended Fixes

### 1. Critical: Share Authorization Can Be Bypassed Through Legacy Room WebSocket

Relevant code:

- `apps/collab-editor/src/worker.ts`: routes `/api/doc/:roomId/ws` to
  `env.COLLAB_ROOMS.getByName(roomId)`.
- `apps/collab-editor/src/worker.ts`: creates share Durable Objects with
  `getByName(body.shareId)`.
- `apps/collab-editor/src/worker.ts`: sends a snapshot immediately on the
  legacy room WebSocket path.
- `apps/collab-editor/src/worker.ts`: `ensureSocketShareAuthorization()` returns
  `true` for sockets without a share role.

Impact:

Anyone who knows the `shareId` can connect to `/api/doc/<shareId>/ws`, bypass
the guest secret and session token, receive the document snapshot, and write
updates. Because `shareId` is visible in the share URL path, rotating or
revoking the guest link does not fully remove access.

Recommended fix:

- Treat any Durable Object with a `shareRecord` as share-only.
- Reject legacy `/api/doc/:roomId/ws` connections when the target DO has a
  `shareRecord`.
- Do not include untagged legacy sockets in `shareSockets()`.
- In share rooms, close sockets with no serialized share role.
- Add Worker/DO route-level tests:
  - Create a share.
  - Attempt `/api/doc/<shareId>/ws`.
  - Assert the connection is rejected or immediately closed.
  - Rotate and revoke the share, then assert old session sockets are closed and
    the legacy route still cannot access the room.

Most maintainable implementation:

- Split handlers by route intent:
  - `handleLegacyRoomWebSocket()`
  - `handleShareWebSocket()`
  - `handleShareControlRequest()`
- Add a small guard at the top of the legacy handler:

```ts
if (this.shareRecord) return new Response("Share session required", { status: 403 });
```

- Keep all share authorization checks in one helper that fails closed:

```ts
private ensureShareSocketAuthorization(socket: WebSocket) {
  let attachment = socket.deserializeAttachment() as ConnectionAttachment | undefined;
  if (!attachment?.role || !attachment.secretHash) return false;
  // Compare against current host or guest hash.
}
```

### 2. High: Public Share Creation Has No Abuse or Resource Limits

Relevant code:

- `apps/collab-editor/src/worker.ts`: public `POST /api/shares`.
- `apps/collab-editor/src/share.ts`: validates that `snapshot` is a string, but
  not its decoded byte length.
- `apps/collab-editor/src/worker.ts`: reads JSON, decodes base64, imports Loro
  data, and persists it without quota checks.

Impact:

An unauthenticated caller can create many Durable Objects or send very large
snapshots. This can consume Worker CPU, memory, Durable Object storage, and
request budget.

Recommended fix:

- Add request body and decoded snapshot limits.
- Add maximum display name length, already present, plus maximum share lifetime.
- Add per-IP or per-origin rate limiting if available in the deployment
  environment.
- Add per-share session count and storage cleanup limits.
- Return structured 413/429 errors for oversized or rate-limited requests.

Most maintainable implementation:

- Add one shared limits module in `apps/collab-editor/src/share-limits.ts`.
- Use the same constants in parsing, Worker request handling, and tests.
- Validate size before base64 decode when possible:

```ts
const maxCreateShareBodyBytes = 2 * 1024 * 1024;
const maxSnapshotBytes = 1 * 1024 * 1024;
const maxShareSessions = 64;
const maxShareTtlMs = 30 * 24 * 60 * 60 * 1000;
```

### 3. Medium: Session Token Is Passed in the WebSocket URL Query

Relevant code:

- `apps/local-md-workspace/src/lib/collaboration/share-relay-client.ts` builds
  `...?clientId=...&sessionToken=...`.
- `apps/collab-editor/src/worker.ts` reads `sessionToken` from URL search
  params.

Impact:

The session token is a bearer credential with a 12 hour TTL. Query tokens are
more likely to appear in logs, proxies, browser tooling, traces, and error
reports.

Recommended fix:

- Prefer WebSocket subprotocol authentication or first-frame authentication.
- If using first-frame authentication, accept the socket only into a pending
  state, require an auth message before sending any snapshot, and close if auth
  fails or times out.
- Shorten token TTL or make tokens one-time-use after WebSocket join.

Most maintainable implementation:

- Add `WireKind.Auth` or a string control message:

```json
{ "type": "auth", "sessionToken": "...", "clientId": "..." }
```

- Do not send `ShareStatus` or `Snapshot` until the auth message succeeds.
- Keep the current session endpoint. Only the WebSocket credential transport
  changes.

### 4. High: Relay WebSocket Input Has No Hard Limits

Relevant code:

- `apps/collab-editor/src/worker.ts`: decodes arbitrary binary frames.
- `apps/collab-editor/src/worker.ts`: imports each `Doc` or `Snapshot` payload
  into the room Loro document.
- `apps/collab-editor/src/worker.ts`: broadcasts accepted payloads to all peers.

Impact:

One client can send a large or frequent stream of frames that makes the Durable
Object spend CPU importing Loro data, allocate memory, persist large snapshots,
and fan out the same load to every peer.

Recommended fix:

- Reject frames above `maxFrameBytes`.
- Reject batches above `maxBatchMessages` or `maxBatchPayloadBytes`.
- Reject document payloads above `maxDocumentUpdateBytes`.
- Add a per-socket token bucket for update frames.
- Track approximate document snapshot size and close the room to writes when it
  exceeds a product limit.

Most maintainable implementation:

- Add a single `validateWireFrameLimits(frame, messages)` helper used by both
  relay and client protocol tests.
- Keep limits in constants with comments that explain product assumptions.
- Close with 1009 for oversized messages and 1008 for policy violations.

### 5. Medium: Fan-Out and Peer Count Are Unbounded

Relevant code:

- `broadcast()` loops over every socket in the room.
- `shareSocketCount()` scans all sockets to compute status.

Impact:

Broadcast cost is O(peer count). A large number of peers increases latency,
CPU, and memory pressure for every update.

Recommended fix:

- Add `maxSharePeers`.
- Reject new guest sessions or WebSocket joins once the room is full.
- Keep the host connection reserved so the owner can always reconnect.
- Rate-limit `ShareStatus` broadcasts. Do not broadcast status on every small
  event if many peers are connected.

Most maintainable implementation:

- Enforce limits during session creation and WebSocket join.
- Maintain simple in-memory counters for active host and guest sockets, with a
  fallback scan for recovery.

### 6. Medium: Full Snapshot Read/Write Amplification

Relevant code:

- New WebSocket connections receive `doc.export({ mode: "snapshot" })`.
- `flushSnapshot()` exports and writes a full snapshot for dirty documents.

Impact:

Large documents and frequent reconnects make snapshot export, network send, and
storage write cost proportional to full document size.

Recommended fix:

- Short term:
  - Add `maxSnapshotBytes`.
  - Export snapshots less frequently.
  - Prefer update logs for frequent persistence.
  - Compact to snapshot only after a time or byte threshold.
- Long term:
  - Add reconnect delta sync using Loro version vectors.

Best maintainable design:

- Add a sync handshake:
  - Client sends its known version vector or no version if it has none.
  - Server sends `Doc` update bytes from that version when possible.
  - Server falls back to `Snapshot` if the client has no usable version or the
    delta is too large.
- Loro supports this model with:

```ts
let update = doc.export({ mode: "update", from: clientVersionVector });
```

- Keep full snapshot as a compatibility and recovery path.

### 7. Medium: Client Offline Queue Can Grow Without Bound

Relevant code:

- `ShareRelayConnection.enqueueDocumentUpdate()` pushes every local update into
  an in-memory queue.
- `flushQueue()` sends all queued messages once the socket is ready.

Impact:

A long offline edit session or stuck connection can grow browser memory and
produce a very large reconnect frame.

Recommended fix:

- Track `queuedBytes` and message count.
- Set `maxQueuedBytes`, `maxQueuedMessages`, and `maxSingleUpdateBytes`.
- When the queue exceeds limits, stop queueing raw updates and enter a
  resync-required state.
- Merge queued updates whenever possible.

Best maintainable design:

- Record a base Loro version when the connection becomes unavailable.
- During offline editing, do not preserve every small update forever.
- On reconnect, export one merged update from the base version:

```ts
let merged = doc.export({ mode: "update", from: offlineBaseVersion });
```

- If the merged update is still too large, discard the queue and request a fresh
  snapshot or ask the user to reconnect.
- Keep hard byte limits even with merging. Merging reduces normal cost but does
  not replace safety limits.

### 8. Medium: Local Update Log Append Rewrites the Whole Log

Relevant code:

- `appendDocumentUpdates()` reads the existing `.updates.b64`, decodes it,
  appends new updates, re-encodes everything, and writes the full file.

Impact:

Local and Dropbox backends repeatedly rewrite the full update log. This creates
unnecessary I/O, worsens Dropbox sync costs, and increases conflict risk.

Recommended fix:

- Replace the single update log file with segmented update logs.
- Save each batch of pending updates as a new segment.
- Compact segments into a snapshot after a byte or count threshold.

Superseded design:

The previous workspace sidecar layout is no longer used:

```text
.livemd/docs/<docId>.snapshot.b64
.livemd/docs/<docId>.updates/
  000001.update.b64
  000002.update.b64
  000003.update.b64
```

Current open flow:

1. Ordinary Markdown open reads the selected `.md` only.
2. Explicit file sharing opens a browser-local Loro document.
3. Owner CRDT snapshots and pending updates live in browser IndexedDB.
4. Relay room snapshots/update logs live in Durable Object storage.
5. Dropbox/local folders receive only materialized Markdown writes.

Save flow:

1. Encode pending owner CRDT updates to browser IndexedDB.
2. Send live collaboration updates to the relay WebSocket.
3. Materialize the merged Markdown text back to the selected `.md`.
4. Send `HostSaveAck` after the owner storage write succeeds.

Migration:

- No backwards-compatible `.livemd` migration is required for the current
  product.

### 9. Test Coverage Gap: Missing Worker/DO Security and Limit Tests

Current tests cover pure parsing, client relay helpers, owner browser metadata,
and Worker route behavior. Continue extending security-critical WebSocket join
coverage as relay behavior grows.

Recommended tests:

- Legacy `/api/doc/<shareId>/ws` is rejected for share Durable Objects.
- Guest sessions require the current guest secret.
- Rotating a link closes old guest sockets and rejects old guest sessions.
- Revoking a share closes all share sockets and rejects new sessions.
- Oversized create-share bodies are rejected.
- Oversized WebSocket frames are rejected before `doc.import(...)`.
- Peer limit rejects extra guests but still allows host reconnect.
- Client offline queue enters resync-required state after byte limit.
- Segmented update logs restore in order and compact safely.

## Recommended Implementation Plan

### Phase 1: Release Blockers

1. Close the legacy room WebSocket bypass for share Durable Objects.
2. Add route-level tests for the bypass.
3. Add frame, snapshot, and create-share body limits.
4. Add basic peer and session limits.

### Phase 2: Safe Client Behavior

1. Add `queuedBytes` and queue count limits to `ShareRelayConnection`.
2. Add update merging from an offline base version.
3. Add UI state for resync-required or reconnect-required failures.

### Phase 3: Persistence Scalability

1. Replace single `.updates.b64` files with segmented update logs.
2. Add migration from the legacy update log.
3. Add compaction thresholds by segment count and total segment bytes.

### Phase 4: Reconnect Efficiency

1. Add a sync handshake with client version vectors.
2. Send Loro delta updates when possible.
3. Fall back to full snapshots only when needed.

## Validation From Review

Commands run during review:

```bash
vp install
vp check
vp test
vp run audit
```

Results:

- `vp install`: passed, no dependency changes.
- `vp check`: passed.
- `vp test`: passed, 50 test files and 309 tests.
- `vp run audit`: did not complete because
  `packages/language/dist/index.mjs` was missing. The audit script requires
  workspace build artifacts before it can finish.
