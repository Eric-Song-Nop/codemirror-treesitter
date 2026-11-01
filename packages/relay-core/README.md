# @codemirror-treesitter/relay-core

Private workspace package with the Cloudflare relay core shared by
`apps/grove-relay` and `apps/collab-editor`. Both Workers subclass the same
Durable Objects and delegate routing to the same handler, so security and
persistence fixes land once.

## Responsibilities

- Binary wire framing for document, presence, snapshot, host-save
  acknowledgement, share-status, and batch messages (`protocol.ts`).
- Share ids, secrets, session records, request parsing, expiration, retention,
  and hashing helpers (`share.ts`).
- Request, snapshot, update, peer, session, create-quota, and per-socket rate
  limits (`share-limits.ts`).
- `ShareRoom` Durable Object: transactional share creation, host/guest
  sessions with a reserved host allowance, guest-session deletion on rotate,
  revoke, alarm-driven expiry and retention cleanup, fork-then-commit document
  imports (live state changes only after storage commits), candidate snapshot
  size checks, update-log compaction, and WebSocket relay (`room.ts`).
- `CreateQuota` Durable Object: one global, transactional, idempotent daily
  create budget (`room.ts`).
- `handleRelayRequest`: the Worker router (`router.ts`). It owns the only
  public create entry point, `POST /api/shares`, which is edge rate-limited and
  quota-reserved before a room wakes. `POST /api/shares/:id` returns 404, and
  rooms refuse creates that lack the router-only `X-Relay-Create-Admitted`
  header, which the router strips from every client request. Session and
  WebSocket routes are rate-limited per caller, per share, and in aggregate.
- CORS and Origin policy (`http.ts`): with an `ALLOWED_ORIGINS` value
  (comma-separated origins), only listed origins are reflected and WebSocket
  upgrades with a non-listed `Origin` are rejected with 403; requests without
  an `Origin` header are allowed. Blank or unset keeps reflect-any-origin.

## Public Entries

```ts
// Worker code (imports `cloudflare:workers`).
import { CreateQuota, ShareRoom, handleRelayRequest } from "@codemirror-treesitter/relay-core";

export class MyCreateQuota extends CreateQuota<Env> {}
export class MyShareRoom extends ShareRoom<Env> {}
export default {
  fetch: (request: Request, env: Env) =>
    handleRelayRequest(request, {
      allowedOrigins: env.ALLOWED_ORIGINS,
      createQuota: env.MY_CREATE_QUOTA,
      createRateLimiter: env.CREATE_SHARE_RATE_LIMITER,
      rooms: env.MY_SHARE_ROOMS,
      sessionRateLimiter: env.SHARE_SESSION_RATE_LIMITER,
      websocketRateLimiter: env.SHARE_WEBSOCKET_RATE_LIMITER,
    }),
};

// Browser-safe code (no Durable Object or `cloudflare:workers` imports).
import {
  WireKind,
  encodeWireBatch,
  hashShareSecret,
} from "@codemirror-treesitter/relay-core/client";
```

## Dependency Boundaries

- Only this package may import `cloudflare:workers`; browser bundles must use
  the `/client` entry.
- Depends on `loro-crdt`. Type-checks against `@cloudflare/workers-types`; the
  consuming Workers type-check it against their generated
  `worker-configuration.d.ts`.
- No app-specific bindings: Workers pass their own namespaces, rate limiters,
  and `ALLOWED_ORIGINS` value to `handleRelayRequest`.

## Source Layout

- `src/index.ts`: Worker entry (re-exports `client.ts`, Durable Objects,
  router, and Origin helpers).
- `src/client.ts`: browser-safe entry.
- `src/protocol.ts`, `src/share.ts`, `src/share-limits.ts`: shared protocol,
  validation, and limits.
- `src/room.ts`: `ShareRoom` and `CreateQuota` Durable Objects.
- `src/router.ts`: `handleRelayRequest`.
- `src/http.ts`: route parsing, JSON body limits, CORS/Origin helpers.
- `tests/`: share validation and limit coverage. Durable Object and router
  behavior is covered by `apps/grove-relay` and `apps/collab-editor` tests.

## Validation

```bash
vp run @codemirror-treesitter/relay-core#test
vp run @codemirror-treesitter/relay-core#build
vp run grove-relay#test
vp run collab-editor#test
```
