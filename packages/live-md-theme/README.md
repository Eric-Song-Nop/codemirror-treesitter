# @codemirror-treesitter/live-md-theme

Reusable LiveMD presentation theme contract. This package owns the public
`--live-md-*` token list and helpers for applying theme variables to a
`<live-md-editor>` host or exported document container.

## Responsibilities

- Export the full public LiveMD token list.
- Separate reusable color/presentation tokens from product layout and font
  overrides.
- Provide helpers to set and clear theme variables on host elements.
- Avoid importing CodeMirror editor themes or the LiveMD runtime.

## Public Entry

```ts
import {
  liveMdThemeColorVariableNames,
  setLiveMdThemeVariables,
  type LiveMdThemeSpec,
} from "@codemirror-treesitter/live-md-theme";
```

## Validation

```bash
vp run @codemirror-treesitter/live-md-theme#check
vp run @codemirror-treesitter/live-md-theme#test
```
