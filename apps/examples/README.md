# examples

Side-by-side comparison workbench for the local Tree-sitter implementation and
the official CodeMirror/Lezer packages. This app is intentionally allowed to
depend on upstream CodeMirror language-layer and Lezer packages so it can
compare behavior directly.

## Responsibilities

- Load matching local and upstream language supports for example documents.
- Compare syntax tree readiness, indentation, folding, bracket matching,
  bidi isolates, comments, completion, merge, LSP, and highlighting behavior.
- Show language-data coverage across shared, local-only, and upstream-only
  language names.
- Run browser micro-benchmarks for load, state creation, mount, parse, edit, and
  inspection timing.
- Exercise the local Gruvbox dark/light themes against upstream highlighting.

## Source Layout

- `src/main.ts`: all example definitions, runtime adapters, comparison rows,
  benchmark runner, language loading, and UI wiring.
- `src/style.css`: workbench layout, Gruvbox theme variables, editor frames,
  comparison panels, and benchmark console styling.
- `index.html`: Vite mount point.

## Dependency Boundary

This is the comparison app. It may import official `@codemirror/language`,
`@codemirror/language-data`, `@codemirror/autocomplete`,
`@codemirror/commands`, `@codemirror/merge`, `@codemirror/lsp-client`,
`@lezer/common`, and `@lezer/highlight`. Do not copy that allowance into
implementation packages.

## Commands

Run from the workspace root:

```bash
vp run examples#dev
vp run examples#build
vp run examples#preview
```

The build runs `tsc` before `vp build`.
