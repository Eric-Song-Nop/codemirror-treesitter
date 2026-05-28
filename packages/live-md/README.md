# @codemirror-treesitter/live-md

LiveMD is the product-facing Markdown editor runtime built from the local
CodeMirror Tree-sitter packages. It exposes a programmatic API, a
`<live-md-editor>` web component, a side-effect registration entry, fixtures,
and a CSS export.

## Stack and Boundaries

- Depends on local `autocomplete`, `basic-setup`, `commands`, `language`,
  `language-data`, and `theme-gruvbox` packages plus official CodeMirror
  state/view packages.
- Uses KaTeX, Mermaid, and `beautiful-mermaid` for rich Markdown widgets.
- Built as an ES module package with Vite+ `vp pack`.
- Keeps collaboration optional. Loro-specific code belongs in
  `@codemirror-treesitter/live-md-loro`, not this package.

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
  mode, placeholder text, focus/blur, selection APIs, dirty tracking, ready and
  error events, and fixtures for demos/benchmarks.

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

## Programmatic API

```ts
import { createLiveMdEditor } from "@codemirror-treesitter/live-md";

const editor = createLiveMdEditor({
  parent: document.body,
  defaultValue: "# Draft",
  placeholder: "Start writing...",
  persistKey: "draft",
  onChange({ value }) {
    console.log(value);
  },
});

await editor.ready;
editor.setValue("# Updated");
editor.destroy();
```

`createLiveMdEditor()` accepts `value`, `doc`, `defaultValue`, `persistKey`,
`placeholder`, `readOnly`, `autofocus`, `focus`, `root`, `extensions`,
`onChange`, and `onBlur`. The controller exposes `view`, `value`, `ready`,
`setValue()`, `setExtensions()`, `setPersistKey()`, `setPlaceholder()`,
`setReadOnly()`, and `destroy()`.

## Web Component

```html
<live-md-editor autofocus persist-key="draft" placeholder="Start writing..."></live-md-editor>
<script type="module">
  import "@codemirror-treesitter/live-md/register";
</script>
```

The element reflects the runtime API through `value`, `defaultValue`,
`persistKey`, `placeholder`, `readOnly`, `dirty`, `selectionStart`,
`selectionEnd`, `view`, `extensions`, `ready`, `markClean()`,
`setSelectionRange(...)`, and `select()`.

The element emits `input`, `change`, `live-md-ready`, `live-md-error`, and
`select`. Styling is installed into Shadow DOM and can be themed with
`--live-md-*` CSS custom properties on the host.

## Source Layout

- `src/index.ts`: public programmatic and element exports.
- `src/register.ts`: side-effect custom element registration.
- `src/style.css`: Shadow DOM editor styles and CSS custom properties.
- `src/core/editor.ts`: editor controller, persistence, read-only state,
  placeholders, and async language loading.
- `src/core/extension.ts`, `src/core/decorations.ts`, `src/core/widgets.ts`,
  `src/core/dirty-ranges.ts`, `src/core/features.ts`, and
  `src/core/languages.ts`: live Markdown extension, decoration pipeline,
  widget rendering, dirty-range tracking, feature registry, and language
  loading.
- `src/element/*`: custom element implementation and style installation.
- `src/fixtures/*`: reusable sample content for examples and benchmarks.
- `vite-plugin.ts`: raw CSS helper used by apps that need to import LiveMD CSS
  in Vite builds.
- `tests/*`: web component behavior, readonly commands, dirty ranges,
  Markdown features, code fences, LaTeX, Mermaid, style installation, and
  paragraph behavior.

## Relationship to Other Packages

LiveMD composes `basic-setup`, `language`, `language-data`, `commands`,
`autocomplete`, and `theme-gruvbox`. Optional collaboration is layered through
`@codemirror-treesitter/live-md-loro` so this package stays independent of Loro
and Cloudflare-specific code.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/live-md#check
vp run @codemirror-treesitter/live-md#test
vp run @codemirror-treesitter/live-md#build
```

The LiveMD test suite covers web component behavior, readonly commands,
dirty-range expansion, feature registration, code fences, LaTeX, Mermaid,
paragraph breaks, and style installation.
