# @codemirror-treesitter/theme-gruvbox

Gruvbox editor themes for the CodeMirror Tree-sitter build. The themes use the
local highlight tag implementation from `@codemirror-treesitter/language`.

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

The root entry point is `src/index.ts`, and the package exports only `.` and
`./package.json`.

## Relationship to Other Packages

This package depends on `@codemirror-treesitter/language` for
`HighlightStyle`, `syntaxHighlighting`, and `tags`. It is used by the examples
app and LiveMD.

## Validation

Run from the workspace root:

```bash
vp check
vp run -r test
vp run audit
```

The audit checks that both dark and light themes are exported and that syntax
highlighting comes from the local Tree-sitter language package.
