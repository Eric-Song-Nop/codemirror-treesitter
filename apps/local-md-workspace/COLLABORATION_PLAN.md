# Owner-Backed Single-File Collaboration Plan

This plan replaces the earlier workspace-sharing direction. `apps/local-md-workspace`
should not try to make a local folder or Dropbox mirror root discoverable by other
users. Collaboration should be scoped to one Markdown file selected by the
owner, and the owner's browser remains responsible for saving the collaborative
document back to the owner's local folder or Dropbox mirror.

## Product Goal

Allow an owner to share one Markdown file with another user through a link:

1. Owner opens a local folder or Dropbox mirror.
2. Owner selects one `.md` file.
3. Owner clicks `Share file`.
4. Guest opens the link and edits only that file.
5. The relay synchronizes the Loro document and presence.
6. The owner's client writes the merged Markdown back to the owner's storage.

The shared object is a file, not a workspace. Guests do not see the owner file
tree, do not choose a local folder, do not authorize Dropbox, and do not receive
the owner's Dropbox token.

Dropbox is a mirror, not a collaboration backend. Each user authorizes their
own Dropbox only for their own private copy and cross-device continuity. In a
shared-file session, the guest's Dropbox, if any, is irrelevant. If user A
shares a file with user B, both users edit the relay's Loro document for user
A's selected file, and user A's browser is the only actor that writes back to
user A's local folder or Dropbox mirror.

## New Targets

MVP targets:

- Replace the incorrect workspace-sharing branch behavior with owner-backed
  single-file sharing.
- Preserve local-first private editing for local folders and Dropbox mirrors.
- Add a guest-only shared-file route that has no workspace tree and no storage
  connection controls.
- Make the owner browser the persistence agent for the shared file.
- Keep Dropbox OAuth in the owner app. Do not bypass OAuth and do not introduce
  raw Dropbox tokens as product configuration.
- Use random share capabilities that are independent of file paths, backend IDs,
  Dropbox mirror roots, or user identity.
- Make save status honest: relay acceptance is not the same thing as the owner
  file being saved.

Post-MVP targets:

- Active peer and pending-host-save UI.
- Relay retention and cleanup jobs.
- Full owner reconnect conflict UI when both relay edits and external source
  edits exist.
- Optional read-only links and named collaborators.
- Optional end-to-end encryption if relay plaintext visibility becomes
  unacceptable.

## Current Implementation Status

Implemented on this branch:

- Removed the incorrect automatic workspace relay behavior from
  `local-md-workspace`.
- Kept private workspace editing as plain Markdown reads/writes. Opening,
  saving, creating, renaming, and deleting ordinary files no longer creates
  Loro sidecars in the owner's local folder or Dropbox mirror.
- Added owner-side `Share file` link creation for one selected Markdown file.
- Created relay shares with random `shareId`, hashed guest/host secrets, and an
  initial Loro snapshot.
- Added Durable Object share endpoints for create, session, rotate, revoke, and
  authenticated WebSocket join.
- Added a guest-only `/share/:shareId#key=...` editor route that does not render
  the workspace tree, local folder picker, or Dropbox controls.
- Added an MVP owner host agent for the currently open shared file. It connects
  with the host key, imports relay edits, materializes through the owner's
  local folder or Dropbox mirror, and emits `HostSaveAck` only after the owner
  write succeeds.
- Added owner share lifecycle controls for `Rotate link` and `Stop sharing`.
  Rotation keeps the same `shareId`, replaces the guest capability, and writes
  the new guest hash to both relay and browser owner metadata. Stop sharing
  revokes the relay share and marks the browser owner metadata revoked.
- Added reload-time owner share discovery for the selected file. If the host key
  still exists in browser storage, the owner app reconnects the host agent
  without exposing or restoring the old guest secret.
- Added guest-side capability revalidation. If a link is rotated or revoked,
  the old guest page detects that the fragment key no longer works and stops
  treating the session as valid.
- Added version-vector based shared-file catch-up. Guests and hosts exchange
  Loro version vectors on connect/reconnect, and guest save UI distinguishes
  `Waiting for host` from `Saved to host` using the version vector included in
  `HostSaveAck`.
- Added relay share-status metadata for active peers, guest count, and pending
  host saves. The owner `Share file` modal now shows peers online, guests
  online, and whether relay edits are still waiting for the owner host to write
  them back.
