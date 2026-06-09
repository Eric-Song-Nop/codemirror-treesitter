# collab-editor

Cloudflare collaboration demo for LiveMD and Loro. The frontend mounts a
`<live-md-editor>` bound to a `LoroDoc`; the Worker routes WebSocket traffic
through a Durable Object that stores snapshots and bounded update logs.

## Responsibilities

- Create or join rooms from the URL hash, with generated room IDs when the hash
  is absent or invalid.
- Sync Loro document updates over `/api/doc/:roomId/ws`.
- Restore local snapshots from `localStorage` and resend them after the server
  sends its first snapshot.
- Persist room state in a Durable Object with debounced snapshot saves and an
  update log for recovery.
- Expose the same share create/session/rotate/revoke/WebSocket APIs used by the
  Grove relay so this app can remain a standalone Cloudflare collaboration demo.

## Source Layout

- `src/main.ts`: browser client, room selection, reconnect/backoff, heartbeat,
  local snapshot persistence, and LiveMD/Loro binding.
- `src/worker.ts`: Worker router and `CollabRoom` Durable Object.
- `src/room.ts`: hash room ID generation and validation helpers.
- `src/protocol.ts`: binary wire framing for document, presence, snapshot,
  host-save, status, and batch messages.
- `src/share.ts` and `src/share-limits.ts`: shared-file request validation,
  secrets, retention, rate, and payload limits.
- `src/initial-document.ts`: default room seeding helpers.
- `src/*.test.ts`: room, worker route, share, limit, and initial-document
  coverage.
- `wrangler.jsonc` / `wrangler.worker.jsonc`: Cloudflare build and deploy
  configuration.

## Configuration

The frontend can target a separate Worker by setting:

```env
VITE_COLLAB_WORKER_ORIGIN="https://your-worker.example"
```

When unset, the client uses `location.origin`, which is the normal local dev and
single-origin deploy path.

## Commands

Run from the workspace root:

```bash
vp run collab-editor#dev
vp run collab-editor#build
vp run collab-editor#preview
vp run collab-editor#types
vp run collab-editor#deploy:worker
vp run collab-editor#deploy:pages
```

Tests are included in the workspace test run:

```bash
vp test apps/collab-editor
```
