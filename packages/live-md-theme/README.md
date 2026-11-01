# @codemirror-treesitter/live-md-theme

Reusable LiveMD presentation theme contract and concrete presentation themes.
The root entry owns the public `--live-md-*` token list and helpers for
applying theme variables to a `<live-md-editor>` host or exported document
container. The `./gruvbox`, `./github`, and `./catppuccin` subpath entries
style Markdown prose, widgets, tables, Mermaid defaults, and code-block
containers through those variables.

## Boundaries

- Depends on `@codemirror-treesitter/theme-palettes` for the Gruvbox, GitHub,
  and Catppuccin colors used by the subpath entries.
- Does not import the LiveMD runtime, `@codemirror-treesitter/theme`, or any
  CodeMirror editor theme.
- Built as an ES module package with Vite+ `vp pack`. Every theme family is a
  separate build entry (`dist/gruvbox.mjs`, `dist/github.mjs`,
  `dist/catppuccin.mjs`) that imports only the root entry and the shared
  palettes, so importing one family does not pull in the others.

## Responsibilities

- Export the full public LiveMD token list.
- Separate reusable color/presentation tokens from product layout and font
  overrides.
- Provide helpers to set and clear theme variables on host elements.
- Export Gruvbox dark/light, GitHub Light, and Catppuccin Latte/Macchiato
  presentation themes through the subpath entries.

`--live-md-selection` is drawn as an overlay above rendered preview content, so
themes should provide a translucent color that keeps text and diagrams legible.
The runtime adds a one-pixel `--live-md-accent` edge to the drawn selection so
its exact bounds remain visible over opaque code and preview surfaces.

Code block token colors still come from the active CodeMirror syntax
highlighters, not from this package. Mermaid nodes in the concrete themes use a
subtle accent tint and accent-derived borders against the page-colored canvas;
labels retain the palette’s foreground colors.

## Public Entries

| Entry          | Exports                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `.`            | Token lists, `createLiveMdTheme`, `setLiveMdThemeVariables`, `clearLiveMdThemeVariables`, types. |
| `./gruvbox`    | `gruvboxDarkLiveMdTheme`, `gruvboxLightLiveMdTheme`.                                             |
| `./github`     | `githubLightLiveMdTheme`.                                                                        |
| `./catppuccin` | `catppuccinLatteLiveMdTheme`, `catppuccinMacchiatoLiveMdTheme`.                                  |

```ts
import {
  liveMdThemeColorVariableNames,
  setLiveMdThemeVariables,
  type LiveMdThemeSpec,
} from "@codemirror-treesitter/live-md-theme";
import { gruvboxDarkLiveMdTheme } from "@codemirror-treesitter/live-md-theme/gruvbox";
import { githubLightLiveMdTheme } from "@codemirror-treesitter/live-md-theme/github";
import { catppuccinMacchiatoLiveMdTheme } from "@codemirror-treesitter/live-md-theme/catppuccin";
```

## Source Layout

- `src/index.ts`: token contract and host variable helpers.
- `src/gruvbox.ts`, `src/github.ts`, `src/catppuccin.ts`: concrete
  presentation themes.
- `tests/theme.test.ts`: token contract coverage.
- `tests/gruvbox.test.ts`, `tests/github.test.ts`, `tests/catppuccin.test.ts`:
  per-family token completeness coverage.

## Validation

```bash
vp run @codemirror-treesitter/live-md-theme#check
vp run @codemirror-treesitter/live-md-theme#test
vp run @codemirror-treesitter/live-md-theme#build
```
