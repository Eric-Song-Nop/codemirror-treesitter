# CodeMirror Tree-sitter

## Quickstart

```html
<body>
  <live-md-editor autofocus placeholder="Start writing…"></live-md-editor>
  <script type="module">
    import "@codemirror-treesitter/live-md/register";
  </script>
</body>
```

A single import registers the `<live-md-editor>` web component with
Tree-sitter–powered Markdown parsing, syntax highlighting, and Gruvbox theming.
See the [Web Component](#web-component) section for the full API.

Alternatively use the programmatic API:

```ts
import { createLiveMdEditor } from "@codemirror-treesitter/live-md";

const editor = createLiveMdEditor({ parent: document.body });
```

---

Lezer-free CodeMirror 6 packages backed by Tree-sitter (`web-tree-sitter`).
This workspace reimplements the editor-facing pieces needed to run CodeMirror
while keeping the packages under a separate `@codemirror-treesitter/*` scope so
they can be installed beside the official `@codemirror/*` packages.

The implementation packages intentionally do not depend on Lezer. The examples
app depends on the official CodeMirror / Lezer packages for side-by-side
comparison.

## Packages

| Package                                | Scope                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@codemirror-treesitter/language`      | Tree-sitter parser integration plus the CodeMirror language surface: `Language`, `LanguageSupport`, `LanguageDescription`, `LRLanguage`, `ParseContext`, syntax tree access, tree/node/cursor wrappers, language data facets, mixed-language parsing, highlighting, indentation, folding, bracket matching, bidi isolation, and `StreamLanguage`. |
| `@codemirror-treesitter/language-data` | CodeMirror language metadata backed by lazy Tree-sitter WASM and highlight-query loading. The built package currently exposes 146 language entries and mirrors upstream aliases, extensions, and filename matching.                                                                                                                               |
| `@codemirror-treesitter/commands`      | Reimplementation of `@codemirror/commands`: cursor movement, selection, multiple cursors, deletion, line moving/copying, indentation, tab focus mode, commenting, history, and the standard/default/emacs/history keymaps.                                                                                                                        |
| `@codemirror-treesitter/autocomplete`  | Autocomplete and close-bracket infrastructure: completion contexts/sources/results, tooltip rendering, filtering, snippets, word completion, close brackets, and bracket-pair deletion.                                                                                                                                                           |
| `@codemirror-treesitter/basic-setup`   | `basicSetup` and `minimalSetup` assembled from the Tree-sitter packages, with extension and keymap ordering checked against upstream `codemirror`.                                                                                                                                                                                                |
| `@codemirror-treesitter/theme-gruvbox` | Gruvbox dark and light editor themes, highlight styles, combined extensions, and reusable color palettes.                                                                                                                                                                                                                                         |
| `@codemirror-treesitter/merge`         | Diff and merge views for CodeMirror: `MergeView`, `unifiedMergeView`, `acceptChunk`, `rejectChunk`, and `presentableDiff`.                                                                                                                                                                                                                        |
| `@codemirror-treesitter/lsp-client`    | Language Server Protocol client: completions, hover, diagnostics, formatting, rename, go-to-definition, references, and signature help.                                                                                                                                                                                                           |
| `@codemirror-treesitter/live-md`       | Live Markdown editor as both a `<live-md-editor>` web component and a `createLiveMdEditor()` programmatic API, built on the Tree-sitter CodeMirror stack.                                                                                                                                                                                         |

## Web Component

The `<live-md-editor>` custom element wraps a Tree-sitter–backed CodeMirror
Markdown editor in Shadow DOM. Import the register entry point once, then use
the element anywhere in your HTML.

### Attributes

| Attribute       | Type    | Description                                                          |
| --------------- | ------- | -------------------------------------------------------------------- |
| `autofocus`     | boolean | Focus the editor when it connects to the DOM.                        |
| `default-value` | string  | Initial Markdown content (reads light-DOM `textContent` if not set). |
| `persist-key`   | string  | localStorage key for persisting editor content.                      |
| `placeholder`   | string  | Placeholder text when the editor is empty.                           |
| `readonly`      | boolean | Disable editing (content remains selectable/readable).               |

### Properties

| Property         | Type           | Description                                      |
| ---------------- | -------------- | ------------------------------------------------ |
| `value`          | `string`       | Current Markdown content (read/write).           |
| `defaultValue`   | `string`       | Initial content (read/write).                    |
| `persistKey`     | `string\|null` | localStorage key (read/write).                   |
| `placeholder`    | `string`       | Placeholder text (read/write).                   |
| `readOnly`       | `boolean`      | Whether editor is read-only (read/write).        |
| `dirty`          | `boolean`      | Whether content has changed since `markClean()`. |
| `selectionStart` | `number`       | Selection anchor position.                       |
| `selectionEnd`   | `number`       | Selection head position.                         |
| `view`           | `EditorView`   | The underlying CodeMirror `EditorView` instance. |

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
| `input`         | —           | Fires on every content change (bubbles, `InputEvent`). |
| `change`        | —           | Debounced change fired after blur.                     |
| `live-md-ready` | `{ view }`  | Fires when the editor finishes initializing.           |
| `live-md-error` | `{ error }` | Fires if editor initialization fails.                  |
| `select`        | —           | Fires when the selection changes.                      |

### CSS Custom Properties

| Property              | Description       |
| --------------------- | ----------------- |
| `--live-md-bg`        | Background color. |
| `--live-md-text`      | Text color.       |
| `--live-md-accent`    | Accent color.     |
| `--live-md-selection` | Selection color.  |

## Apps and Tools

- **`apps/basic-editor`** — Minimal Tree-sitter–only editor loading
  `@codemirror-treesitter/live-md/register` as a single `<live-md-editor>` tag.
- **`apps/examples`** — Side-by-side workbench comparing Tree-sitter and official
  CodeMirror/Lezer behavior on parser-relevant examples, with behavior and
  latency reports.
- **`apps/live-md-benchmark`** — LiveMD performance benchmarks.
- **`tools/audit.mjs`** — Checks package naming, Lezer-free guarantees, public
  export parity, command stubs, basic setup parity, language-data metadata/load
  coverage, and example coverage.

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
vp run ready
vp run -r test
vp run -r build
vp run audit
```

`vp run ready` runs the full local validation path: check, recursive tests,
recursive builds, and the audit script.

Run the apps from their workspace directories:

```bash
cd apps/basic-editor && vp dev
cd apps/examples     && vp dev
```

## Parity Targets

The goal is source-compatible behavior for the CodeMirror surfaces this
workspace reimplements, not identical internals. The audit enforces:

- `@codemirror-treesitter/language` exports every public name from upstream
  `@codemirror/language`'s index.
- `@codemirror-treesitter/commands` exports every public name from upstream
  `@codemirror/commands`, `comment`, and `history`, and does not leave known
  no-op command placeholders.
- `@codemirror-treesitter/basic-setup` matches upstream `basicSetup` and
  `minimalSetup` extension sequences and basic keymap ordering.
- `@codemirror-treesitter/language-data` mirrors upstream language metadata and
  all built language entries load a parser.
- `@codemirror-treesitter/theme-gruvbox` exports both dark and light Gruvbox
  themes and imports syntax highlighting from the local Tree-sitter language
  package.
- Parser-relevant official examples are either implemented in `apps/examples`
  or explicitly classified as out of scope.
