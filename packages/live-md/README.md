# @codemirror-treesitter/live-md

LiveMD is the product-facing Markdown editor runtime built from the local
CodeMirror Tree-sitter packages. It exposes a programmatic API, a
`<live-md-editor>` web component, a side-effect registration entry, fixtures,
an HTML renderer, scoped document CSS helpers, a CSS export, and a unified
`LiveMdConfig` entry point for Markdown features and host plugins.

## Stack and Boundaries

- Depends on local `autocomplete`, `basic-setup`, `commands`, `language`, and
  `language-data` packages plus official CodeMirror state/view packages.
- Uses KaTeX, Mermaid, and `beautiful-mermaid` for rich Markdown widgets.
- Built as an ES module package with Vite+ `vp pack`.
- Keeps collaboration optional. Loro-specific code belongs in
  `@codemirror-treesitter/live-md-loro`, not this package.
- LiveMD uses range-local immutable semantic caches: the Markdown block cursor
  discovers affected leaves, contexts, and markers; unchanged leaves reuse their
  analysis objects; projection maps descriptors to decorations and widgets.
  Direct layout patches rebuild structural line classes only around affected
  records, with all projection work included in the trace. Pending edits map
  persistent decoration ranges and repair only touched replacement boundaries.
  Initialization and invalidated analysis inputs still require full discovery.

## Responsibilities

- Create Markdown editors through `createLiveMdEditor(...)`.
- Provide the `liveMarkdown(...)` extension for live Markdown editing.
- Define and register `<live-md-editor>` through `defineLiveMdEditor(...)` and
  the side-effect `./register` entry.
- Load block-only Markdown language support and an explicit Markdown inline
  parser service from the focused `@codemirror-treesitter/language-data/live-md`
  entry. Code-fence grammars load only when the document encounters a supported
  fence alias; hosts may still explicitly preload the full focused set.
- Render Markdown documents to sanitized HTML through
  `renderMarkdownToHtml(...)` using explicit block parsing followed by
  leaf-local inline parsing with the Tree-sitter Markdown grammars.
- Provide scoped document CSS through `liveMdMarkdownDocumentCss()` so host apps
  can style exported HTML with the same `--live-md-*` theme tokens as the
  editor without importing app-level styles.
- Render live Markdown decorations for headings, lists, task checkboxes,
  blockquotes, inline emphasis/strong/strike/code/link syntax, tables, images,
  thematic breaks, LaTeX, Mermaid diagrams, and code fences.
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
  liveMdLinkOpen,
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

