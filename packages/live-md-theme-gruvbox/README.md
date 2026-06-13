# @codemirror-treesitter/live-md-theme-gruvbox

Gruvbox LiveMD presentation themes. These themes style Markdown prose,
widgets, tables, Mermaid defaults, and code-block containers through
`--live-md-*` variables.

## Boundaries

- Depends on `@codemirror-treesitter/live-md-theme` for the token contract.
- Depends on `@codemirror-treesitter/theme-palettes` for Gruvbox colors.
- Does not import LiveMD runtime or CodeMirror editor theme packages.

## Public Entry

```ts
import {
  gruvboxDarkLiveMdTheme,
  gruvboxLightLiveMdTheme,
} from "@codemirror-treesitter/live-md-theme-gruvbox";
```

Code block token colors still come from the active CodeMirror syntax
highlighters, not from this package.
