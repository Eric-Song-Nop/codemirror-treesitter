# live-md-loro-demo

In-browser two-peer collaboration lab for LiveMD and Loro. It does not use a
server; instead it simulates a network between two local Loro documents so the
collaboration package can be exercised without Cloudflare infrastructure.

## Responsibilities

- Mount two `<live-md-editor>` instances bound to separate `LoroDoc` objects.
- Sync document and presence updates through a controllable simulated transport.
- Support latency changes, disconnect/reconnect, queue flush, queue drop,
  snapshot resync, sample reload, split edits, reset, undo, and redo.
- Render peer stats and pending packet details for manual inspection.
- Style Loro cursors and selections with per-user classes.

## Source Layout

- `src/main.ts`: peer creation, LiveMD/Loro binding, simulated transport,
  control wiring, resync logic, metrics, and render loop.
- `src/style.css`: collaboration lab layout, controls, peer panels, queue
  display, and cursor/presence styling.
- `index.html`: Vite mount point.

## Commands

Run from the workspace root:

```bash
vp run live-md-loro-demo#dev
vp run live-md-loro-demo#build
vp run live-md-loro-demo#preview
```

Use the package tests in `@codemirror-treesitter/live-md-loro` for automated
collaboration binding coverage.