- Added relay maintenance alarms. Share expiration now triggers active guest
  socket revalidation, and expired or stopped shares are retained for 7 days
  before the relay deletes the share metadata, Loro snapshot, pending-host-save
  flag, and short-lived session records.
- Added owner conflict UI for host saves. If relay/shared edits need to be
  materialized while the source `.md` also changed outside LiveMD, auto-save
  pauses before overwriting anything. The owner can keep the source and save
  shared edits as a conflict copy, use the shared edit to overwrite the source,
  or resolve later.
- Verified the relay with a local Worker smoke covering create-share, guest
  session, guest WebSocket edit, host session, and latest-snapshot replay.
- Verified `HostSaveAck` authorization and guest UI display with local relay and
  browser smoke tests.
- Verified rotate/revoke semantics with local relay tests: old guest secrets
  fail after rotation, new guest secrets work after rotation, and revoked shares
  reject new sessions.
- Verified guest save-state UI with local relay and browser smoke: after a guest
  edit while the host is offline, the page showed `Waiting for host`.
- Verified active-peer and pending-host-save share status with a local relay
  WebSocket smoke: guest join updated peer counts, guest edit set
  `pendingHostSave`, and host acknowledgement cleared it.
- Verified expiration maintenance with a local relay WebSocket smoke: after a
  short-lived share expired, the guest socket was closed by the relay and new
  guest session creation returned 404.
- Extended the product UI smoke so local-folder sharing is exercised end to
  end: owner creates a share link from the workspace UI, a guest opens the
  `/share/:shareId#key=...` route in an isolated browser context, the guest
  edits, the owner host saves back to the local folder backend, and the guest
  sees `Saved to host`.
- Added and verified a local-folder owner reconnect product UI smoke. It
  creates a share, closes the owner tab, lets an isolated guest edit while the
  host is offline, verifies the guest reaches `Waiting for host`, opens a new
  owner tab, selects the shared file, and waits for the owner host to save the
  relay edit back to the local folder.
- Added and verified a shared-file lifecycle product UI smoke. It rotates the
  active link, verifies the old guest link can no longer join, verifies the new
  guest link can join the same file, stops sharing from the owner UI, and
  verifies the active guest is told that sharing stopped.
- Added and verified an owner external-edit conflict product UI smoke. It lets
  a guest edit while the owner is offline, simulates an external source-file
  edit before owner reconnect, verifies the owner sees the shared-file conflict
  UI and the guest does not see `Saved to host`, then resolves with
  `Save shared copy` and verifies the source file stays external while the
  shared relay edit is written to a conflict copy.
- Extended the real Dropbox mirror UI smoke to run the same shared-file flow
  after Dropbox connection and file creation when
  `LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN` or `OPENDAL_DROPBOX_ACCESS_TOKEN`
  is present.
- Added and verified a credential-free mock Dropbox mirror product UI smoke.
  The app still enters through `Connect Dropbox mirror` and browser OAuth, then
  uses the Dropbox workspace backend against an in-browser OpenDAL operator
  fixture to create a file, create a share link, accept an isolated guest edit,
  save back through the owner host, and show `Saved to host`.

Not verified in this environment:

- Real Dropbox mirror shared-file UI smoke, because no Dropbox access token was
  present in the environment. Both the real credential-gated smoke path and the
  credential-free mock Dropbox mirror smoke path are wired; the real path will
  run when `LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN` or
  `OPENDAL_DROPBOX_ACCESS_TOKEN` is set.

## Non-Goals

- Do not share an entire workspace or file tree.
- Do not require guests to have the same local folder or Dropbox mirror root.
- Do not use Dropbox as the real-time collaboration transport.
- Do not let the relay access the owner's local file system or Dropbox token.
- Do not expose Loro, CRDTs, room IDs, or runtime storage internals in normal
  user-facing copy.
- Do not imply that guest edits are saved to the owner's file until the owner
  client has acknowledged materialization.

## True Collaboration Semantics

### Roles

Owner:

- Owns the source Markdown file.
- Has access to the storage that can save the file: File System Access or the
  owner's Dropbox mirror.
- Creates, rotates, and stops the share.
- Materializes the Loro document back to the source `.md`.
- May go offline; the relay can buffer updates, but the owner's file is not
  updated until the owner reconnects.

Guest:

