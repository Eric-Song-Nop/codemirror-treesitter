# live-md-loro-demo

Local two-peer collaboration demo for LiveMD and Loro. It runs entirely in the
browser and simulates transport behavior so collaboration can be exercised
without Cloudflare infrastructure.

## Stack and Boundaries

- Uses Vite+ through `vp dev`, `vp build`, and `vp preview`.
- Depends on `@codemirror-treesitter/live-md`,
  `@codemirror-treesitter/live-md-loro`, CodeMirror view, and `loro-crdt`.
- Uses `liveMdRawCssPlugin()` for LiveMD CSS imports.
- Demonstrates collaboration package behavior; persistent network transport
  belongs in `apps/collab-editor`.

## Source Layout

- `src/main.ts`: two peer documents, LiveMD web component setup, Loro
  collaboration extensions, undo/redo, presence, simulated latency, offline
  queueing, and snapshot resync.
- `src/style.css`: split-peer demo layout and status styling.
- `vite.config.ts`: Vite+ config with workspace aliases and LiveMD CSS support.

## Local Commands

Run from the workspace root:

```bash
vp run live-md-loro-demo#dev
vp run live-md-loro-demo#build
vp run live-md-loro-demo#preview
```

Use this app for quick manual checks of `packages/live-md-loro` before testing
the Worker-backed collaboration app.
