# @codemirror-treesitter/theme

Shared semantic theme helpers for the CodeMirror Tree-sitter build. Theme
packages define color tokens, while this package owns the common translation
from those tokens to CodeMirror editor chrome and syntax highlighting
extensions.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/language`, `@codemirror/state`, and
  `@codemirror/view`.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally avoids `@codemirror/language` and `@lezer/highlight`.
- Does not define product-specific palettes. Concrete themes live in packages
  such as `@codemirror-treesitter/theme-gruvbox`.

## Responsibilities

- Define semantic editor chrome and syntax color contracts.
- Create `EditorView.theme(...)` extensions from editor chrome tokens.
- Create `HighlightStyle` instances from syntax tokens and local Tree-sitter
  highlight tags.
- Export combined CodeMirror theme extensions for package themes to reuse.

## Public Entry

```ts
import {
  createCodeMirrorTheme,
  createEditorTheme,
  createHighlightStyle,
  type SemanticThemeSpec,
} from "@codemirror-treesitter/theme";
```

The root entry point is `src/index.ts`.

## Source Layout

- `src/index.ts`: semantic token types and CodeMirror extension factories.
- `tests/theme.test.ts`: contract coverage for editor appearance and syntax
  tag mapping.

## Relationship to Other Packages

Theme packages depend on this helper package to avoid duplicating CodeMirror
chrome and syntax mapping. LiveMD remains independent of concrete theme
packages and accepts code-fence highlighting through extensions provided by the
host or a theme package.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/theme#check
vp run @codemirror-treesitter/theme#test
```
