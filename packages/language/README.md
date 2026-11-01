# @codemirror-treesitter/language

Core CodeMirror-compatible language infrastructure backed by
`web-tree-sitter`. This package is the foundation for the workspace: it
replaces the Lezer-backed parts of `@codemirror/language` with Tree-sitter
parsers while keeping the public CodeMirror language surface.

## Stack and Boundaries

- Depends on `@codemirror/state`, `@codemirror/view`, `style-mod`, and
  `web-tree-sitter`.
- Works on unpatched upstream `web-tree-sitter@^0.26.9`: the package only
  calls the `TreeCursor.gotoFirstChildForIndex/Position` wasm shims after a
  runtime probe proves them correct (they are broken upstream). The workspace root
  still overrides `web-tree-sitter` to the vendored, patched runtime in
  `vendor/web-tree-sitter`, but the library no longer depends on that patch.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally does not depend on Lezer or `@codemirror/language`.
- Exports only `.` and `./package.json` from the built package.

## Responsibilities

- Load and configure Tree-sitter grammars through `TreeSitterParser`. Failed
  runtime initialization remains retryable while successful initialization is
  shared by later parsers.
- Expose CodeMirror language constructs such as `Language`,
  `LanguageSupport`, `LanguageDescription`, `LRLanguage`, `ParseContext`, and
  the `language` facet.
- Wrap Tree-sitter nodes and cursors with CodeMirror-facing `Tree`,
  `SyntaxNode`, `NodeType`, `NodeProp`, and cursor APIs.
- Expose low-level Tree-sitter query helpers for cached query compilation and
  capture collection over wrapped trees and nodes. Public query `from`/`to`
  ranges use document UTF-16 offsets, converted to native byte ranges internally.
  An explicit `to: 0` returns no results; equal nonzero bounds retain native
  point-query behavior.
- Maintain incremental parsing, parse scheduling, viewport-aware parsing, and
  syntax-tree availability helpers. The configured outer language metadata
  remains available while the initial syntax tree is pending. Edits that interrupt
  root or nested parsing retain the edited complete tree as their incremental base
  and accumulate dirty ranges until parsing finishes, including across insertions
  and deletions.
- Support nested parsing through included ranges and
  `TreeSitterParser.getSkippingParser(...)` for async parser loading. Nested
  parser sources may return one merged range list or an iterable of grouped
  range lists when a grammar needs separate nested trees per region. Group
  iterables are consumed incrementally across parse work slices and closed when
  a suspended parse is reset.
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
- `tests/setup.ts`: installs the test asset resolver for Vite `/@fs/` URLs.
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
- `firstChildForIndex(...)` and `firstChildForPosition(...)` (and the
  `moveTo`, `enter`, `resolve`, and ranged-iteration paths built on them) use
  the native range-navigation shims only after a one-time runtime probe shows
  they agree with `Node.firstChildForIndex(...)`; upstream 0.26.9's shims fail
  that probe, and the cursor then scans children with `gotoFirstChild` plus
  `gotoNextSibling` in JavaScript. Success means the cursor moved to the first
  child ending after the target, and `parent()` returns to the original parent
  after a successful jump. The JavaScript scan is linear in preceding siblings
  (about 1 ms per 5,000 siblings), so very flat trees are slower on an
  unpatched runtime.
- `resolve`, `resolveInner`, `resolveStack`, `cursorAt`, `moveTo`, and `enter`
  follow Lezer `side` semantics: `-1` also enters nodes ending at the
  position, `1` also enters nodes starting at it, and `0` only enters nodes
  that strictly contain it. Nested-tree lookup (`nestedAt`) keeps accepting
  both range boundaries for side `0`.
- Range-navigation hot paths such as `Tree.iterate(...)`, `Tree.cursorAt(...)`,
  `TreeCursor.moveTo(...)`, `TreeCursor.enter(...)`, and LiveMD leaf walks must
  not materialize `SyntaxNode.children`, `SyntaxNode.namedChildren`, or scan
  large sibling lists from the beginning.

## Parsing and Highlighting Behavior