- Joins through a share link.
- Edits only the shared file.
- Sends and receives Loro updates through the relay.
- Has no access to the owner's file tree, local folder handle, Dropbox token, or
  browser-local owner metadata.
- Sees save status relative to the host, not relative to Dropbox or local disk.

Relay:

- Authenticates share links and WebSocket sessions.
- Stores and relays the shared file's Loro snapshot/update stream.
- Stores presence and lightweight share metadata.
- Does not read or write Dropbox/local files.
- Does not decide how the owner resolves external file edits or materialization
  conflicts.

### Save Semantics

Use distinct status language:

- `Connected`: the guest is connected to the relay.
- `Saved to host`: the owner client has materialized the Loro text to the
  owner's local folder or Dropbox mirror and sent a `HostSaveAck` whose Loro
  version vector covers the guest's latest local edit.
- `Waiting for host`: the guest has local edits not yet covered by a host save
  acknowledgement.
- `Host offline`: guests may continue editing only if the share policy allows
  relay-buffered edits.

For MVP, allow relay-buffered edits while the owner is offline, but the UI must
not claim that those edits have reached the owner's file. The owner client must
sync, merge, and save them on reconnect.

### Storage Semantics

The source `.md` remains readable and writable by normal tools. Local folders
and Dropbox mirrors store Markdown content only; they are not CRDT stores and
must not receive high-frequency collaboration logs.

```text
owner browser IndexedDB:
  documents[docId] -> Loro snapshot + materialization metadata
  updates[docId, sequence] -> pending local Loro updates

owner browser localStorage:
  share-record:<shareId> -> non-secret owner share metadata
  share-host-secret:<shareId> -> host capability for this browser only

relay Durable Object storage:
  share record
  latest Loro snapshot
  bounded update log
  short-lived authenticated sessions
```

`localFileId` is an owner-local stable identity for the selected file. It is not
a relay room ID and is not sufficient to join a share.

`shareId` is a public locator for the relay room. The edit capability is a
separate secret in the URL fragment.

## UX

### Owner: Private Editing

Initial local workspace behavior stays familiar:

1. User opens a folder or connects a Dropbox mirror.
2. User selects a Markdown file.
3. The file opens in the LiveMD editor.
4. The app saves to the selected storage target as today.

Status examples:

- `Private`
- `Saving to local folder`
- `Saving to Dropbox mirror`
- `Offline changes pending`

No remote relay connection is opened in private mode.

### Owner: Share File

Add a `Share file` button near the current file actions. It is enabled only when
a Markdown file is selected and the current file has no unresolved conflict.

`Share file` modal:

- File name and path, for owner context only.
- Permission: `Anyone with this link can edit` for MVP.
- Expiration selector:
  - `24 hours`
  - `7 days` default
  - `30 days`
  - `Never` behind a warning or advanced section
- `Create link`

After creation:

- Show the link with a copy action.
- Show `Shared file` status.
- Show `Peers online`.
- Show `Saved to host` / `Waiting for host`.
- Actions:
  - `Copy link`
  - `Rotate link`
  - `Stop sharing`

The owner remains in the normal workspace UI. The sidebar is still visible to
the owner because the owner is working in their own workspace, but only the
selected file is shared.

### Guest: Join Shared File

Guest link opens a file-only collaborative editor, not the workspace app shell.

Guest screen:

- File title.
- Editor.
- Connection/save status.
- Peer count.
- Optional small label: `Shared by host`.

Do not show:

- Workspace sidebar.
- `Open folder`.
- `Connect Dropbox mirror`.
- Owner path details unless intentionally included in the share metadata.
- Dropbox-specific controls.

Guest status examples:

- `Connected`
- `Waiting for host`
- `Host online`
- `Host offline`
- `Link expired`
- `Sharing stopped`

### Owner Reconnect

If guests edit while the owner is offline:

1. Owner reopens the workspace or shared file.
2. App reconnects using owner share metadata.
3. App imports relay snapshot/updates into the owner Loro doc.
4. App checks for external edits to the source `.md`.
5. If safe, app materializes to the source file.
6. App sends `host-save-ack` to the relay.

If the source `.md` changed externally while the owner was offline, show a
conflict UI before overwriting anything.

## Share Identity And Expiration

Do not derive share identity from file path, `docId`, storage/backend ID, folder
name, Dropbox mirror root, user name, or timestamp.

