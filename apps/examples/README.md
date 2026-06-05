# examples

Side-by-side workbench for comparing the local Tree-sitter CodeMirror packages
with official CodeMirror/Lezer packages. This is the repository's allowed
Lezer-dependent app because its job is parity inspection.

## Stack and Boundaries

- Uses Vite+ with TypeScript compilation before production builds.
- Depends on both `@codemirror-treesitter/*` packages and official
  `@codemirror/*`, `@lezer/*`, and `codemirror` packages.
- May import official language-layer packages for comparison. Implementation
  packages under `packages/*` should not copy that dependency pattern unless
  explicitly allowed by their README and `tools/audit.mjs`.

## Source Layout

- `src/main.ts`: example catalog, editor pair creation, runtime inspection,
  benchmark mode, language loading, command/autocomplete/merge/LSP probes, and
  comparison rows.
- `src/style.css`: Gruvbox-oriented app layout and comparison styling.
- `vite.config.ts`: Vite+ config with workspace aliases.

## Local Commands

Run from the workspace root:

```bash
vp run examples#dev
vp run examples#build
vp run examples#preview
vp run audit
```

`vp run audit` checks that parser-relevant upstream examples are either present
in this app or explicitly classified as out of scope.
