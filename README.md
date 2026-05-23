# CodeMirror Tree-sitter

Lezer-free CodeMirror 6 packages backed by Tree-sitter. This workspace
reimplements the editor-facing pieces needed to run a CodeMirror setup with
`web-tree-sitter` while keeping the packages under a separate
`@codemirror-treesitter/*` scope so they can be installed beside the official
CodeMirror packages.

The implementation packages intentionally do not depend on Lezer. The examples
app does install the official CodeMirror and Lezer packages so it can compare
the local Tree-sitter behavior against the original implementation.

## Packages

| Package                                | Scope                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@codemirror-treesitter/language`      | Tree-sitter parser integration plus the CodeMirror language surface: `Language`, `LanguageSupport`, `LanguageDescription`, `LRLanguage`, `ParseContext`, syntax tree access, tree/node/cursor wrappers, language data facets, mixed-language parsing, highlighting, indentation, folding, bracket matching, bidi isolation, and `StreamLanguage`. |
| `@codemirror-treesitter/language-data` | CodeMirror language metadata backed by lazy Tree-sitter WASM and highlight-query loading. The built package currently exposes 146 language entries and mirrors upstream aliases, extensions, and filename matching, with a few compatible extras.                                                                                                 |
| `@codemirror-treesitter/commands`      | A local reimplementation of the public `@codemirror/commands` surface, including cursor movement, selection commands, multiple cursors, deletion, line moving/copying, indentation, tab focus mode, commenting, history, and the standard/default/emacs/history keymaps.                                                                          |
| `@codemirror-treesitter/autocomplete`  | Local autocomplete and close-bracket infrastructure: completion contexts/sources/results, completion state, tooltip rendering, filtering, completion commands and keymaps, snippets, word completion, close brackets, and bracket-pair deletion.                                                                                                  |
| `@codemirror-treesitter/basic-setup`   | Local `basicSetup` and `minimalSetup` assembled from the Tree-sitter packages, with extension and keymap ordering checked against upstream `codemirror`.                                                                                                                                                                                          |
| `@codemirror-treesitter/theme-gruvbox` | Lezer-free Gruvbox editor themes for CodeMirror, exporting dark and light editor themes, highlight styles, combined extensions, and reusable color palettes.                                                                                                                                                                                      |

## Apps and Tools

- `apps/basic-editor` is a small Tree-sitter-only editor that loads
  `@codemirror-treesitter/basic-setup` and `language-data`.
- `apps/examples` is a side-by-side workbench for parser-relevant official
  CodeMirror examples. Each implemented example renders a local Tree-sitter
  editor and an official CodeMirror/Lezer editor, then reports behavior and
  latency comparisons.
- `tools/audit.mjs` checks package naming, Lezer-free implementation packages,
  public export parity, command stubs, basic setup parity, language-data
  metadata/load coverage, and example coverage.

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
cd apps/basic-editor
vp dev

cd apps/examples
vp dev
```

## Parity Targets

The goal is source-compatible behavior for the CodeMirror surfaces this
workspace reimplements, not identical internals. The audit currently enforces
these invariants:

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
