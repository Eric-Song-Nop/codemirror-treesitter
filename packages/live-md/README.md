# @codemirror-treesitter/live-md

LiveMD is the product-facing Markdown editor runtime built from the local
CodeMirror Tree-sitter packages. It exposes a programmatic API, a
`<live-md-editor>` web component, a side-effect registration entry, fixtures,
an HTML renderer, scoped document CSS helpers, and a CSS export.

## Stack and Boundaries

- Depends on local `autocomplete`, `basic-setup`, `commands`, `language`, and
  `language-data` packages plus official CodeMirror state/view packages.
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
- Render Markdown documents to sanitized HTML through
  `renderMarkdownToHtml(...)` using the same Tree-sitter Markdown grammar.
- Provide scoped document CSS through `liveMdMarkdownDocumentCss()` so host apps
  can style exported HTML with the same `--live-md-*` theme tokens as the
  editor without importing app-level styles.
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
  liveMdMarkdownDocumentClass,
  liveMdMarkdownDocumentCss,
  liveMdMarkdownDocumentCssVariables,
  liveMdImageAssets,
  liveMdImageSource,
  liveMdLinkBehavior,
  liveMdMarkdownFeature,
  liveMdTheme,
  liveMarkdown,
  prepareLiveMd,
  renderMarkdownToHtml,
  type LiveMdConfig,
  type LiveMdMarkdownConfig,
  type LiveMdPlugin,
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
import {
  createLiveMdEditor,
  liveMdImageAssets,
  liveMdLinkBehavior,
  liveMdMarkdownFeature,
  liveMdTheme,
  prepareLiveMd,
  type LiveMdConfig,
  type LiveMdMarkdownConfig,
  type LiveMdPlugin,
} from "@codemirror-treesitter/live-md";
import { gruvboxDarkLiveMdTheme } from "@codemirror-treesitter/live-md-theme-gruvbox";
import { gruvboxDark } from "@codemirror-treesitter/theme-gruvbox";

await prepareLiveMd();

const imageAssetUrlMap = new Map<string, string>();
const callouts = liveMdMarkdownFeature({
  name: "callouts",
  query: "(block_quote) @callout @html",
  decorate({ addLineClass, node, slice }) {
    let callout = node("callout");
    if (!callout || !slice(callout).startsWith("> [!")) return;
    addLineClass(callout.from, callout.to, "cm-md-callout");
  },
  async renderHtml({ renderDefault, node, slice }) {
    let callout = node("callout");
    if (!callout || !slice(callout).startsWith("> [!")) return null;
    return (await renderDefault())
      .replace("<blockquote>", '<aside class="live-md-callout">')
      .replace("</blockquote>", "</aside>");
  },
});
const plugins = [
  liveMdTheme({
    editor: gruvboxDark,
    theme: gruvboxDarkLiveMdTheme,
  }),
  liveMdImageAssets({
    resolve(source) {
      return imageAssetUrlMap.get(source) ?? source;
    },
  }),
  liveMdLinkBehavior({
    baseUrl: "https://docs.example/notes/current.md",
  }),
] satisfies LiveMdPlugin[];
const config = {
  markdown: {
    features: [callouts],
  } satisfies LiveMdMarkdownConfig,
  plugins,
} satisfies LiveMdConfig;
const editor = createLiveMdEditor({
  parent: document.body,
  defaultValue: "# Draft",
  placeholder: "Start writing...",
  persistKey: "draft",
  onChange({ value }) {
    console.log(value);
  },
  config,
});

