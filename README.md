# CodeMirror Tree-sitter

CodeMirror Tree-sitter is a Lezer-free CodeMirror 6 workspace backed by
Tree-sitter through `web-tree-sitter`. It reimplements the editor-facing
CodeMirror packages that normally depend on Lezer and publishes them under the
`@codemirror-treesitter/*` scope so they can be installed beside the official
`@codemirror/*` packages.

The repository also contains LiveMD, a Tree-sitter-powered Markdown editor that
ships as both a programmatic editor API and a `<live-md-editor>` web component,
plus demo and benchmark apps for comparing behavior, performance, and
collaboration flows.

## Current Stack

- **Runtime and package manager**: Bun `1.3.14` through Vite+ `vp install`,
  with Node.js `>=22.12.0` required by the workspace.
- **Toolchain**: Vite+ (`vp`) wraps Vite, Rolldown, Vitest, tsdown, Oxlint,
  Oxfmt, and Vite Task. Root formatting, linting, type-aware checks, task
  caching, and shared aliases are configured in `vite.config.ts`.
- **Language and build config**: TypeScript 6.x, native TypeScript preview
  dependencies in packages, ES modules everywhere, shared `tsconfig.*` files,
  and package builds through `vp pack`.
- **Editor foundation**: Official `@codemirror/state`, `@codemirror/view`,
  `@codemirror/search`, and `@codemirror/lint` remain direct dependencies where
  Lezer is not part of the contract.
- **Parser layer**: `web-tree-sitter`, Tree-sitter grammar packages, bundled
  WASM assets, highlight queries, incremental reparsing, and included ranges
  for nested languages.
- **Markdown product layer**: LiveMD composes the local language, commands,
  autocomplete, basic setup, language-data, and Gruvbox theme packages with
  KaTeX, Mermaid, and `beautiful-mermaid`.
- **Collaboration layer**: Optional LiveMD Loro bindings use `loro-crdt` and
  `loro-codemirror`. The `collab-editor` app runs on Cloudflare Workers with a
  Durable Object room, WebSocket sync, Wrangler, and the Cloudflare Vite plugin.

## Quickstart

```html
<body>
  <live-md-editor autofocus placeholder="Start writing..."></live-md-editor>
  <script type="module">
    import "@codemirror-treesitter/live-md/register";
  </script>
</body>
```

