# @codemirror-treesitter/theme-catppuccin

Catppuccin editor themes for the CodeMirror Tree-sitter build. This package
exports Latte and Macchiato palettes, editor chrome extensions, syntax
highlight styles, and combined CodeMirror extensions.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/theme` for semantic editor and syntax
  helper mapping.
- Depends on `@codemirror-treesitter/theme-palettes` for shared Catppuccin
  color values.
- Depends on `@codemirror-treesitter/language` for local syntax highlighting
  extension plumbing.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally avoids `@codemirror/language` and `@lezer/highlight`.
- Exports only `.` and `./package.json` from the built package.

## Responsibilities

- Export official Catppuccin Latte and Macchiato color palettes.
- Translate those palettes into `SemanticThemeSpec` values.
- Create editor chrome and highlight styles through
  `@codemirror-treesitter/theme`.
- Export combined CodeMirror extensions for direct editor use.

## Public Entry

```ts
import {
  catppuccinLatte,
  catppuccinMacchiato,
  catppuccinMacchiatoHighlightStyle,
} from "@codemirror-treesitter/theme-catppuccin";
```

The root entry point is `src/index.ts`.

## Source Layout

- `src/index.ts`: color palettes, semantic specs, editor themes, highlight
  styles, and combined extensions.
- `tests/theme.test.ts`: editor appearance and syntax class coverage.

## Relationship to Other Packages

This package relies on `@codemirror-treesitter/theme` for the shared semantic
CodeMirror selector and syntax tag mapping. It should not duplicate that
mapping locally. LiveMD remains independent of concrete CodeMirror themes; its
code fences reuse active syntax highlighters. Use
`@codemirror-treesitter/live-md-theme-catppuccin` for Catppuccin LiveMD prose
and widget presentation variables.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/theme-catppuccin#check
vp run @codemirror-treesitter/theme-catppuccin#test
```
