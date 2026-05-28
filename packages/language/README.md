# @codemirror-treesitter/language

Core CodeMirror-compatible language infrastructure backed by
`web-tree-sitter`. This package is the foundation for the workspace: it
replaces the Lezer-backed parts of `@codemirror/language` with Tree-sitter
parsers while keeping the public CodeMirror language surface.

## Stack and Boundaries

- Depends on `@codemirror/state`, `@codemirror/view`, `style-mod`, and
  `web-tree-sitter`.
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
- Maintain incremental parsing, parse scheduling, viewport-aware parsing, and
  syntax-tree availability helpers.
- Support nested parsing through included ranges and
  `TreeSitterParser.getSkippingParser(...)` for async parser loading.
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
  syntaxHighlighting,
  syntaxTree,
  tags,
} from "@codemirror-treesitter/language";
```

The root entry point is `src/index.ts`.

## Source Layout

- `src/language.ts`: parser integration, language objects, parse context, tree
  access, nested parsing, and language data facets.
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

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/language#check
vp run @codemirror-treesitter/language#test
vp run audit
```

The audit checks that this package exposes the upstream
`@codemirror/language` public names and that Tree-sitter highlight helpers are
available.
