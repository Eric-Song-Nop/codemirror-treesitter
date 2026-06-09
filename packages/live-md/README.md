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
  liveMdCodeFenceHighlighting,
  liveMdImageSource,
  liveMarkdown,
  preloadLiveMdPreviewAssets,
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
import { createLiveMdEditor, liveMdCodeFenceHighlighting } from "@codemirror-treesitter/live-md";
import { gruvboxDarkHighlightStyle } from "@codemirror-treesitter/theme-gruvbox";

const imageAssetUrlMap = new Map<string, string>();
const editor = createLiveMdEditor({
  parent: document.body,
  defaultValue: "# Draft",
  imageSource(source) {
    return imageAssetUrlMap.get(source) ?? source;
  },
  linkBaseUrl: "https://docs.example/notes/current.md",
  placeholder: "Start writing...",
  persistKey: "draft",
  extensions: [liveMdCodeFenceHighlighting(gruvboxDarkHighlightStyle)],
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
`imageSource`, `linkBaseUrl`, `onChange`, and `onBlur`. `imageSource` maps
normalized Markdown image destinations to preview URLs, which lets host apps
serve local files through blob URLs. `linkBaseUrl` is used to resolve relative
Markdown links for Shift-click link jumps. `liveMdCodeFenceHighlighting(...)`
lets hosts override the default code-fence token highlighter so fenced code can
match the surrounding editor theme. The controller exposes `view`, `value`,
`ready`, `setValue()`, `setExtensions()`, `setPersistKey()`, `setPlaceholder()`,
`setReadOnly()`, and `destroy()`.
`preloadLiveMdPreviewAssets()` eagerly loads the KaTeX and Mermaid preview
runtime so host apps can warm service-worker caches before offline use.

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

JavaScript hosts can add `liveMdImageSource(...)` and
`liveMdCodeFenceHighlighting(...)` to the `extensions` property when a web
component needs custom image preview URL resolution or themed code-fence token
highlighting.

The element emits `input`, `change`, `live-md-ready`, `live-md-error`, and
`select`. Styling is installed into Shadow DOM and can be themed with
`--live-md-*` CSS custom properties on the host.

## Source Layout

- `src/index.ts`: public programmatic and element exports.
- `src/register.ts`: side-effect custom element registration.
- `src/style.css`: Shadow DOM editor styles and CSS custom properties.
- `src/core/editor.ts`: editor controller, persistence, read-only state,
  placeholders, and async language loading.
- `src/core/extension.ts`, `src/core/decorations.ts`,
  `src/core/dirty-ranges.ts`, `src/core/features.ts`, `src/core/widgets.ts`,
  `src/core/images.ts`, `src/core/links.ts`, `src/core/search.ts`, and
  `src/core/languages.ts`: live Markdown extension, query-based decoration
  pipeline, dirty-range patching, feature registration, image source
  resolution, link interactions, search, widget rendering, and language
  loading.
- `src/element/*`: custom element implementation and style installation.
- `src/fixtures/*`: reusable sample content for examples and benchmarks.
- `vite-plugin.ts`: raw CSS helper used by apps that need to import LiveMD CSS
  in Vite builds.
- `tests/*`: web component behavior, readonly commands, Markdown features,
  code fences, LaTeX, Mermaid, style installation, and paragraph behavior.

## Relationship to Other Packages

LiveMD composes `basic-setup`, `language`, `language-data`, `commands`,
`autocomplete`, and `theme-gruvbox`. Optional collaboration is layered through
`@codemirror-treesitter/live-md-loro` so this package stays independent of Loro
and Cloudflare-specific code.

## Current Implementation Notes

- Public exports are limited to the editor controller, live Markdown extension,
  image source helpers, code-fence highlighting, and custom element definition.
- `./register` only defines the custom element and re-exports the element API.
- `./fixtures` currently exposes benchmark/example Markdown content such as
  `createInitialMarkdown(...)`.
- The custom element installs package CSS into Shadow DOM; hosts can also import
  `./style.css` for bundler-visible styling.

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
