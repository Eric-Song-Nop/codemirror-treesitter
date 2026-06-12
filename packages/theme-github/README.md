# @codemirror-treesitter/theme-github

GitHub Light editor theme for the CodeMirror Tree-sitter build. The package
uses the shared semantic theme helpers from `@codemirror-treesitter/theme` and
exports LiveMD-ready extensions for nested code fence highlighting.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/theme` for editor chrome and syntax tag
  mapping.
- Depends on `@codemirror-treesitter/live-md` only to export the optional
  LiveMD code fence highlighting extension.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally avoids `@codemirror/language` and `@lezer/highlight`.
- Exports only `.` and `./package.json` from the built package.

## Responsibilities

- Export the GitHub Light color palette.
- Export a `SemanticThemeSpec` for GitHub Light.
- Export editor theme, highlight style, and combined CodeMirror extensions.
- Export LiveMD-ready extensions that apply GitHub Light syntax highlighting to
  nested fenced code blocks.

## Public Entry

```ts
import {
  githubLight,
  githubLightColors,
  githubLightHighlightStyle,
  githubLightLiveMdExtensions,
} from "@codemirror-treesitter/theme-github";
```

The root entry point is `src/index.ts`.

## Source Layout

- `src/index.ts`: color palette, semantic theme spec, CodeMirror extensions,
  and LiveMD-ready extensions.
- `tests/theme.test.ts`: editor appearance, syntax highlighting, and LiveMD
  extension coverage.

## Relationship to Other Packages

This package depends on `@codemirror-treesitter/theme` instead of duplicating
the shared CodeMirror selector and syntax tag mapping. LiveMD remains
independent of concrete themes; this package simply composes
`liveMdCodeFenceHighlighting(...)` with the exported GitHub Light highlighter.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/theme-github#check
vp run @codemirror-treesitter/theme-github#test
```
