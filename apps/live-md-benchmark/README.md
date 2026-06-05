# live-md-benchmark

Browser benchmark harness for LiveMD. It exercises rendering, scrolling,
typing, Markdown-structure edits, deletion, clipboard-like operations, and
selection movement against generated Markdown documents.

## Stack and Boundaries

- Uses Vite+ with TypeScript compilation before production builds.
- Depends on `@codemirror-treesitter/live-md`, the local language package, and
  official CodeMirror state/view primitives.
- Uses `@codemirror-treesitter/live-md/fixtures` for reusable mixed Markdown
  content.
- Exposes `window.__liveMdBenchmark` so automation can trigger benchmark runs
  and read the latest result.

## Source Layout

- `src/main.ts`: benchmark cases, result aggregation, automated run API, and
  browser UI.
- `src/style.css`: benchmark dashboard styling.
- `vite.config.ts`: Vite+ config with workspace aliases and LiveMD CSS support.

## Local Commands

Run from the workspace root:

```bash
vp run live-md-benchmark#dev
vp run live-md-benchmark#benchmark
vp run live-md-benchmark#build
vp run live-md-benchmark#preview
```

`vp run live-md-benchmark#benchmark` starts the dev server on
`127.0.0.1` and opens `/?benchmark=run` so the browser run begins
automatically.
