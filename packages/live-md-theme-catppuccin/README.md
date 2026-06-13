# @codemirror-treesitter/live-md-theme-catppuccin

Catppuccin Latte and Macchiato LiveMD presentation themes. They style Markdown
prose, widgets, tables, Mermaid defaults, and code-block containers through
`--live-md-*` variables.

## Boundaries

- Depends on `@codemirror-treesitter/live-md-theme` for the token contract.
- Depends on `@codemirror-treesitter/theme-palettes` for Catppuccin colors.
- Does not import LiveMD runtime or CodeMirror editor theme packages.

## Public Entry

```ts
import {
  catppuccinLatteLiveMdTheme,
  catppuccinMacchiatoLiveMdTheme,
} from "@codemirror-treesitter/live-md-theme-catppuccin";
```

Code block token colors still come from the active CodeMirror syntax
highlighters, not from this package.
