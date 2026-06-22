# @codemirror-treesitter/language

Core CodeMirror-compatible language infrastructure backed by
`web-tree-sitter`. This package is the foundation for the workspace: it
replaces the Lezer-backed parts of `@codemirror/language` with Tree-sitter
parsers while keeping the public CodeMirror language surface.

## Stack and Boundaries

- Depends on `@codemirror/state`, `@codemirror/view`, `style-mod`, and
  `web-tree-sitter`.
- Uses the root `web-tree-sitter` override, which currently resolves to the
  vendored runtime in `vendor/web-tree-sitter` for a cursor range navigation
  binding patch.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally does not depend on Lezer or `@codemirror/language`.
- Exports only `.` and `./package.json` from the built package.

## Responsibilities

- Load and configure Tree-sitter grammars through `TreeSitterParser`.
- Expose CodeMirror language constructs such as `Language`,
  `LanguageSupport`, `LanguageDescription`, `LRLanguage`, `ParseContext`, and
  the `language` facet.
- Wrap Tree-sitter nodes and cursors with CodeMirror-facing `Tree`,
  `SyntaxNode`, `NodeType`, `NodeProp`, and cursor APIs.
- Expose low-level Tree-sitter query helpers for cached query compilation and
  capture collection over wrapped trees and nodes.
- Maintain incremental parsing, parse scheduling, viewport-aware parsing, and
  syntax-tree availability helpers.
- Support nested parsing through included ranges and
  `TreeSitterParser.getSkippingParser(...)` for async parser loading. Nested
  parser sources may return one merged range list or grouped range lists when a
  grammar needs separate nested trees per region.
- Implement local highlighting tags, `HighlightStyle`,
  `syntaxHighlighting(...)`, `highlightTree(...)`, and
  `highlightCode(...)`.
- Implement indentation, folding, bracket matching, bidi isolation, and
  `StreamLanguage` compatibility without Lezer.

## Public Entry

```ts
import {
  HighlightStyle,
  LRLanguage,
  TreeSitterParser,
  ensureSyntaxTree,
  queryTreeMatches,
  queryTreeCaptures,
  syntaxHighlighting,
  syntaxTree,
  tags,
} from "@codemirror-treesitter/language";
```

The root entry point is `src/index.ts`.

## Source Layout

- `src/language.ts`: parser integration, language objects, parse context, tree
  access, query capture/match helpers, nested parsing, and language data facets.
- `src/tree.ts`: Tree-sitter-to-CodeMirror syntax tree wrappers.
- `src/highlight.ts` and `src/tags.ts`: highlight tags, style definitions, and
  decoration generation.
- `src/indent.ts`, `src/fold.ts`, `src/matchbrackets.ts`, and
  `src/isolate.ts`: editor features that consume syntax trees.
- `src/incremental.ts`: shared dirty-range and range-set patching helpers.
- `src/stream-parser.ts` and `src/stringstream.ts`: compatibility layer for
  stream-parser style languages.
- `tests/*`: parser, highlighting, indentation, folding, incremental parsing,
  isolate, and stream-parser coverage.

## Relationship to Other Packages

Every package that needs syntax information depends on this one. It is consumed
by `language-data`, `commands`, `autocomplete`, `basic-setup`, `merge`,
`lsp-client`, `theme-gruvbox`, `live-md`, and the apps.

## Current Implementation Notes

- `src/index.ts` re-exports the runtime surface from focused modules instead of
  defining behavior inline.
- `src/language.ts` owns Tree-sitter parser integration, query helpers,
  language facets, nested parser support, and syntax-tree availability.
- `src/tree.ts` provides CodeMirror-facing tree/node/cursor wrappers over
  Tree-sitter nodes.
- The tests include parser, tree, highlighting, indentation, folding,
  fold-gutter, bidi isolation, incremental range, and stream-parser coverage.

## TreeCursor Contract

`TreeCursor` wraps a native `web-tree-sitter` cursor and must preserve native
ownership rules:

- `copy()` returns an independent native cursor handle. Callers that create a
  copy must call `delete()` when they are done with it.
- `reset(node)` changes the native cursor root to that node. The old parent
  path is not recoverable after this call, so `parent()` cannot climb back to
  the node's former parent.
- `resetTo(cursor)` copies the full native cursor state, including root and
  parent path. Use it when a traversal needs to restore a cursor position
  without losing parent access.
- `firstChildForIndex(...)` and `firstChildForPosition(...)` delegate to the
  native Tree-sitter range navigation APIs. Success means the cursor moved to
  the same child that `SyntaxNode.firstChildForIndex(...)` would return, and
  `parent()` must return to the original parent after a successful jump.
- Range-navigation hot paths such as `Tree.iterate(...)`, `Tree.cursorAt(...)`,
  `TreeCursor.moveTo(...)`, `TreeCursor.enter(...)`, and LiveMD leaf walks must
  not materialize `SyntaxNode.children`, `SyntaxNode.namedChildren`, or scan
  large sibling lists from the beginning.

## Validation

Run from the workspace root:

```bash
vp run verify:web-tree-sitter
vp run @codemirror-treesitter/language#check
vp run @codemirror-treesitter/language#test
vp run audit
```

`verify:web-tree-sitter` replays the vendored cursor range navigation patch
against a clean `web-tree-sitter@0.26.9` package and checks the patched wasm
checksums before the language tests run Gate A. The audit checks that this
package exposes the upstream `@codemirror/language` public names and that
Tree-sitter highlight helpers are available.