Generate identities with `crypto.getRandomValues`:

```ts
shareId = base64url(randomBytes(16)); // 128-bit public locator, 22 chars
guestSecret = base64url(randomBytes(32)); // 256-bit edit capability, 43 chars
hostSecret = base64url(randomBytes(32)); // 256-bit owner capability, 43 chars
```

Suggested link shape:

```text
https://app.example.com/share/<shareId>#key=<guestSecret>
```

Rules:

- `shareId` may appear in route paths, logs, and Durable Object names.
- `guestSecret` stays in the URL fragment so it is not sent as part of normal
  HTTP requests.
- The relay stores only `hash(guestSecret)` and `hash(hostSecret)`, not the raw
  secrets.
- The guest exchanges `guestSecret` for a short-lived session token.
- The owner uses `hostSecret` for owner-only actions and host save
  acknowledgements.

Default expiration:

- Share links expire after 7 days.
- Owner can choose 24 hours, 7 days, 30 days, or never.
- `Stop sharing` revokes the share immediately.
- `Rotate link` invalidates the old guest secret and creates a new link.
- WebSocket session tokens should be short-lived, for example 12-24 hours, and
  should stop working after share revocation.

Relay retention:

- Keep relay snapshots while a share is active.
- After expiration or `Stop sharing`, retain the snapshot for a short recovery
  window of 7 days, then delete it.
- Retention policy must be visible in docs, because guest edits may exist only
  in the relay until the owner reconnects.

## Architecture

### Client Surfaces

Owner workspace route:

- Existing `apps/local-md-workspace` shell.
- Adds file-level share controls.
- Hosts the persistence agent for the selected shared file.

Guest share route:

- New file-only route, for example `/share/:shareId`.
- Reads `#key=...` from the fragment.
- Creates a relay session.
- Opens a LiveMD editor bound to the shared Loro document.

### Client Runtime

Per shared file:

```ts
type SharedFileSession = {
  role: "owner" | "guest";
  shareId: string;
  clientId: string;
  doc: LoroDoc;
  undoManager: UndoManager;
  connection: RelayConnection;
};
```

Owner-only state:

```ts
type OwnerSharedFileState = {
  localFileId: string;
  path: string;
  storageKind: "local-folder" | "dropbox-mirror";
  materializedHash: string;
  hostSecretRef: string;
  lastHostSavedVersion?: string;
};
```

Guest state is intentionally smaller:

```ts
type GuestSharedFileState = {
  shareId: string;
  sessionToken: string;
  displayName: string;
};
```

### Relay Worker

The dedicated `apps/grove-relay` Durable Object design is derived from the
existing `apps/collab-editor` transport, but Grove owns a separate Worker app:

- One room ID in the URL.
- One `LoroDoc` in a Durable Object.
- WebSocket update relay.
- Snapshot persistence.
- Local client snapshot for reconnect.

For single-file sharing, extend that pattern with role/session metadata.

Endpoints:

```text
POST /api/shares
POST /api/shares/:shareId/session
POST /api/shares/:shareId/rotate
POST /api/shares/:shareId/revoke
GET  /api/shares/:shareId/ws
```

Durable Object storage:

```ts
type ShareRecord = {
  createdAt: number;
  displayName: string;
  expiresAt: number | null;
  guestSecretHash: string;
  hostSecretHash: string;
  revokedAt?: number;
  schemaVersion: 1;
  shareId: string;
};
```

The room stores:

- Loro snapshot.
- Updated timestamp.
- Share metadata.
- Active socket attachments with role and client ID.
- Last host save acknowledgement.

Wire messages use the Grove relay frame format derived from the original
`apps/collab-editor` frame format:

```ts
const WireKind = {
  Doc: 1,
  Presence: 2,
  Snapshot: 3,
  HostSaveAck: 4,
  ShareStatus: 5,
  Batch: 9,
};
```

### Host Save Ack

The owner client sends `HostSaveAck` only after:

1. It has imported the relay state.
2. It has persisted browser-local collaboration state.
3. It has written the materialized Markdown to the owner's local folder or
   Dropbox mirror.
4. It has updated the local materialized hash.
5. It includes the Loro version vector that was saved.

Guests use this message to distinguish `Waiting for host` from `Saved to host`.

## Delete Existing Incorrect Behavior

