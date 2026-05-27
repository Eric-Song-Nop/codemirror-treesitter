# @codemirror-treesitter/live-md

LiveMD is the product-facing Markdown editor runtime built from the local
CodeMirror Tree-sitter packages. It exposes both a programmatic API and a
`<live-md-editor>` web component.

## Responsibilities

- Create Markdown editors through `createLiveMdEditor(...)`.
- Provide the `liveMarkdown(...)` extension for live Markdown editing.
- Define and register `<live-md-editor>` through `defineLiveMdEditor(...)` and
  the side-effect `./register` entry.
- Load Markdown language support and a focused set of code-fence languages from
  `@codemirror-treesitter/language-data`.
- Render live Markdown decorations for headings, lists, task checkboxes,
  blockquotes, inline emphasis/strong/strike/code/link syntax, tables, images,
  thematic breaks, LaTeX, Mermaid diagrams, and code fences.
- Patch decorations incrementally with dirty-range analysis so edits avoid full
  document recomputation where possible.
- Support Shadow DOM styling, CSS custom properties, persistence, readonly
  mode, placeholder text, focus/blur, selection APIs, dirty tracking, and ready
  and error events.
- Export fixtures used by demos and benchmarks.

## Public Entries

```ts
import {
  createLiveMdEditor,
  defineLiveMdEditor,
  liveMarkdown,
} from "@codemirror-treesitter/live-md";
```

```ts
import "@codemirror-treesitter/live-md/register";
import "@codemirror-treesitter/live-md/style.css";
```

The package also exports `@codemirror-treesitter/live-md/fixtures` for example
and benchmark content.

## Web Component

```html
<live-md-editor autofocus persist-key="draft" placeholder="Start writing..."></live-md-editor>
<script type="module">
  import "@codemirror-treesitter/live-md/register";
</script>
```

The element reflects the runtime API through `value`, `defaultValue`,
`persistKey`, `placeholder`, `readOnly`, `dirty`, `selectionStart`,
`selectionEnd`, `view`, `markClean()`, `setSelectionRange(...)`, and
`select()`.

## Relationship to Other Packages

LiveMD composes `basic-setup`, `language`, `language-data`, `commands`,
`autocomplete`, and `theme-gruvbox`. It also uses KaTeX and Mermaid for rich
Markdown widgets.

## Validation

Run from the workspace root:

```bash
vp check
vp run -r test
```

The LiveMD test suite covers web component behavior, readonly commands,
dirty-range expansion, feature registration, code fences, LaTeX, Mermaid,
paragraph breaks, and style installation.