`unstableLiveMdAnalysisTrace(view)` is available for benchmark and diagnostic
instrumentation that needs aggregate analysis counters. It is intentionally
unstable and should not be used as a rendering or extension API.

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
  query: `
    (block_quote) @html
    (paragraph) @callout
  `,
  analyze({ leaf, node, slice }) {
    let callout = node("callout");
    if (!callout || !slice(leaf.sourceRange).startsWith("> [!")) return [];
    return [
      {
        className: "cm-md-callout",
        kind: "lineClass",
        range: leaf.sourceRange,
      },
    ];
  },
  async renderHtml({ renderDefault, slice, target }) {
    if (target.name != "block_quote" || !slice(target).startsWith("> [!")) return null;
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
`LiveMdMarkdownFeature` can contribute a Tree-sitter query and a leaf-scoped
`analyze(...)` hook that returns DOM-free descriptors for marks, line classes,
syntax visibility, and keyed replacement widgets. The editor runs feature
queries per Markdown leaf during semantic analysis, so feature output uses the
same cache, pending-edit behavior, and projection layers as built-in LiveMD
syntax. Features can also provide a separate `renderHtml(...)` hook for
`renderMarkdownToHtml(...)`; the hook receives the matched target node, capture
helpers, `slice(...)`, `renderDefault()`, `renderChildren(...)`, and
`renderInline(...)` so export logic does not depend on editor projection
semantics. Deprecated `decorate(...)` callbacks remain typed for source
compatibility but are no longer invoked by the editor runtime. Features run
after the standard LiveMD Markdown descriptors and are reconfigured by
`setConfig(...)`. Markdown syntax extensions are called features, not plugins;
plugins are reserved for host behavior.
`config.plugins` is the host-behavior layer: each `LiveMdPlugin` can provide a
CodeMirror `extension` and an optional `mount` hook that may return cleanup for
plugin changes through `setConfig(...)` and for `destroy()`.
`liveMdTheme(...)`, `liveMdImageAssets(...)`, and `liveMdLinkBehavior(...)`
cover common host integrations while keeping storage, upload, and navigation
policy in the host app.
`config` is the single host configuration entry point on `createLiveMdEditor(...)`.
Treat `config.markdown`, `config.plugins`, and their arrays as immutable,
reference-stable values when updating an editor. LiveMD uses reference equality
to avoid reconfiguring unchanged feature and plugin compartments.
`extensions` remains the direct CodeMirror escape hatch and is applied after
plugin extensions. `imageSource` maps normalized Markdown image destinations to
preview URLs, or to `{ src, width, height }` when the host knows image
dimensions, which lets local-file previews reserve stable layout through blob
URLs.
`linkBaseUrl` is used to resolve relative Markdown links for Shift-click link
jumps. Link jumps open in a new browsing context by default; hosts can add
`liveMdLinkOpen(handler)` through `extensions` to customize navigation. Fenced
code token colors reuse the active CodeMirror syntax highlighters installed
through `extensions`.
`liveMdCodeFenceHighlighting(...)` is still available for advanced hosts that
need to override fenced-code highlighting explicitly. The controller exposes `view`, `value`,
`ready`, `setValue()`, `setConfig()`, `setExtensions()`, `setPersistKey()`,
`setPlaceholder()`, `setReadOnly()`, and `destroy()`.

Query-driven editor features should use `analyze(...)` and return descriptor
ranges in document coordinates. The hook receives capture helpers, `slice(...)`,
and leaf metadata (`kind`, `range`, `sourceRange`, and `contextKey`) but no
editor state or selection data; analysis is intentionally selection-independent.
Feature identity and `analyze(...)` configuration participate in semantic cache
keys, so `setConfig(...)` invalidates stale feature records through the normal
analysis path.
Replacement descriptor ranges must contain only the source bytes owned by the
widget. In particular, leave surrounding line separators, container prefixes,
and trailing blank lines outside the range. The `block` option controls layout,
not source ownership; insertions at either replacement boundary remain editable
outside the widget, including when `atomic` is enabled.
Blank lines are ordinary editable document text. In a normal paragraph,
`Enter` and `Shift+Enter` both insert one newline. Their behavior differs only
inside structural Markdown contexts: `Enter` keeps list, task-list, and
blockquote continuation behavior, while `Shift+Enter` inserts a raw newline.

`prepareLiveMd(options?)` preloads Markdown language support and warms the
LiveMD Markdown decoration queries before the first editor render. The editor
installs a block-only Markdown language and keeps inline parsing inside the
LiveMD analysis/export layer instead of depending on the generic nested
Markdown language entry. Pass
`{ codeFences: true }` when a host also wants to preload the bundled
code-fence language parsers during startup.
Rejected preload attempts are not cached permanently; callers may invoke
`prepareLiveMd()` again after a transient asset or network failure.

`renderMarkdownToHtml(markdown, options?)` converts Markdown source to escaped
HTML with the package Tree-sitter Markdown parser. Hosts can pass the same
`markdown` feature config used by the editor so query-driven features can
customize block-level export output with `renderHtml(...)`. Inline query
replacement during export is intentionally not part of this hook yet; use
`renderInline(...)` from a block-level feature when custom output needs nested
inline Markdown. `renderHtml(...)` always queries the block tree. The export
hook is separate from editor-only `analyze(...)` descriptors. Exported links
reuse the editor's `http`, `https`, `mailto`, and `tel` protocol allowlist;
relative links remain relative, while unsafe destinations render as plain link
labels:

```ts
const callouts = liveMdMarkdownFeature({
  name: "callouts",
  query: "(block_quote) @html",
  async renderHtml({ renderDefault, slice, target }) {
    if (!slice(target).startsWith("> [!")) return null;
    return `<aside class="callout">${await renderDefault()}</aside>`;
  },
});

const html = await renderMarkdownToHtml(markdown, {
  markdown: { features: [callouts] },
});
```

Hosts can also pass `resolveImageSource` to rewrite image destinations during
export:

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
`selectionEnd`, `view`, `config`, `extensions`, `ready`, `markClean()`,
`setSelectionRange(...)`, and `select()`.

JavaScript hosts can add `liveMdImageSource(...)`, `liveMdLinkOpen(...)`, and
ordinary CodeMirror theme extensions to the `extensions` property when a web
component needs custom image preview URL resolution, link navigation, or themed
highlighting. They can assign `config` for host behavior and query-feature
configuration, including plugin-style image assets and link behavior.
`liveMdCodeFenceHighlighting(...)` can override the active syntax highlighters
for specialized fenced-code rendering.

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
  `src/core/features.ts`, `src/core/widgets.ts`, `src/core/images.ts`,
  `src/core/links.ts`, `src/core/search.ts`, and `src/core/languages.ts`: live
  Markdown extension, StateField export bridge, feature registration, image
  source resolution, link interactions, search, widget rendering, and language
  loading.
- `src/core/analysis`, `src/core/projection`, and `src/core/runtime`: staging
  split for block/query/table helpers, DOM-free leaf semantic descriptors,
  projection helpers, and StateField lifecycle. `markdown-block-types.ts` and
  `markdown-block-cursor.ts` are the production Markdown block snapshot path
  for leaf classification, structured quote/list/task context, marker records,
  and sorted lookup inputs. `ranges.ts` is the shared source of truth for range
  math (clamp/map/touch/overlap/normalize/subtract) and content hashing used
  across analysis, projection, and runtime. `descriptors.ts`,
  `markdown-leaf-analysis.ts`, `markdown-inline-analysis.ts`,
  `markdown-table-analysis.ts`, and `markdown-fence-analysis.ts` implement the
  full-walk leaf-local semantic baseline. `projection/project-leaf.ts` maps
  semantic descriptors to existing CodeMirror effects and widgets.
- `src/core/analysis/markdown-leaf-spike.ts`: Gate B validation harness for
  local Markdown leaf discovery. It now calls the production block cursor and
  keeps only edit-range seeding, fixed-point retry, full-walk oracle comparison,
  and trace data. It is not the production incremental analysis cache.
- `src/core/markdown-html.ts`: Tree-sitter Markdown-to-HTML renderer and scoped
  document CSS helpers for hosts that need sanitized document export.
- `src/element/*`: custom element implementation and style installation.
- `src/fixtures/*`: reusable sample content for examples and benchmarks.
- `vite-plugin.ts`: raw CSS helper used by apps that need to import LiveMD CSS
  in Vite builds.
- `tests/*`: web component behavior, readonly commands, Markdown features,
  code fences, LaTeX, Mermaid, style installation, and newline behavior.

## Relationship to Other Packages

LiveMD composes `basic-setup`, `language`, `language-data`, `commands`, and
`autocomplete`. Optional collaboration is layered through
`@codemirror-treesitter/live-md-loro` so this package stays independent of Loro,
Cloudflare-specific code, and concrete theme packages.

## Current Implementation Notes

- Public exports are limited to the editor controller, live Markdown extension,
  image source and link navigation helpers, startup preparation, code-fence
  highlighting, Markdown HTML rendering, scoped document CSS helpers, and
  custom element definition.
- `./register` prepares LiveMD, defines the custom element, and re-exports the
  element API.
- `./fixtures` currently exposes benchmark/example Markdown content such as
  `createInitialMarkdown(...)`.
- The custom element installs package CSS into Shadow DOM; hosts can also import
  `./style.css` for bundler-visible styling.
- Clicking anywhere on an inactive Mermaid, table, or full-line image preview
  reveals that block's Markdown source. A following blank line remains a
  separate editable line across the editor width.
- The runtime performs a full block walk when needed, but Markdown behavior
  flows through an immutable leaf semantic cache before projection.
  Unchanged leaf records can retain `cacheId` and analysis object identity after
  ordinary edits. Custom query-driven Markdown features run during per-leaf
  semantic analysis and project through the same direct and surface layers as
  built-in descriptors.
- Visible surface projections retain mapped compiled coverage across edits.
  Semantic commits invalidate changed effect ranges and changed active source
  islands; pending interaction and source-reveal holes are compiled again on
  commit. Renderer and parser context changes still require a full refresh.
- The changed-leaf harness remains a range-local oracle check on top of the
  production block cursor. Its result is `Gate B: PASS` for range-local
  changed-leaf discovery: local changed leaves match the full-walk oracle, and
  ordinary edits stay local. Its `sourceHash` is diagnostic only; exact source
  text is used for the oracle so hash collisions cannot hide changed leaves.
  Semantic work is scheduled in bounded units, and search reuses committed or
  pending semantic records while reparsing only dirty inline hosts. Direct
  incremental projection remains future work. Render caches use bounded LRU
  storage keyed by source identity plus renderer, resolver, and highlighter
  epochs for image sources, KaTeX, table previews, Mermaid render requests, and
  code fence highlights. `cacheId` is deliberately excluded from render cache
  keys so record identity churn does not invalidate unchanged render work.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/live-md#check
vp run @codemirror-treesitter/live-md#test
vp run @codemirror-treesitter/live-md#build
```

The LiveMD test suite covers web component behavior, readonly commands,
leaf-local analysis equivalence against the canonical semantic oracle,
feature registration, code fences, LaTeX, Mermaid, newline editing, Markdown
HTML rendering, and style installation.
