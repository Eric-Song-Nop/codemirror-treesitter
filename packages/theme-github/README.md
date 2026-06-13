# @codemirror-treesitter/theme-github

GitHub Light editor theme for the CodeMirror Tree-sitter build. The package
uses the shared semantic theme helpers from `@codemirror-treesitter/theme` and
shared color values from `@codemirror-treesitter/theme-palettes`.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/theme` for editor chrome and syntax tag
  mapping.
- Depends on `@codemirror-treesitter/theme-palettes` for shared GitHub color
  values.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally avoids `@codemirror/language` and `@lezer/highlight`.
- Exports only `.` and `./package.json` from the built package.

## Responsibilities

- Export the GitHub Light color palette.
- Export a `SemanticThemeSpec` for GitHub Light.
- Export editor theme, highlight style, and combined CodeMirror extensions.

## Public Entry

```ts
import {
  githubLight,
  githubLightColors,
  githubLightHighlightStyle,
} from "@codemirror-treesitter/theme-github";
```

The root entry point is `src/index.ts`.

## Source Layout

- `src/index.ts`: color palette, semantic theme spec, and CodeMirror
  extensions.
- `tests/theme.test.ts`: editor appearance and syntax highlighting coverage.

## Relationship to Other Packages

This package depends on `@codemirror-treesitter/theme` instead of duplicating
the shared CodeMirror selector and syntax tag mapping. LiveMD remains
independent of concrete CodeMirror themes; its code fences reuse active syntax
highlighters. Use `@codemirror-treesitter/live-md-theme-github` for GitHub
Light LiveMD prose and widget presentation variables.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/theme-github#check
vp run @codemirror-treesitter/theme-github#test
```
