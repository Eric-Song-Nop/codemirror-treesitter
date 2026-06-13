# @codemirror-treesitter/theme-gruvbox

Gruvbox editor themes for the CodeMirror Tree-sitter build. The package owns
the Gruvbox palettes and maps them into the shared semantic theme contract from
`@codemirror-treesitter/theme`.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/theme` for CodeMirror editor chrome and
  syntax mapping helpers.
- Depends on `@codemirror-treesitter/theme-palettes` for shared Gruvbox color
  values.
- Uses `@codemirror-treesitter/language` only to compose exported
  `HighlightStyle` instances into the compatibility `gruvboxDark` and
  `gruvboxLight` extensions.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally avoids `@codemirror/language` and `@lezer/highlight`.
- Exports only `.` and `./package.json` from the built package.

## Responsibilities

- Export dark and light Gruvbox color palettes.
- Export semantic dark and light theme specs.
- Export `EditorView.theme(...)` and `HighlightStyle` instances created through
  the shared semantic helper package.
- Export combined dark and light theme extensions that include both editor
  chrome and syntax highlighting.

## Public Entry

```ts
import {
  gruvboxDark,
  gruvboxDarkColors,
  gruvboxLight,
  gruvboxLightHighlightStyle,
} from "@codemirror-treesitter/theme-gruvbox";
```

The root entry point is `src/index.ts`.

## Source Layout

- `src/index.ts`: color palettes, semantic theme specs, editor themes,
  highlight styles, and combined dark/light theme extensions.
- `tests/theme.test.ts`: export, semantic helper, and local highlighting
  coverage.

## Relationship to Other Packages

This package depends on `@codemirror-treesitter/theme` so concrete Gruvbox
colors do not duplicate CodeMirror selector or highlight-tag mapping. LiveMD
does not depend on this package at runtime; its fenced code blocks reuse the
active CodeMirror syntax highlighters installed by hosts. Use
`@codemirror-treesitter/live-md-theme-gruvbox` for Gruvbox LiveMD prose and
widget presentation variables.

## Current Implementation Notes

- `gruvboxDarkThemeSpec` and `gruvboxLightThemeSpec` translate Gruvbox palettes
  into `SemanticThemeSpec`.
- `gruvboxDarkTheme` and `gruvboxLightTheme` are created with
  `createEditorTheme(...)`.
- `gruvboxDarkHighlightStyle` and `gruvboxLightHighlightStyle` are created with
  `createHighlightStyle(...)`, not local tag mapping.
- `gruvboxDark` and `gruvboxLight` combine editor chrome and syntax
  highlighting for direct use as CodeMirror extensions.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/theme-gruvbox#check
vp run @codemirror-treesitter/theme-gruvbox#test
```

The package tests check existing public exports and shared semantic helper
output.