await editor.ready;
editor.setValue("# Updated");
editor.destroy();
```

`createLiveMdEditor()` accepts `value`, `doc`, `defaultValue`, `persistKey`,
`placeholder`, `readOnly`, `autofocus`, `focus`, `root`, `config`,
`extensions`, `imageSource`, `linkBaseUrl`, `onChange`, and `onBlur`.
`config.markdown.features` is the query-driven Markdown syntax layer. A
`LiveMdMarkdownFeature` can contribute a Tree-sitter query and a constrained
decoration callback for marks, line classes, syntax visibility, replacement
widgets, and atomic ranges. It can also provide a separate `renderHtml(...)`
hook for `renderMarkdownToHtml(...)`; the hook receives the matched target
node, capture helpers, `slice(...)`, `renderDefault()`, `renderChildren(...)`,
and `renderInline(...)` so export logic does not depend on editor-only
decoration semantics. Features run after the standard LiveMD Markdown
decorations and are reconfigured by `setConfig(...)` or `setMarkdown(...)`.
`config.plugins` is the host-behavior layer: each `LiveMdPlugin` can provide a
CodeMirror `extension` and an optional `mount` hook that may return cleanup for
`setConfig(...)`, `setPlugins(...)`, and `destroy()`.
`liveMdTheme(...)`, `liveMdImageAssets(...)`, and `liveMdLinkBehavior(...)`
cover common host integrations while keeping storage, upload, and navigation
policy in the host app.
`markdown` and `plugins` remain supported as compatibility shortcuts on
`createLiveMdEditor(...)`; `config` takes precedence when both are present.
`extensions` remains the direct CodeMirror escape hatch and is applied after
plugin extensions. `imageSource` maps normalized Markdown image destinations to
preview URLs, which lets host apps serve local files through blob URLs.
`linkBaseUrl` is used to resolve relative Markdown links for Shift-click link
jumps. Fenced code token colors reuse the active CodeMirror syntax highlighters
installed through `extensions`.
`liveMdCodeFenceHighlighting(...)` is still available for advanced hosts that
need to override fenced-code highlighting explicitly. The controller exposes `view`, `value`,
`ready`, `setValue()`, `setConfig()`, `setPlugins()`, `setMarkdown()`,
`setExtensions()`, `setPersistKey()`, `setPlaceholder()`, `setReadOnly()`, and
`destroy()`.

`prepareLiveMd(options?)` preloads Markdown language support and warms the
LiveMD Markdown decoration queries before the first editor render. Pass
`{ codeFences: true }` when a host also wants to preload the bundled
code-fence language parsers during startup.

`renderMarkdownToHtml(markdown, options?)` converts Markdown source to escaped
HTML with the package Tree-sitter Markdown parser. Hosts can pass the same
`markdown` feature config used by the editor, plus `resolveImageSource` to
rewrite image destinations during export:

```ts
const html = await renderMarkdownToHtml(markdown, {
  markdown: config.markdown,
  resolveImageSource({ source }) {
    return imageAssetUrlMap.get(source) ?? source;
  },
});
```

`liveMdMarkdownDocumentCss()` returns CSS scoped to the exported document root
class from `liveMdMarkdownDocumentClass`. The stylesheet is driven by the
custom properties listed in `liveMdMarkdownDocumentCssVariables`, which lets an
app snapshot its current LiveMD theme variables and inline them into standalone
HTML exports without leaking workspace, reset, or component-library CSS.

## Web Component

```html
<live-md-editor autofocus persist-key="draft" placeholder="Start writing..."></live-md-editor>
<script type="module">
  import { defineLiveMdEditor, prepareLiveMd } from "@codemirror-treesitter/live-md";

  defineLiveMdEditor();
  void prepareLiveMd().catch((error) => {
    // Surface the preload failure in app-specific UI while the element still mounts.
    console.error(error);
  });
</script>
```

The element reflects the runtime API through `value`, `defaultValue`,
`persistKey`, `placeholder`, `readOnly`, `dirty`, `selectionStart`,
`selectionEnd`, `view`, `config`, `markdown`, `plugins`, `extensions`, `ready`,
`markClean()`, `setSelectionRange(...)`, and `select()`.

JavaScript hosts can add `liveMdImageSource(...)` and
ordinary CodeMirror theme extensions to the `extensions` property when a web
component needs custom image preview URL resolution or themed code-fence token
highlighting. They can assign `config` for host behavior and query-feature
configuration, while `plugins` and `markdown` remain available as focused
property shortcuts. `liveMdCodeFenceHighlighting(...)` can override the active
syntax highlighters for specialized fenced-code rendering.

The element emits `input`, `change`, `live-md-ready`, `live-md-error`, and
`select`. Styling is installed into Shadow DOM and can be themed with
`--live-md-*` CSS custom properties on the host.

The side-effect `@codemirror-treesitter/live-md/register` entry remains
available for simple hosts. It defines the default custom element immediately,
starts `prepareLiveMd()` in the background, and dispatches a global
`live-md-error` event if preload fails.

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
- `src/core/markdown-html.ts`: Tree-sitter Markdown-to-HTML renderer and scoped
  document CSS helpers for hosts that need sanitized document export.
- `src/element/*`: custom element implementation and style installation.
- `src/fixtures/*`: reusable sample content for examples and benchmarks.
- `vite-plugin.ts`: raw CSS helper used by apps that need to import LiveMD CSS
  in Vite builds.
- `tests/*`: web component behavior, readonly commands, Markdown features,
  code fences, LaTeX, Mermaid, style installation, and paragraph behavior.

## Relationship to Other Packages

LiveMD composes `basic-setup`, `language`, `language-data`, `commands`, and
`autocomplete`. Optional collaboration is layered through
`@codemirror-treesitter/live-md-loro` so this package stays independent of Loro,
Cloudflare-specific code, and concrete theme packages.

## Current Implementation Notes

- Public exports are limited to the editor controller, live Markdown extension,
  image source helpers, startup preparation, code-fence highlighting, Markdown
  HTML rendering, scoped document CSS helpers, and custom element definition.
- `./register` prepares LiveMD, defines the custom element, and re-exports the
  element API.
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
paragraph breaks, Markdown HTML rendering, and style installation.