- Tree-sitter cannot yield partial trees. When a reparse misses its time
  budget, the parse context keeps the previous tree, edited to match the new
  document, as its incremental base, and `syntaxTree(state)` returns that
  edited tree until the new one is committed (so highlighting, folding,
  indentation, and bracket matching keep working). Further edits during that
  window edit the same base again instead of dropping it.
  `syntaxTreeAvailable` and `ensureSyntaxTree` still report only committed
  trees. Stream languages publish no tree during the window; the highlighter
  then keeps its previous decorations mapped through the edits.
- `syntaxTreeChangedRanges(tr)` reuses the edit the parse context already made
  for the transaction (and diffs it against the committed tree once) instead of
  editing the old tree again.
- Highlight-query precedence: when several patterns capture the same node,
  the capture from the pattern that appears last in the query wins (Neovim
  semantics; later, more specific patterns refine earlier generic ones).
  Captures from that winning pattern are combined; capture names that map to
  no tag are ignored. Queries run only over the requested range (converted to
  native byte offsets) and the result is cached per tree and range. Nested
  trees that do not intersect the
  range are not queried.
- Grammars without a highlight query fall back to node-name heuristics over
  underscore-separated name segments (for example `template_string` is a
  string, while `template_substitution` and `*_expression` containers get no
  literal tag). Expect coarser highlighting for those grammars.
- `StreamLanguage` keeps tokenizer progress per document across work slices,
  so documents larger than one slice finish parsing; edits reuse the tokens
  and per-line states of every line before the first change, and indentation
  reads the cached per-line states instead of re-tokenizing from line 1.

## Grammar Assets

`TreeSitterParser.load(url, config)` passes string URLs through an asset
resolver before loading them. The default is the identity; install one with
`TreeSitterParser.setAssetResolver(resolver)` or pass `config.resolveAsset`
for one call (for example to map Vite `/@fs/` URLs to file paths under Node;
this package's own test setup does that in `tests/setup.ts`). Each resolved
URL is loaded once and the `Language` is shared by every parser created from
it.

## Native Resource Lifetime

- Package-owned cursors are always deleted, including early returns and thrown
  traversal callbacks. A cursor returned directly to a caller still follows the
  `TreeCursor` ownership contract above.
- Wrapped native trees are reference-counted across temporary and published
  wrappers. Incremental-edit copies that were never published are deleted
  once a new tree is committed and its changed ranges are read (or the
  context is superseded); any tree that was ever returned by `syntaxTree` is
  released when its wrapper becomes unreachable, because other states and
  plugins may still hold it. The finalization registry is only a safety net. Call
  `Tree.delete()` when an exclusively owned published tree graph can be
  released earlier. Incremental reuse creates independent wrappers for shared
  native trees, and repeated calls are safe.
- `TreeSitterParser.parse(...)` deletes its one-shot native parser before it
  returns. Editor parse contexts share one native root parser per lineage
  (every context derived from one `ParseContext.create`), reset between
  parses; it is deleted when the language is switched and when the view is
  destroyed, and recreated lazily if an older state parses again. Nested
  parsers are created per build and deleted when the build commits. Callers
  that create a `ParseContext` directly may call `destroy()` when finished.
- Compiled queries live with their `TreeSitterParser`. Call
  `clearQueryCache()` to release both cached helper queries and the highlight
  query immediately; the highlight query is recreated lazily if used again.

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
checksums before the language tests run Gate A (the native-cursor Gate A
tests exercise the vendored runtime; the package code itself does not use
those native methods). The audit checks that this
package exposes the upstream `@codemirror/language` public names and that
Tree-sitter highlight helpers are available.

`TreeSitterParser.startTreeBuild(nativeTree, doc, oldTree?, nestedParsers?)`
provides resumable nested-tree wrapping for callers with their own parse scheduling.
Call `work(shouldStop)` until it returns a `Tree`, or `cancel()` before discarding
unfinished work. The builder owns the input native tree until completion transfers
ownership to the returned wrapper. A caller-provided nested-parser map remains
caller-owned and must be deleted when its session ends.

## License and attribution

This package is a derivative work of [`@codemirror/language`](https://github.com/codemirror/language) and, for the `NodeProp`/`Tree` API in `src/tree.ts`, [`@lezer/common`](https://github.com/lezer-parser/common) by Marijn Haverbeke and others,
distributed under the MIT License. The upstream copyright notice is retained
alongside the project copyright in [`LICENSE`](./LICENSE). See the root
[`NOTICE.md`](../../NOTICE.md) for the full list of derived components.
