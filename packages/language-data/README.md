# @codemirror-treesitter/language-data

Tree-sitter-backed language metadata for the CodeMirror Tree-sitter runtime.
This package mirrors the shape of CodeMirror language-data while loading
Tree-sitter grammars and highlight queries instead of Lezer language packages.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/language` plus published Tree-sitter
  grammar packages and bundled WASM assets.
- Built as an ES module package with Vite+ `vp pack`.
- Uses Vite URL/raw imports and copied `src/wasm` assets so language loaders
  work in browser-like runtimes, Vite dev, tests, and package builds.
- Intentionally returns local `LanguageSupport` objects and does not import
  Lezer language packages.

## Responsibilities

- Export the `languages` array of `LanguageDescription` objects.
- Preserve upstream-style language names, aliases, extensions, and filename
  matchers so `LanguageDescription.matchFilename(...)` and
  `LanguageDescription.matchLanguageName(...)` behave like CodeMirror users
  expect.
- Lazily load Tree-sitter WASM grammars from package assets, bundled local
  assets, or Vite URLs depending on the runtime.
- Lazily load published Tree-sitter highlight queries where available.
- Attach language data such as comments, indentation, close brackets, and
  folding props through the local language package.
- Wire mixed-language parsing for entries such as HTML, Vue, and Markdown
  inline regions. Generic Markdown streams one inline range group at a time so
  nested parsing can stop at its work budget without eagerly scanning every
  block.
- Expose an explicit Markdown parser service for LiveMD callers that need a
  block-only Markdown language plus a separate Markdown inline parser without
  using the generic nested Markdown language entry.
- Provide compact in-repo grammar/style shims for upstream entries that do not
  have a direct published Tree-sitter grammar.

## Public Entry

```ts
import { languages } from "@codemirror-treesitter/language-data";

const markdown = languages.find((language) => language.name == "Markdown");
const support = await markdown?.load();
```

LiveMD uses the focused `./live-md` entry when it needs to keep block and
inline parsing separate without pulling the full language registry (and all of
its grammar asset references) into an application build:

```ts
import {
  loadLiveMdCodeFenceLanguage,
  loadMarkdownParserService,
} from "@codemirror-treesitter/language-data/live-md";

const { blockLanguage, blockParser, inlineParser, inlineRanges } =
  await loadMarkdownParserService();

const typescript = await loadLiveMdCodeFenceLanguage("ts");
```

The root entry point is `src/index.ts`; `src/live-md.ts` is the focused
Markdown and code-fence entry. Code-fence grammars are fetched and compiled
individually when their aliases are requested, and failed loads remain
retryable.

## Source Layout

- `src/index.ts`: language registry, metadata, loaders, language data, and
  mixed-language setup.
- `src/live-md.ts`: standalone Markdown service and the small, alias-aware set
  of code-fence grammar loaders used by LiveMD.
- `src/markdown-inline-ranges.ts`: lazy Markdown inline range traversal and the
  eager compatibility collector used by the explicit parser service.
- `src/assets.d.ts`: Vite import declarations for WASM and raw query assets.
- `src/wasm/*`: bundled Tree-sitter WASM grammars used when no suitable
  package URL import is available.
- `tests/language-data.test.ts`: language metadata and loader coverage.
- `tests/markdown-inline-ranges.test.ts`: Markdown inline cursor traversal,
  bounded-range, laziness, cleanup, and legacy-query parity coverage.
- `tests/live-md-entry.test.ts`: focused entry, alias loading, and parser
  service coverage.

## Asset Model

`vite.config.ts` copies `src/wasm` into the built package. Source code also
uses `?url` and `?raw` imports for grammar WASM files and highlight queries
provided by dependencies. Loader helpers choose the correct path for
browser-like runtimes, Vite local development, and Node-based tests/builds.

## Relationship to Other Packages

This package depends on `@codemirror-treesitter/language` and returns
`LanguageSupport` objects built from `TreeSitterLanguage`. It is consumed by
apps, examples, LiveMD, and any caller that wants a registry of language
loaders.

## Current Implementation Notes

- `src/index.ts` is the registry implementation and contains roughly the full
  upstream-style language catalog, with local shims where published grammars or
  highlight queries are not directly available.
- Markdown inline runtime discovery uses cursor traversal in
  `src/markdown-inline-ranges.ts`; its exclusion query filters block
  continuations, while the injection query remains a legacy test oracle.
- `src/queries/raw-text.scm` selects JavaScript and CSS ranges nested in HTML
  and Vue documents.
- `src/wasm/*` contains bundled fallback grammars copied into the built package
  by `vite.config.ts`.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/language-data#check
vp run @codemirror-treesitter/language-data#test
vp run audit
```

The audit checks metadata parity with upstream language-data and verifies that
all built language entries load.
