# CodeMirror Tree-sitter

CodeMirror Tree-sitter is a Lezer-free CodeMirror 6 workspace backed by
Tree-sitter (`web-tree-sitter`). It reimplements the editor-facing CodeMirror
packages that normally depend on Lezer and publishes them under the
`@codemirror-treesitter/*` scope so they can be installed beside the official
`@codemirror/*` packages.

The repository also contains LiveMD, a Tree-sitter-powered Markdown editor that
ships as both a web component and a programmatic editor API.

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
decorations, and Gruvbox theming. See the [Web Component](#web-component)
section for the full API.

Alternatively use the programmatic API:

```ts
import { createLiveMdEditor } from "@codemirror-treesitter/live-md";

const editor = createLiveMdEditor({ parent: document.body });
```

## What This Project Implements

- A Tree-sitter-backed replacement for the CodeMirror language layer, including
  `Language`, `LanguageSupport`, `LRLanguage`, `ParseContext`, syntax tree
  wrappers, language data facets, mixed-language parsing, highlighting,
  indentation, folding, bracket matching, bidi isolates, and stream-parser
  compatibility.
- A language-data registry that mirrors CodeMirror language metadata while
  lazily loading Tree-sitter WASM grammars and highlight queries.
- Lezer-free implementations of CodeMirror commands, autocompletion, close
  brackets, basic setup, merge views, LSP integration, and Gruvbox themes.
- LiveMD, a Markdown editor runtime built from the local Tree-sitter packages,
  exposed through `createLiveMdEditor()`, `liveMarkdown()`, and
  `<live-md-editor>`.
- Validation tooling and comparison apps that check public export parity,
  package dependency boundaries, language-data coverage, example coverage, and
  runtime behavior against official CodeMirror/Lezer packages.

The implementation packages intentionally do not depend on Lezer. The example
app depends on the official CodeMirror and Lezer packages only to compare local
behavior with upstream behavior side by side.

## Architecture

The workspace keeps the official CodeMirror editor primitives where Lezer is
not part of the contract: `@codemirror/state`, `@codemirror/view`,
`@codemirror/search`, and `@codemirror/lint` are used directly. The packages in
this repository replace the language-aware layers above those primitives.

1. **Tree-sitter language runtime**:
   `@codemirror-treesitter/language` adapts `web-tree-sitter` into CodeMirror's
   language interfaces. It owns parser scheduling, incremental parsing,
   syntax-tree wrappers, nested parsing, syntax highlighting, indentation,
   folding, bracket matching, bidi isolation, and stream-parser support.
2. **Language registry**:
   `@codemirror-treesitter/language-data` builds `LanguageDescription` entries
   on top of the language runtime. Each entry knows its aliases, filename and
   extension metadata, WASM grammar loader, optional highlight query, language
   data, and nested parser setup.
3. **Editor feature packages**:
   `commands`, `autocomplete`, `merge`, and `lsp-client` reimplement the
   CodeMirror feature packages that need syntax information. They depend on the
   local language runtime instead of `@codemirror/language` or Lezer.
4. **Assembly and styling**:
   `basic-setup` assembles a CodeMirror setup from the local feature packages,
   and `theme-gruvbox` provides editor themes and highlight styles using the
   local highlight tags.
5. **Product surface**:
   `live-md` composes the local packages into a Markdown editor with live block
   widgets, code-fence highlighting, KaTeX and Mermaid rendering, Shadow DOM web
   component integration, persistence, selection APIs, and benchmark fixtures.

## Packages

| Directory                | Package                                | Role                                                                                                                                                         |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/language`      | `@codemirror-treesitter/language`      | Tree-sitter parser integration and CodeMirror-compatible language infrastructure.                                                                            |
| `packages/language-data` | `@codemirror-treesitter/language-data` | Lazy language metadata, Tree-sitter WASM loading, highlight-query loading, and mixed-language parser wiring.                                                 |
| `packages/commands`      | `@codemirror-treesitter/commands`      | Cursor movement, selection, deletion, indentation, commenting, history, and keymaps.                                                                         |
| `packages/autocomplete`  | `@codemirror-treesitter/autocomplete`  | Completion contexts, sources, results, tooltip UI, filtering, snippets, word completion, and close brackets.                                                 |
| `packages/codemirror`    | `@codemirror-treesitter/basic-setup`   | `basicSetup` and `minimalSetup` assembled from the local Tree-sitter packages.                                                                               |
| `packages/theme-gruvbox` | `@codemirror-treesitter/theme-gruvbox` | Gruvbox dark/light editor themes, highlight styles, combined extensions, and palettes.                                                                       |
| `packages/merge`         | `@codemirror-treesitter/merge`         | Diff, split merge view, unified merge view, chunks, and accept/reject commands.                                                                              |
| `packages/lsp-client`    | `@codemirror-treesitter/lsp-client`    | Language Server Protocol client, plugin, workspace mapping, diagnostics, completions, hover, formatting, rename, definition, references, and signature help. |
| `packages/live-md`       | `@codemirror-treesitter/live-md`       | Live Markdown editor runtime, web component, registration entry, fixtures, and CSS export.                                                                   |
| `packages/live-md-loro`  | `@codemirror-treesitter/live-md-loro`  | Optional Loro collaboration bindings for LiveMD documents, presence, and collaborative undo.                                                                 |

Each package directory has its own README with its local responsibilities,
public entry points, and relationship to the rest of the workspace.

## Web Component

The `<live-md-editor>` custom element wraps a Tree-sitter-backed CodeMirror
Markdown editor in Shadow DOM. Import the register entry point once, then use
the element anywhere in your HTML.

### Attributes

| Attribute       | Type    | Description                                                          |
| --------------- | ------- | -------------------------------------------------------------------- |
| `autofocus`     | boolean | Focus the editor when it connects to the DOM.                        |
| `default-value` | string  | Initial Markdown content (reads light-DOM `textContent` if not set). |
| `persist-key`   | string  | localStorage key for persisting editor content.                      |
| `placeholder`   | string  | Placeholder text when the editor is empty.                           |
| `readonly`      | boolean | Disable editing while keeping content selectable/readable.           |

### Properties

| Property         | Type                 | Description                                                |
| ---------------- | -------------------- | ---------------------------------------------------------- |
| `value`          | `string`             | Current Markdown content (read/write).                     |
| `defaultValue`   | `string`             | Initial content (read/write).                              |
| `persistKey`     | `string \| null`     | localStorage key (read/write).                             |
| `placeholder`    | `string`             | Placeholder text (read/write).                             |
| `readOnly`       | `boolean`            | Whether editor is read-only (read/write).                  |
| `dirty`          | `boolean`            | Whether content has changed since `markClean()`.           |
| `selectionStart` | `number`             | Selection anchor position.                                 |
| `selectionEnd`   | `number`             | Selection head position.                                   |
| `view`           | `EditorView \| null` | The underlying CodeMirror `EditorView` instance.           |
| `extensions`     | `Extension`          | Optional CodeMirror extensions configured from JavaScript. |

### Methods

| Method                          | Description                                     |
| ------------------------------- | ----------------------------------------------- |
| `focus()`                       | Focus the editor.                               |
| `blur()`                        | Blur the editor.                                |
| `markClean()`                   | Mark current content as clean (resets `dirty`). |
| `setSelectionRange(start, end)` | Programmatically set the selection range.       |
| `select()`                      | Select all content.                             |

### Events

| Event           | Detail      | Description                                            |
| --------------- | ----------- | ------------------------------------------------------ |
| `input`         | -           | Fires on every content change (bubbles, `InputEvent`). |
| `change`        | -           | Debounced change fired after blur.                     |
| `live-md-ready` | `{ view }`  | Fires when the editor finishes initializing.           |
| `live-md-error` | `{ error }` | Fires if editor initialization fails.                  |
| `select`        | -           | Fires when the selection changes.                      |

### CSS Custom Properties

| Property              | Description       |
| --------------------- | ----------------- |
| `--live-md-bg`        | Background color. |
| `--live-md-text`      | Text color.       |
| `--live-md-accent`    | Accent color.     |
| `--live-md-selection` | Selection color.  |

## Apps and Tools

- `apps/basic-editor`: Minimal Tree-sitter-only editor that loads
  `@codemirror-treesitter/live-md/register` and renders one
  `<live-md-editor>` element.
- `apps/examples`: Side-by-side workbench comparing the local Tree-sitter
  implementation with official CodeMirror/Lezer behavior on parser-relevant
  examples, package coverage, and benchmark metrics.
- `apps/live-md-benchmark`: LiveMD performance benchmark harness for rendering,
  editing, deletion, clipboard, and selection workflows.
- `apps/live-md-loro-demo`: Two-peer LiveMD collaboration demo with simulated
  latency, offline queueing, and Loro snapshot resync.
- `tools/audit.mjs`: Repository audit that checks package names, Lezer-free
  guarantees, public export parity, command and autocomplete stubs, basic setup
  parity, language-data metadata/load coverage, example coverage, merge/LSP
  usage, and benchmark app wiring.

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

## Implementation Notes

- Tree-sitter incremental reparsing edits the previous `Tree` with CodeMirror
  change data and passes the edited tree back into `Parser.parse(...)`.
- Parsing honors CodeMirror-style time budgets through Tree-sitter's
  `progressCallback`, allowing large parses to stop and resume.
- Mixed-language parsing uses Tree-sitter `includedRanges` for nested regions.
  HTML and Vue currently nest JavaScript in `<script>` blocks and CSS in
  `<style>` blocks, and nested parser sources can defer async parser loads via
  `ParseContext.getSkippingParser(...)`.
- `language-data` lazy-loads grammar WASM files and published highlight queries,
  so `LanguageDescription.load()` only resolves assets needed for the selected
  language.
- The syntax tree wrapper preserves CodeMirror-facing names such as `Tree`,
  `SyntaxNode`, `NodeType`, and `TreeCursor`, while exposing Tree-sitter-backed
  navigation, status, field, descendant, and error helpers.
- `HighlightStyle`, `syntaxHighlighting`, `tags`, and `tagHighlighter` are
  implemented locally and map Tree-sitter capture names into CodeMirror-style
  highlight tags.
- Indentation, folding, bracket matching, bidi isolates, comment tokens, and
  stream-parser language support are implemented without Lezer.
- Some upstream `language-data` entries that only have legacy stream modes are
  covered with compact in-repo grammar/style shims.

## Development

Use Vite+ from the workspace root:

```bash
vp install
vp check
vp run -r test
vp run -r build
vp run audit
```

The root script `vp run ready` runs the full local validation path:

```bash
vp run ready
```

Run the apps from their workspace directories:

```bash
cd apps/basic-editor && vp dev
cd apps/examples && vp dev
cd apps/live-md-benchmark && vp dev
```

## Parity Targets

The goal is source-compatible behavior for the CodeMirror surfaces this
workspace reimplements, not identical internals. The audit enforces:

- `@codemirror-treesitter/language` exports every public name from upstream
  `@codemirror/language`'s index.
- `@codemirror-treesitter/commands` exports every public name from upstream
  `@codemirror/commands`, `comment`, and `history`, and does not leave known
  no-op command placeholders.
- `@codemirror-treesitter/autocomplete` exports every public name from upstream
  `@codemirror/autocomplete`, and does not leave known completion-context
  placeholders.
- `@codemirror-treesitter/basic-setup` matches upstream `basicSetup` and
  `minimalSetup` extension sequences and basic keymap ordering.
- `@codemirror-treesitter/language-data` mirrors upstream language metadata and
  all built language entries load a parser.
- `@codemirror-treesitter/theme-gruvbox` exports both dark and light Gruvbox
  themes and imports syntax highlighting from the local Tree-sitter language
  package.
- `@codemirror-treesitter/merge` and
  `@codemirror-treesitter/lsp-client` expose upstream-compatible public
  surfaces and use the local Tree-sitter language/highlighting packages.
- Parser-relevant official examples are either implemented in `apps/examples`
  or explicitly classified as out of scope.
