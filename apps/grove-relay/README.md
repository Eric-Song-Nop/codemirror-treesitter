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
- Reserve new-share storage through one dedicated, low-throughput
  `GroveCreateQuota` Durable Object before waking a share room.
- Enforce payload size, per-socket binary message/byte buckets, document update
  burst and per-minute limits, role-specific session, total/guest-peer, and
  sync-version-vector limits. Guest sessions cannot consume the host's reserved
  session capacity, and unused guest tokens are evicted instead of blocking new
  guests.
- Apply edge rate limits to share creation, session issuance, and WebSocket
  upgrades before waking a share Durable Object. Create requests use caller and
  aggregate keys; session and WebSocket requests use caller, per-share, and
  aggregate keys.

## Admission and Retention Budgets

The `GROVE_CREATE_QUOTA` binding points every create request at one global
Durable Object. Its transactional reservation is the exact storage-admission
budget: at most 100 distinct share ids and 64 MiB of decoded initial snapshots
per UTC day. A same-day retry with the same share id and decoded byte length is
idempotent and does not consume the budget twice. Conflicting reservations,
exhaustion, or quota RPC/storage failures fail closed before `GROVE_SHARE_ROOMS`
is accessed.

The exported retained-cost planning window is 37 days: the 30-day maximum share
lifetime plus the 7-day post-end retention period. The exact daily byte budget
therefore bounds initial snapshots admitted across that window to
`37 * 64 MiB = 2,368 MiB` (2.3125 GiB). Because an admitted share can later grow
to the 1 MiB snapshot limit, the separate hard snapshot-capacity envelope is
`37 * 100 * 1 MiB = 3,700 MiB` (about 3.61 GiB). These are cost-planning
envelopes, not a promise that storage is recovered at an exact age; Durable
Object alarms enforce the share lifecycle and cleanup schedule.

Cloudflare Rate Limit bindings are additional traffic smoothing. Their counters
are local to Cloudflare locations and may be eventually consistent, so they do
not replace the global Durable Object budget. `CREATE_SHARE_RATE_LIMITER`,
`SHARE_SESSION_RATE_LIMITER`, and `SHARE_WEBSOCKET_RATE_LIMITER` should still be
configured at every deployment edge.

## API Shape

- `POST /api/shares` (the only create entry point; `POST /api/shares/:shareId`
  returns 404 and never wakes a room or consumes quota)
- `POST /api/shares/:shareId/session`
- `POST /api/shares/:shareId/rotate`
- `POST /api/shares/:shareId/revoke`
- `GET /api/shares/:shareId/ws` with WebSocket upgrade

Share creation requires an `Idempotency-Key` equal to the share id and is
idempotent only for an exact replay with the same metadata, host/guest
capability hashes, and snapshot digest. This lets the workspace safely retry
when the relay committed a create but its response was lost without accepting
a different document under the same id.

- `GET /__debug` for local readiness checks used by
  `apps/local-md-workspace/scripts/dev.mjs`

## Origin Allowlist

`ALLOWED_ORIGINS` (a Wrangler var, blank by default) accepts comma-separated
origins such as `https://grovemd.net,http://localhost:5173`. When set, CORS
responses reflect only listed origins and WebSocket upgrades whose `Origin`
header is present but not listed are rejected with 403; upgrades without an
`Origin` header (non-browser clients) are allowed. When blank, any origin is
reflected. Set it in `wrangler.jsonc` and `wrangler.worker.ci.jsonc`: deploys
replace dashboard-set vars.

## Source Layout

- `src/worker.ts`: thin Worker entry. `GroveCreateQuota` and `GroveShareRoom`
  subclass `CreateQuota` and `ShareRoom` from `@codemirror-treesitter/relay-core`,
  and `fetch` delegates to its `handleRelayRequest`. The wire protocol, share
  validation, limits, Durable Object logic, and router live in
  `packages/relay-core`.
- `src/worker-*.test.ts`: Durable Object persistence, session, quota, and
  Worker route coverage (including create admission and `ALLOWED_ORIGINS`).
- `src/wrangler-config.test.ts`: keeps `wrangler.worker.ci.jsonc` in sync
  with `wrangler.jsonc`.
- `vite.config.ts`: Cloudflare Worker build config.
- `vitest.config.ts`: Worker unit-test config without the Cloudflare Vite
  plugin.
- `wrangler.jsonc`: the single source Wrangler config (dev, build, types). The
  Vite build writes the deployable `dist/grove_relay/wrangler.json` from it,
  which `deploy`/`deploy:worker` use.
- `wrangler.worker.ci.jsonc`: the CI deploy config used by
  `.github/workflows/local-md-workspace.yml`: the built Worker without the
  `relay.grovemd.net` custom-domain route. It must match `wrangler.jsonc`
  apart from `main` and `routes` (enforced by `wrangler-config.test.ts`).
  Wrangler does not inherit `durable_objects`, `ratelimits`, or `vars` into
  `env.*` blocks, so environments would duplicate every binding.

## Commands

Run from the workspace root:

```bash
vp run grove-relay#dev
vp run grove-relay#build
vp run grove-relay#test
vp run grove-relay#types
vp run grove-relay#deploy:worker
vp run grove-relay#deploy:dry-run
```

`local-md-workspace#dev` starts this relay automatically when
`VITE_LOCAL_MD_SHARE_RELAY_ORIGIN` or `--relay-origin` points at a local host.

WebSocket authentication records the session expiry on the connection. An
expired session receives a `session-refresh-required` control message and close
code `4001`; clients should request a new session through the session endpoint
before reconnecting. Reconnect metadata accepts up to 4096 version-vector
entries, with the control-message byte limit remaining the outer bound.
