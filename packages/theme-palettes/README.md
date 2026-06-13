# @codemirror-treesitter/theme-palettes

Shared concrete color palettes used by both CodeMirror editor theme packages
and LiveMD presentation theme packages.

## Responsibilities

- Export immutable palette objects for Gruvbox, GitHub Light, and Catppuccin.
- Keep palette values independent from CodeMirror selectors, syntax tags, and
  LiveMD CSS variables.

## Public Entry

```ts
import { githubLightColors, gruvboxDarkColors } from "@codemirror-treesitter/theme-palettes";
```

## Validation

```bash
vp run @codemirror-treesitter/theme-palettes#check
vp run @codemirror-treesitter/theme-palettes#test
```
