# grove-relay

Cloudflare Worker relay for Grove shared Markdown files. It hosts only the
shared-file control plane and WebSocket relay; the full local workspace UI lives
in `apps/local-md-workspace`.

## Responsibilities

- Create shares from host-provided Loro snapshots.
- Issue host or guest sessions after validating share secrets.
- Rotate guest secrets, revoke shares, expire shares, and clean up retained
  state through Durable Object alarms.
- Relay document, presence, snapshot, host-save acknowledgement, and share
  status messages over WebSockets.
- Persist snapshots, pending host-save state, and bounded update logs in a
  Durable Object.
- Enforce payload size, frame burst, per-minute update, role-specific session,
  guest-peer, and sync-version-vector limits. Guest sessions cannot consume the
  host's reserved session capacity.
- Apply edge rate limits to share creation, session issuance, and WebSocket
  upgrades before waking a share Durable Object. Each route has both a
  per-caller key and an aggregate create/per-share capacity key.

## API Shape

- `POST /api/shares`
- `POST /api/shares/:shareId/session`
- `POST /api/shares/:shareId/rotate`
- `POST /api/shares/:shareId/revoke`
- `GET /api/shares/:shareId/ws` with WebSocket upgrade

Share creation is idempotent for an exact replay with the same share id,
metadata, and host/guest capability hashes. This lets the workspace safely
retry when the relay committed a create but its response was lost.
- `GET /__debug` for local readiness checks used by
  `apps/local-md-workspace/scripts/dev.mjs`

## Source Layout

- `src/worker.ts`: Worker router and `GroveShareRoom` Durable Object.
- `src/protocol.ts`: binary wire framing for relay messages and batches.
- `src/share.ts`: share IDs, secrets, session records, request parsing,
  expiration, retention, and hashing helpers.
- `src/share-limits.ts`: request, snapshot, update, peer, session, and rate
  limits.
- `src/*.test.ts`: share validation, limits, and Worker route coverage.
- `vite.config.ts`: Cloudflare Worker build config.
- `vitest.config.ts`: Worker unit-test config without the Cloudflare Vite
  plugin.
- `wrangler.worker.jsonc`: deployment config.
- `wrangler.worker.ci.jsonc`: CI-oriented Wrangler config.

## Commands

Run from the workspace root:

```bash
vp run grove-relay#dev
vp run grove-relay#build
vp run grove-relay#test
vp run grove-relay#types
vp run grove-relay#deploy:worker
```

`local-md-workspace#dev` starts this relay automatically when
`VITE_LOCAL_MD_SHARE_RELAY_ORIGIN` or `--relay-origin` points at a local host.

WebSocket authentication records the session expiry on the connection. An
expired session receives a `session-refresh-required` control message and close
code `4001`; clients should request a new session through the session endpoint
before reconnecting. Reconnect metadata accepts up to 4096 version-vector
entries, with the control-message byte limit remaining the outer bound.
