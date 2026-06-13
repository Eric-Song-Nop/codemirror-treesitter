# @codemirror-treesitter/live-md-theme-github

GitHub Light LiveMD presentation theme. It styles Markdown prose, widgets,
tables, Mermaid defaults, and code-block containers through `--live-md-*`
variables.

## Boundaries

- Depends on `@codemirror-treesitter/live-md-theme` for the token contract.
- Depends on `@codemirror-treesitter/theme-palettes` for GitHub colors.
- Does not import LiveMD runtime or CodeMirror editor theme packages.

## Public Entry

```ts
import { githubLightLiveMdTheme } from "@codemirror-treesitter/live-md-theme-github";
```

Code block token colors still come from the active CodeMirror syntax
highlighters, not from this package.
