# @codemirror-treesitter/theme-catppuccin

Catppuccin editor themes for the CodeMirror Tree-sitter build. This package
exports Latte and Macchiato palettes, editor chrome extensions, syntax
highlight styles, combined CodeMirror extensions, and LiveMD-ready extensions.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/theme` for semantic editor and syntax
  helper mapping.
- Depends on `@codemirror-treesitter/language` for local syntax highlighting
  extension plumbing.
- Depends on `@codemirror-treesitter/live-md` only to export
  LiveMD-ready code fence highlighting extensions.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally avoids `@codemirror/language` and `@lezer/highlight`.
- Exports only `.` and `./package.json` from the built package.

## Responsibilities

- Export official Catppuccin Latte and Macchiato color palettes.
- Translate those palettes into `SemanticThemeSpec` values.
- Create editor chrome and highlight styles through
  `@codemirror-treesitter/theme`.
- Export combined CodeMirror extensions for direct editor use.
- Export LiveMD-ready extensions that apply the same theme and code fence
  highlighter.

## Public Entry

```ts
import {
  catppuccinLatte,
  catppuccinLatteLiveMdExtensions,
  catppuccinMacchiato,
  catppuccinMacchiatoHighlightStyle,
} from "@codemirror-treesitter/theme-catppuccin";
```

The root entry point is `src/index.ts`.

## Source Layout

- `src/index.ts`: color palettes, semantic specs, editor themes, highlight
  styles, combined extensions, and LiveMD-ready extensions.
- `tests/theme.test.ts`: editor appearance, syntax class, and LiveMD extension
  coverage.

## Relationship to Other Packages

This package relies on `@codemirror-treesitter/theme` for the shared semantic
CodeMirror selector and syntax tag mapping. It should not duplicate that
mapping locally. LiveMD integration is exported as convenience extension arrays
that include the matching CodeMirror theme plus
`liveMdCodeFenceHighlighting(...)` for nested code fences.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/theme-catppuccin#check
vp run @codemirror-treesitter/theme-catppuccin#test
```
