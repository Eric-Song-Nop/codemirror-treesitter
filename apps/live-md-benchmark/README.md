# live-md-benchmark

Browser benchmark harness for LiveMD. It registers the LiveMD custom element,
mounts hidden editor instances, runs scripted document operations, and reports
timing metrics in the page and on `window.__liveMdBenchmark`.

## Responsibilities

- Benchmark medium and large Markdown rendering with viewport scrolling.
- Benchmark prose typing, Markdown-structure edits, character deletes, block
  deletes, copy/paste flows, cursor movement, range selection, and multiple
  cursors.
- Wait for Tree-sitter syntax trees where relevant so measurements include the
  editor runtime path rather than only DOM mutation.
- Expose a programmatic API:
  `window.__liveMdBenchmark.run()` and `window.__liveMdBenchmark.last()`.
- Support automatic runs with `?benchmark=run` or `?benchmark=auto`.

## Source Layout

- `src/main.ts`: benchmark case definitions, hidden editor sessions, metric
  collection, result aggregation, panel UI, and global benchmark API.
- `src/style.css`: compact benchmark panel and hidden editor host styling.
- `index.html`: Vite mount point.

## Commands

Run from the workspace root:

```bash
vp run live-md-benchmark#dev
vp run live-md-benchmark#benchmark
vp run live-md-benchmark#build
vp run live-md-benchmark#preview
```

The `benchmark` task starts Vite on `127.0.0.1` and opens
`/?benchmark=run`.
