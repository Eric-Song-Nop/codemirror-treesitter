# @codemirror-treesitter/theme-gruvbox

Gruvbox editor themes for the CodeMirror Tree-sitter build. The themes use the
local highlight tag implementation from `@codemirror-treesitter/language`.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/language`, `@codemirror/state`, and
  `@codemirror/view`.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally avoids `@codemirror/language` and `@lezer/highlight`.
- Exports only `.` and `./package.json` from the built package.

## Responsibilities

- Export dark and light Gruvbox color palettes.
- Export `EditorView.theme(...)` extensions for dark and light editor chrome.
- Export `HighlightStyle` instances built with local Tree-sitter highlight
  tags.
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

- `src/index.ts`: color palettes, editor themes, highlight styles, and
  combined dark/light theme extensions.
- `tests/theme.test.ts`: export and local highlighting coverage.

## Relationship to Other Packages

This package depends on `@codemirror-treesitter/language` for
`HighlightStyle`, `syntaxHighlighting`, and `tags`. It is used by the examples
app and LiveMD.

## Current Implementation Notes

- `gruvboxDarkTheme` and `gruvboxLightTheme` style editor chrome through
  `EditorView.theme(...)`.
- `gruvboxDarkHighlightStyle` and `gruvboxLightHighlightStyle` are built from
  local Tree-sitter highlight tags, not `@lezer/highlight`.
- `gruvboxDark` and `gruvboxLight` combine editor chrome and syntax
  highlighting for direct use as CodeMirror extensions.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/theme-gruvbox#check
vp run @codemirror-treesitter/theme-gruvbox#test
vp run audit
```

The audit checks that both dark and light themes are exported and that syntax
highlighting comes from the local Tree-sitter language package.