The current branch contains useful local-first pieces and incorrect
workspace-sharing pieces. Do not merge the current remote-collaboration behavior
as-is.

### Delete Or Disable Incorrect Pieces

Remove or disable:

- Workspace-level remote relay derived from `backend.kind/backend.id`.
- `collabRelayRoomId(backend, "workspace")` and
  `collabRelayRoomId(backend, "doc:<docId>")` as product behavior.
- Automatic remote sync controlled only by `VITE_LOCAL_MD_RELAY_ORIGIN`.
- Workspace manifest relay between peers.
- UI copy that implies the whole workspace is shared or online-collaborative.
- Any manual test instructions requiring guests to open the same folder or same
  Dropbox mirror root.

Files likely affected by cleanup:

- `apps/local-md-workspace/src/lib/collaboration/document-sync.ts`
- `apps/local-md-workspace/src/App.tsx`
- `apps/local-md-workspace/COLLABORATION_PLAN.md`

Low-level relay smoke tests can exist only if scoped to transport. They must not
be presented as proof of product-level file sharing.

### Keep Or Reuse

Keep, after review:

- LiveMD + Loro editor binding.
- Per-file Loro document runtime.
- Owner-side browser IndexedDB snapshots/update logs.
- Owner-side materialization back to `.md`.
- External edit detection with conflict copy.
- Tests for browser CRDT persistence, materialization, and external edit
  conflicts.

Reconsider:

- Workspace manifest. Removed for the current architecture; deterministic
  browser-local document identity is sufficient for owner runtime state, and
  relay share identity is independent of paths.

## Build The Correct Implementation

### Phase 0: Safety Cleanup

Goal: remove misleading behavior before building the new model.

- Disable current remote relay activation in `local-md-workspace`.
- Remove workspace relay connection setup from `App.tsx`.
- Remove peer count/status from private workspace mode unless an explicit file
  share is active.
- Update tests that assumed `backend.id`-derived remote rooms.
- Keep per-file Loro behavior behind explicit file sharing.
- Ensure `vp check --fix` and `vp test` pass.

Acceptance:

- Opening a workspace never connects to a remote collaboration relay by default.
- No UI suggests workspace sharing exists.
- Existing local-folder and Dropbox-mirror editing still works.

### Phase 1: Owner-Side File Collaboration Runtime

Goal: make one selected file a Loro-backed owner document with reliable local
recovery.

- Define an owner-local `localFileId` mapping for selected files.
- Persist per-file snapshots/update logs in browser IndexedDB.
- Materialize Loro text back to the selected `.md`.
- Keep the current debounced save behavior, but make CRDT persistence happen
  before materialization.
- Detect external `.md` edits before host materialization.

Acceptance:

- Reloading the owner browser restores active shared-file runtime state from
  browser storage.
- Editing through another tool creates safe import or conflict copy.
- Dropbox writes only materialized Markdown files.

### Phase 2: Share Link Creation

Goal: allow the owner to create a secure single-file share.

- Add `Share file` button and modal.
- Generate `shareId`, `guestSecret`, and `hostSecret` with Web Crypto.
- Create the relay share with initial Loro snapshot and display metadata.
- Store owner share metadata locally.
- Copy link in `/share/<shareId>#key=<guestSecret>` form.
- Add `Stop sharing` and `Rotate link` UI skeletons.

Acceptance:

- Link creation does not expose Dropbox tokens or local file handles.
- Owner can reload and still manage the share.
- Expiration is stored and shown.

### Phase 3: Relay Share Room

Goal: implement the server authority for one shared file.

- Add share endpoints and Durable Object routing.
- Store only hashes of guest/host secrets.
- Issue short-lived session tokens.
- Validate every WebSocket connection.
- Persist Loro snapshots in the Durable Object.
- Broadcast Doc, Snapshot, Presence, ShareStatus, and HostSaveAck messages.
- Support revocation and expiration.

Acceptance:

- Invalid or expired links cannot connect.
- Guests cannot call owner-only actions.
- Revoked shares close active guest sockets.
- Relay survives reconnect and returns latest snapshot.

### Phase 4: Guest File-Only Editor

Goal: let invited users edit without opening a workspace.

- Add `/share/:shareId` route or equivalent route handling.
- Read `guestSecret` from the URL fragment.
- Exchange for a session token.
- Bind LiveMD to the relay Loro doc.
- Show guest-oriented status and errors.
- Do not render workspace sidebar or backend connection controls.