A single import registers the `<live-md-editor>` web component with
Tree-sitter-powered Markdown parsing, syntax highlighting, live Markdown
decorations, Shadow DOM styling, and Gruvbox theming. See
[Web Component](#web-component) for the full API.

The programmatic API exposes the same runtime without custom elements:

```ts
import { createLiveMdEditor } from "@codemirror-treesitter/live-md";

const editor = createLiveMdEditor({
  parent: document.body,
  placeholder: "Start writing...",
});

await editor.ready;
```

## What This Project Implements

- A Tree-sitter-backed replacement for the CodeMirror language layer, including
  `Language`, `LanguageSupport`, `LRLanguage`, `ParseContext`, syntax tree
  wrappers, Tree-sitter query wrappers, language data facets, mixed-language
  parsing, highlighting, indentation, folding, bracket matching, bidi isolates,
  and stream-parser compatibility.
- A language-data registry that mirrors CodeMirror language metadata while
  lazily loading Tree-sitter WASM grammars and highlight queries.
- Lezer-free implementations of CodeMirror commands, autocompletion, close
  brackets, basic setup, merge views, LSP integration, and Gruvbox themes.
- LiveMD, a Markdown editor runtime built from the local Tree-sitter packages,
  exposed through `createLiveMdEditor()`, `liveMarkdown()`,
  `defineLiveMdEditor()`, and `<live-md-editor>`.
- Optional LiveMD collaboration bindings for Loro documents, presence, custom
  text containers, and collaborative undo/redo.
- Validation tooling and apps that check public export parity, package
  dependency boundaries, language-data coverage, example coverage, benchmark
  coverage, and runtime behavior against official CodeMirror/Lezer packages.

The implementation packages intentionally do not depend on Lezer. The examples
app is the comparison surface and is allowed to depend on official CodeMirror
and Lezer packages so it can compare local behavior with upstream behavior side
by side.

## Architecture

The workspace keeps the official CodeMirror editor primitives where Lezer is
not part of the contract: `@codemirror/state`, `@codemirror/view`,
`@codemirror/search`, and `@codemirror/lint` are used directly. The packages in
this repository replace the language-aware layers above those primitives.

1. **Tree-sitter language runtime**:
   `@codemirror-treesitter/language` adapts `web-tree-sitter` into
   CodeMirror's language interfaces. It owns parser scheduling, incremental
   parsing, syntax-tree wrappers, Tree-sitter query execution, nested parsing,
   syntax highlighting, indentation, folding, bracket matching, bidi isolation,
   and stream-parser support.
2. **Language registry**:
   `@codemirror-treesitter/language-data` builds `LanguageDescription` entries
   on top of the language runtime. Each entry owns aliases, filename and
   extension metadata, WASM grammar loading, optional highlight-query loading,
   language data, and nested parser setup.
3. **Editor feature packages**:
   `commands`, `autocomplete`, `merge`, and `lsp-client` reimplement the
   CodeMirror feature packages that need syntax information. They depend on the
   local language runtime instead of `@codemirror/language` or Lezer.
4. **Assembly and styling**:
   `basic-setup` assembles a CodeMirror setup from local feature packages, and
   `theme-gruvbox` provides editor themes and highlight styles using local
   highlight tags.
5. **Product surface**:
   `live-md` composes the local packages into a Markdown editor with live block
   widgets, code-fence highlighting, KaTeX and Mermaid rendering, Shadow DOM
   web component integration, persistence, selection APIs, and benchmark
   fixtures.
6. **Collaboration surface**:
   `live-md-loro` provides optional CRDT bindings, and `apps/collab-editor`
   hosts a shareable collaborative editor with Cloudflare Durable Objects and
   WebSocket transport.

## Workspace Structure

| Path              | Purpose                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `package.json`    | Private Bun/Vite+ workspace, catalog versions, root scripts, and engine constraints.                  |
| `vite.config.ts`  | Shared Vite+ config for aliases, formatting, linting, type-aware checks, and run caching.             |
| `vite.shared.ts`  | Workspace import aliases used by packages and apps during local development.                          |
| `tsconfig*.json`  | Shared TypeScript settings for package and app builds.                                                |
| `packages/*`      | Published `@codemirror-treesitter/*` implementation packages.                                         |
| `apps/*`          | Local browser, benchmark, comparison, demo, and Cloudflare collaboration apps.                        |
| `tools/audit.mjs` | Repository audit for package names, Lezer-free boundaries, upstream parity, coverage, and app wiring. |
| `bun.lock`        | Bun lockfile generated by `vp install`.                                                               |

## Packages

| Directory                | Package                                | Role                                                                                                                            |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/language`      | `@codemirror-treesitter/language`      | Tree-sitter parser, query, and CodeMirror-compatible language infrastructure.                                                   |
| `packages/language-data` | `@codemirror-treesitter/language-data` | Lazy language metadata, Tree-sitter WASM loading, highlight-query loading, and mixed-language parser wiring.                    |
| `packages/commands`      | `@codemirror-treesitter/commands`      | Cursor movement, selection, deletion, indentation, commenting, history, and keymaps.                                            |
| `packages/autocomplete`  | `@codemirror-treesitter/autocomplete`  | Completion contexts, sources, results, tooltip UI, filtering, snippets, word completion, and close brackets.                    |
| `packages/codemirror`    | `@codemirror-treesitter/basic-setup`   | `basicSetup` and `minimalSetup` assembled from the local Tree-sitter packages.                                                  |
| `packages/theme-gruvbox` | `@codemirror-treesitter/theme-gruvbox` | Gruvbox dark/light editor themes, highlight styles, combined extensions, and palettes.                                          |
| `packages/merge`         | `@codemirror-treesitter/merge`         | Diff, split merge view, unified merge view, chunks, and accept/reject commands.                                                 |
| `packages/lsp-client`    | `@codemirror-treesitter/lsp-client`    | LSP client, workspace mapping, diagnostics, completions, hover, formatting, rename, definition, references, and signature help. |
| `packages/live-md`       | `@codemirror-treesitter/live-md`       | Live Markdown editor runtime, web component, registration entry, fixtures, and CSS export.                                      |
| `packages/live-md-loro`  | `@codemirror-treesitter/live-md-loro`  | Optional Loro collaboration bindings for LiveMD documents, presence, custom text containers, and collaborative undo/redo.       |

Each package directory has its own README with local responsibilities, public
entry points, dependency boundaries, source layout, and validation notes.

## Apps and Tools

- `apps/basic-editor`: Minimal Tree-sitter-only editor that imports
  `@codemirror-treesitter/live-md/register` and renders one
  `<live-md-editor>` element.
- `apps/examples`: Side-by-side workbench comparing the local Tree-sitter
  implementation with official CodeMirror/Lezer behavior on parser-relevant
  examples, package coverage, merge/LSP behavior, and benchmark metrics.
- `apps/live-md-benchmark`: LiveMD performance benchmark harness for rendering,
  editing, deletion, clipboard, and selection workflows.
- `apps/live-md-loro-demo`: Two-peer LiveMD collaboration demo with simulated
  latency, offline queueing, and Loro snapshot resync.
- `apps/collab-editor`: Cloudflare Workers app with a Durable Object room,
  WebSocket Loro sync, local snapshot recovery, shareable room URLs, and
  deployment/types tasks through Wrangler.
- `tools/audit.mjs`: Repository audit that checks package names, Lezer-free
  guarantees, public export parity, command and autocomplete stubs, basic setup
  parity, language-data metadata/load coverage, example coverage, merge/LSP
  usage, and benchmark app wiring.

## Web Component

The `<live-md-editor>` custom element wraps a Tree-sitter-backed CodeMirror
Markdown editor in Shadow DOM. Import the register entry point once, then use
the element anywhere in your HTML.

```ts
import "@codemirror-treesitter/live-md/register";
import "@codemirror-treesitter/live-md/style.css";
```

### Attributes

| Attribute       | Type    | Description                                                                    |
| --------------- | ------- | ------------------------------------------------------------------------------ |
| `autofocus`     | boolean | Focus the editor when it connects to the DOM.                                  |
| `default-value` | string  | Initial Markdown content. If omitted, trimmed light-DOM `textContent` is used. |
| `persist-key`   | string  | `localStorage` key for persisting editor content.                              |
| `placeholder`   | string  | Placeholder text when the editor is empty.                                     |
| `readonly`      | boolean | Disable editing while keeping content selectable/readable.                     |

### Properties

| Property         | Type                 | Description                                                  |
| ---------------- | -------------------- | ------------------------------------------------------------ |
| `value`          | `string`             | Current Markdown content, read/write.                        |
| `defaultValue`   | `string`             | Initial content, read/write.                                 |
| `persistKey`     | `string \| null`     | `localStorage` key, read/write.                              |
| `placeholder`    | `string`             | Placeholder text, read/write.                                |
| `readOnly`       | `boolean`            | Whether the editor is read-only, read/write.                 |
| `dirty`          | `boolean`            | Whether content has changed since `markClean()`.             |
| `selectionStart` | `number`             | Selection anchor position, read/write.                       |
| `selectionEnd`   | `number`             | Selection head position, read/write.                         |
| `view`           | `EditorView \| null` | The underlying CodeMirror `EditorView` instance.             |
| `extensions`     | `Extension`          | Optional CodeMirror extensions configured from JavaScript.   |
| `ready`          | `Promise<void>`      | Resolves after Markdown and code-fence languages are loaded. |

### Methods

| Method                          | Description                                       |
| ------------------------------- | ------------------------------------------------- |
| `focus()`                       | Focus the editor.                                 |
| `blur()`                        | Blur the editor.                                  |
| `markClean()`                   | Mark current content as clean, resetting `dirty`. |
| `setSelectionRange(start, end)` | Programmatically set the selection range.         |
| `select()`                      | Select all content.                               |

### Events

| Event           | Detail      | Description                                                   |
| --------------- | ----------- | ------------------------------------------------------------- |
| `input`         | -           | Fires on every content change and bubbles through Shadow DOM. |
| `change`        | -           | Fires after blur when content changed since the last blur.    |
| `live-md-ready` | `{ view }`  | Fires when async editor setup completes.                      |
| `live-md-error` | `{ error }` | Fires if editor initialization or async setup fails.          |
| `select`        | -           | Fires when the selection changes through user selection APIs. |

### CSS Custom Properties

The editor styles are installed into the Shadow DOM and can be themed with CSS
custom properties on the host element.

| Property                | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `--live-md-bg`          | Editor background.                                             |
| `--live-md-text`        | Primary text color.                                            |
| `--live-md-muted`       | Secondary text and widget label color.                         |
| `--live-md-accent`      | Primary accent for links, checks, focus, and Mermaid defaults. |
| `--live-md-accent-2`    | Secondary accent used by the caret and emphasis details.       |
| `--live-md-border`      | Border color for widgets and block surfaces.                   |
| `--live-md-code-bg`     | Code block and inline-code background.                         |
| `--live-md-code-text`   | Code text color.                                               |
| `--live-md-code-muted`  | Code gutter/header muted color.                                |
| `--live-md-code-border` | Code block border color.                                       |
| `--live-md-font-body`   | Markdown body font stack.                                      |
| `--live-md-font-ui`     | UI and widget label font stack.                                |
| `--live-md-font-code`   | Code font stack.                                               |
| `--live-md-mermaid-*`   | Optional Mermaid-specific color and font overrides.            |

## Programmatic API

```ts
import { createLiveMdEditor } from "@codemirror-treesitter/live-md";

const controller = createLiveMdEditor({
  parent: document.body,
  defaultValue: "# Draft",
  linkBaseUrl: "https://docs.example/notes/current.md",
  placeholder: "Start writing...",
  persistKey: "draft",
  onChange({ value }) {
    console.log(value);
  },
});

await controller.ready;
controller.setReadOnly(false);
controller.setValue("# Updated");
controller.destroy();
```

`createLiveMdEditor()` accepts `value`, `doc`, `defaultValue`, `persistKey`,
`placeholder`, `readOnly`, `autofocus`, `focus`, `root`, `extensions`,
`linkBaseUrl`, `onChange`, and `onBlur`. `linkBaseUrl` is used to resolve
relative Markdown links for Shift-click link jumps. The controller exposes
`view`, `value`, `ready`, `setValue()`, `setExtensions()`, `setPersistKey()`,
`setPlaceholder()`, `setReadOnly()`, and `destroy()`.

## Optional Loro Collaboration

Install `@codemirror-treesitter/live-md-loro` when a LiveMD editor should bind
to a Loro CRDT document. The default LiveMD package does not import Loro.

```ts
import { createLiveMdEditor } from "@codemirror-treesitter/live-md";
import { liveMdLoroCollaboration } from "@codemirror-treesitter/live-md-loro";
import { LoroDoc } from "loro-crdt";

const doc = new LoroDoc();
doc.getText("markdown").insert(0, "# Shared document");
doc.commit();

createLiveMdEditor({
  parent: document.body,
  extensions: [liveMdLoroCollaboration({ doc })],
});
```

Web Component users opt in through the JavaScript-only `extensions` property:

```ts
const editor = document.createElement("live-md-editor");
editor.extensions = [liveMdLoroCollaboration({ doc })];
document.body.append(editor);
```

The collaboration helper also supports custom Loro text containers, presence
through `EphemeralStore`, and optional Loro undo managers.

## Implementation Notes

- Tree-sitter incremental reparsing edits the previous `Tree` with CodeMirror
  change data and passes the edited tree back into `Parser.parse(...)`.
- Parsing honors CodeMirror-style time budgets through Tree-sitter's
  `progressCallback`, allowing large parses to stop and resume.
- Mixed-language parsing uses Tree-sitter `includedRanges` for nested regions.
  HTML and Vue currently nest JavaScript in `<script>` blocks and CSS in
  `<style>` blocks, and nested parser sources can defer async parser loads via
  `ParseContext.getSkippingParser(...)`.
- `language-data` lazy-loads grammar WASM files and published highlight
  queries, so `LanguageDescription.load()` only resolves assets needed for the
  selected language.
- The syntax tree wrapper preserves CodeMirror-facing names such as `Tree`,
  `SyntaxNode`, `NodeType`, and `TreeCursor`, while exposing
  Tree-sitter-backed navigation, status, field, descendant, and error helpers.
- `HighlightStyle`, `syntaxHighlighting`, `tags`, and `tagHighlighter` are
  implemented locally and map Tree-sitter capture names into CodeMirror-style
  highlight tags.
- Indentation, folding, bracket matching, bidi isolates, comment tokens, and
  stream-parser language support are implemented without Lezer.
- Some upstream `language-data` entries that only have legacy stream modes are
  covered with compact in-repo grammar/style shims.
- `collab-editor` persists Durable Object snapshots and uses client-side local
  snapshots so a generated room can recover local work before the first server
  snapshot is received.

## Parity Targets

The goal is source-compatible behavior for the CodeMirror surfaces this
workspace reimplements, not identical internals. `tools/audit.mjs` enforces the
main contract:

- `@codemirror-treesitter/language` exports every public name from upstream
  `@codemirror/language`'s index and exposes local Tree-sitter highlight
  helpers.
- `@codemirror-treesitter/commands` exports every public name from upstream
  `@codemirror/commands`, `comment`, and `history`, and does not leave known
  no-op command placeholders.
- `@codemirror-treesitter/autocomplete` exports every public name from upstream
  `@codemirror/autocomplete`, and does not leave known completion-context
  placeholders.
- `@codemirror-treesitter/basic-setup` matches upstream `basicSetup`,
  `minimalSetup`, and basic keymap ordering.
- `@codemirror-treesitter/language-data` mirrors upstream language metadata and
  all built language entries load a parser.
- `@codemirror-treesitter/theme-gruvbox` exports both dark and light Gruvbox
  themes and imports syntax highlighting from the local Tree-sitter language
  package.
- `@codemirror-treesitter/merge` and
  `@codemirror-treesitter/lsp-client` expose upstream-compatible public
  surfaces and use the local Tree-sitter language/highlighting packages.
- Parser-relevant official examples are implemented in `apps/examples` or
  explicitly classified as out of scope.

## Development

Use Vite+ from the workspace root:

```bash
vp install
vp check
vp test
vp run -r test
vp run -r build
vp run audit
```

The root script `vp run ready` runs the full local validation path:

```bash
vp run ready
```

Useful task selectors:

```bash
vp run @codemirror-treesitter/language#test
vp run @codemirror-treesitter/live-md#build
vp run examples#dev
vp run live-md-benchmark#benchmark
vp run live-md-loro-demo#dev
vp run collab-editor#dev
vp run collab-editor#types
```

`vp run` with no task lists all available package and app tasks.

## Documentation Map

- `AGENTS.md`: contributor and coding-agent workflow, stack snapshot,
  validation expectations, package boundaries, and app task notes.
- `packages/*/README.md`: package-local API, source layout, dependencies, and
  validation commands.
- `packages/live-md-loro/README.md`: optional collaboration binding docs.
- This README: repository-level architecture, workspace structure, apps, and
  LiveMD web component/API reference.
