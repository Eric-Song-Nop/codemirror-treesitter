# collab-editor

Cloudflare-backed collaborative LiveMD editor. The client binds LiveMD to a
Loro document, and the Worker routes room WebSockets to a Durable Object that
persists snapshots and relays document updates.

## Stack and Boundaries

- Uses Vite+ and `@cloudflare/vite-plugin` for local development and builds.
- Uses Cloudflare Workers, Durable Objects, WebSockets, Wrangler, `loro-crdt`,
  and `@codemirror-treesitter/live-md-loro`.
- Cloudflare-specific code stays in this app. Shared editor and collaboration
  behavior belongs in `packages/live-md` or `packages/live-md-loro`.
- `wrangler.jsonc` is used for Vite/Cloudflare local development, while
  `wrangler.worker.jsonc` points Wrangler deploys at the built Worker output.

## Source Layout

- `src/main.ts`: browser client, room selection, local snapshot recovery,
  WebSocket reconnect/heartbeat handling, and LiveMD/Loro binding.
- `src/worker.ts`: Cloudflare Worker entry and Durable Object export.
- `src/room.ts`: Durable Object room state, snapshot persistence, and WebSocket
  fanout.
- `src/protocol.ts`: binary wire-frame encoding for Loro document and snapshot
  messages.
- `src/initial-document.ts`: default room document helpers.
- `src/*.test.ts`: room and initial-document coverage.
- `wrangler.jsonc` and `wrangler.worker.jsonc`: local and deploy Wrangler
  configuration.

## Local Commands

Run from the workspace root:

```bash
vp run collab-editor#dev
vp run collab-editor#build
vp run collab-editor#preview
vp run collab-editor#types
vp run collab-editor#deploy
```

`vp run collab-editor#types` regenerates Cloudflare binding types. Deployment
requires Wrangler authentication and an account with Durable Objects enabled.