Acceptance:

- Guest can edit the shared file without a local folder or Dropbox auth.
- Guest sees `Waiting for host`, `Saved to host`, and connection state.
- Guest cannot browse or infer the owner workspace.

### Phase 5: Owner Host Agent

Goal: owner client becomes the persistence agent for the shared file.

- When the owner has a shared file open, connect as host.
- Import remote Loro updates.
- Persist browser-local collaboration state.
- Materialize to the owner's local folder or Dropbox mirror.
- Send `HostSaveAck` after successful materialization.
- If the owner is not viewing the file, decide whether to connect a background
  host agent for active shares.

MVP recommendation:

- Only host active shares while the owner workspace app is open.
- If the owner app is closed, relay buffers guest edits and shows guests
  `Waiting for host`.

Acceptance:

- Guest edits appear in owner editor.
- Owner save writes to the owner's local folder or Dropbox mirror.
- Guest sees `Saved to host` only after owner materialization succeeds.

### Phase 6: Share Management

Goal: make link lifecycle safe and understandable.

- Implement `Stop sharing`.
- Implement `Rotate link`.
- Show expiration and active peers.
- Show host online/offline state.
- Add local cleanup for stopped/expired shares.
- Add relay cleanup for expired shares after retention.

Acceptance:

- Old links fail after rotate.
- Stopped shares reject reconnects.
- Owner can see whether unsaved relay edits exist before stopping a share.

### Phase 7: Offline And Conflict Handling

Goal: make offline behavior explicit and safe.

- Allow guest edits to remain in the relay while host is offline.
- On owner reconnect, import relay state before materializing.
- Detect external source-file changes since last host save.
- If conflict exists, show owner conflict UI:
  - keep source file and create shared-edit conflict copy
  - accept shared edit and overwrite source
  - manually resolve later
- Never silently drop relay edits.

Acceptance:

- Host offline edits are not called saved-to-host.
- Host reconnect handles external edits without overwriting silently.
- Conflict files are named predictably.

### Phase 8: Validation And Smoke Tests

Automated tests:

- `shareId` and secrets are high-entropy and non-derived.
- Expired/revoked shares fail session creation.
- Guest cannot perform host actions.
- WebSocket import/export converges between owner and guest.
- HostSaveAck is sent only after materialization.
- Dropbox writes only the materialized Markdown file.
- External edit conflict flow preserves both versions.

Manual smoke:

```bash
VITE_DROPBOX_APP_KEY=smoke-dropbox-app vp run local-md-workspace#dev
```

`local-md-workspace#dev` starts the local `apps/grove-relay` shared-file relay at
`http://127.0.0.1:8787` and injects that origin into the frontend. Use
`vp run local-md-workspace#dev -- --relay-origin <deployed relay origin>` when
intentionally testing against a deployed relay instead of the local Worker.

Scenarios:

- Owner local folder -> guest link in separate browser profile.
- Owner Dropbox mirror -> guest link without Dropbox auth.
- Owner closes app, guest edits, owner reopens and saves.
- Rotate link, verify old link fails.
- Stop sharing, verify active guest is disconnected.
- Owner source file externally edited while guest has pending relay edits.

## Security Checklist

- Store only hashed secrets in the relay.
- Keep guest capability in URL fragment, not query string.
- Do not place Dropbox access tokens in share links, relay messages, local
  share metadata, or Durable Object storage.
- Require host capability for stop/rotate/host-save-ack.
- Make `shareId` random and non-semantic.
- Expire and revoke session tokens.
- Delete relay share metadata, Loro snapshots, pending-host-save flags, and
  short-lived session records after the post-expiration/revocation retention
  window.
- Avoid logging raw fragments or secrets.
- Treat relay plaintext visibility as a product/security decision. If
  end-to-end encryption is required later, redesign the relay to store opaque
  encrypted updates instead of importing Loro snapshots.
- Prevent guests from learning owner file paths unless the owner deliberately
  shares that display name.

## Open Decisions

- Whether guest edits are allowed when the host is offline, or only buffered
  after an explicit owner setting.
- Whether host agents should run for active shares even when the owner is
  viewing a different file.
- Whether host agents should support a more explicit multi-device handoff model.
- Whether to later add read-only links and named collaborators.
