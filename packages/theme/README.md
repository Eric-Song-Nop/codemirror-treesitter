# @codemirror-treesitter/theme

Semantic theme helpers and concrete editor themes for the CodeMirror
Tree-sitter build. The root entry owns the common translation from semantic
color tokens to CodeMirror editor chrome and syntax highlighting extensions.
The `./gruvbox`, `./github`, and `./catppuccin` subpath entries map shared
palettes into that contract.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/language`, `@codemirror/state`, and
  `@codemirror/view`.
- Depends on `@codemirror-treesitter/theme-palettes` for the Gruvbox, GitHub,
  and Catppuccin color values used by the subpath entries.
- Built as an ES module package with Vite+ `vp pack`. Every theme family is a
  separate build entry (`dist/gruvbox.mjs`, `dist/github.mjs`,
  `dist/catppuccin.mjs`) that imports only the root entry and the shared
  palettes, so importing one family does not pull in the others.
- Intentionally avoids `@codemirror/language` and `@lezer/highlight`.
- Does not import LiveMD or `@codemirror-treesitter/live-md-theme`. LiveMD
  presentation themes live in `@codemirror-treesitter/live-md-theme`.

## Responsibilities

- Define semantic editor chrome and syntax color contracts.
- Create `EditorView.theme(...)` extensions from editor chrome tokens.
- Create `HighlightStyle` instances from syntax tokens and local Tree-sitter
  highlight tags.
- Export combined CodeMirror theme extensions.
- Export Gruvbox dark/light, GitHub Light, and Catppuccin Latte/Macchiato
  palettes, semantic specs, editor themes, highlight styles, and combined
  extensions through the subpath entries, without duplicating the shared
  selector or highlight-tag mapping.

## Public Entries

| Entry          | Exports                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`            | `createCodeMirrorTheme`, `createEditorTheme`, `createHighlightStyle`, and the `SemanticThemeSpec`, `EditorChromeColors`, `EditorSyntaxColors`, and `ThemeAppearance` types. |
| `./gruvbox`    | `gruvboxDark`, `gruvboxLight`, `gruvbox{Dark,Light}{Colors,ThemeSpec,Spec,Theme,HighlightStyle}`, and the `GruvboxColors` type.                                             |
| `./github`     | `githubLight`, `githubLight{Colors,ThemeSpec,Theme,HighlightStyle}`.                                                                                                        |
| `./catppuccin` | `catppuccinLatte`, `catppuccinMacchiato`, `catppuccin{Latte,Macchiato}{Colors,ThemeSpec,Theme,HighlightStyle}`, and the `CatppuccinColors` type.                            |

```ts
import {
  createCodeMirrorTheme,
  createEditorTheme,
  createHighlightStyle,
  type SemanticThemeSpec,
} from "@codemirror-treesitter/theme";
import { gruvboxDark, gruvboxLightHighlightStyle } from "@codemirror-treesitter/theme/gruvbox";
import { githubLight } from "@codemirror-treesitter/theme/github";
import { catppuccinMacchiato } from "@codemirror-treesitter/theme/catppuccin";
```

## Source Layout

- `src/index.ts`: semantic token types and CodeMirror extension factories.
- `src/gruvbox.ts`: Gruvbox palettes, semantic specs, editor themes, highlight
  styles, and combined dark/light extensions.
- `src/github.ts`: GitHub Light palette, semantic spec, and CodeMirror
  extensions.
- `src/catppuccin.ts`: Catppuccin Latte and Macchiato palettes, semantic specs,
  editor themes, highlight styles, and combined extensions.
- `tests/theme.test.ts`: contract coverage for editor appearance and syntax
  tag mapping.
- `tests/gruvbox.test.ts`, `tests/github.test.ts`, `tests/catppuccin.test.ts`:
  export, semantic helper, and local highlighting coverage per theme family.

## Relationship to Other Packages

Concrete themes reuse the root helpers so CodeMirror chrome and syntax mapping
live in one place. LiveMD does not depend on this package at runtime; its code
fences reuse the active CodeMirror syntax highlighters installed by the host.
Use the matching `@codemirror-treesitter/live-md-theme/<family>` entry for
LiveMD prose and widget presentation variables.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/theme#check
vp run @codemirror-treesitter/theme#test
vp run @codemirror-treesitter/theme#build
```
