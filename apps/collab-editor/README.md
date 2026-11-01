# collab-editor

Cloudflare collaboration demo for LiveMD and Loro. The frontend mounts a
`<live-md-editor>` bound to a `LoroDoc`; the Worker runs the shared
`@codemirror-treesitter/relay-core` share room, the same Durable Object logic
as `apps/grove-relay`.

## Responsibilities

- Opening `/` without a valid link creates a room: the browser generates a
  share id plus host and guest secrets, seeds the initial document, and calls
  the rate-limited, quota-admitted `POST /api/shares`. The URL becomes
  `/#share=<id>&key=<guest secret>`; the host secret stays in `localStorage`.
- Anyone with the link gets a guest session (`POST /api/shares/:id/session`)
  and syncs over the authenticated `GET /api/shares/:id/ws` WebSocket.
- Restore local snapshots from `localStorage`; after `sync-ready` the client
  sends the relay whatever it lacks, then flushes merged updates at most twice
  a second to stay inside the per-socket update budget.
- Rooms expire after 7 days and alarms delete them after the relay-core
  retention period. Per-socket size and rate limits, session caps (with a
  reserved host allowance), fork-then-commit persistence, and oversized
  candidate rejection all come from `relay-core`.
- The old unauthenticated `/api/doc/:roomId/ws` rooms were removed and now
  return 404.

## Source Layout

- `src/main.ts`: browser entry, room creation/join, status line, local
  snapshot persistence, and LiveMD/Loro binding.
- `src/share-client.ts`: share create/session requests and the share-room
  WebSocket client (auth, catch-up, session refresh, reconnect, heartbeat).
- `src/share-link.ts`: share credential generation and `#share=…&key=…` links.
- `src/worker.ts`: thin Worker entry. `CollabRoom` and `CollabCreateQuota`
  subclass relay-core's `ShareRoom` and `CreateQuota`; `fetch` delegates to
  `handleRelayRequest`.
- `src/initial-document.ts`: default room content.
- `src/*.test.ts`: share-link, initial-document, Worker route, and Wrangler
  config coverage.
- `vite.config.ts`: Cloudflare frontend and Worker build config.
- `vitest.config.ts`: Worker unit-test config without the Cloudflare Vite
  plugin.

## Deploy Shapes

- `wrangler.jsonc`: single-origin shape used by `dev`, `build`, `preview`, and
  `types`. Static assets are served by the Worker, with `run_worker_first` for
  `/api/*`.
- `wrangler.worker.jsonc`: API-only shape used by `deploy`/`deploy:worker`. It
  is the same Worker and bindings but drops the `assets` block, so the
  frontend is deployed separately with `deploy:pages` and pointed at the
  Worker with `VITE_COLLAB_WORKER_ORIGIN`. `src/wrangler-config.test.ts`
  keeps the two in sync apart from `main` and `assets`.

Bindings: `COLLAB_ROOMS` (`CollabRoom`), `COLLAB_CREATE_QUOTA`
(`CollabCreateQuota`, migration `v2`), `CREATE_SHARE_RATE_LIMITER`,
`SHARE_SESSION_RATE_LIMITER`, `SHARE_WEBSOCKET_RATE_LIMITER` (their own
namespace ids, separate from grove-relay), and the `ALLOWED_ORIGINS` var.

## Configuration

The frontend can target a separate Worker by setting:

```env
VITE_COLLAB_WORKER_ORIGIN="https://your-worker.example"
```

When unset, the client uses `location.origin`, which is the normal local dev and
single-origin deploy path.

`ALLOWED_ORIGINS` (a Wrangler var, blank by default) accepts comma-separated
origins. When set, CORS reflects only listed origins and WebSocket upgrades
with a non-listed `Origin` are rejected with 403; requests without `Origin` are
allowed. For the API-only shape, include the Pages origin.

## Commands

Run from the workspace root:

```bash
vp run collab-editor#dev
vp run collab-editor#build
vp run collab-editor#test
vp run collab-editor#preview
vp run collab-editor#types
vp run collab-editor#deploy:worker
vp run collab-editor#deploy:pages
```

Tests are included in the workspace test run:

```bash
vp run -r test
```
