# @codemirror-treesitter/language-data

Tree-sitter-backed language metadata for the CodeMirror Tree-sitter runtime.
This package mirrors the shape of CodeMirror language-data while loading
Tree-sitter grammars and highlight queries instead of Lezer language packages.

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
  folding props through the local `@codemirror-treesitter/language` package.
- Wire mixed-language parsing for entries such as HTML, Vue, and Markdown
  inline regions.
- Provide compact in-repo grammar/style shims for upstream entries that do not
  have a direct published Tree-sitter grammar.

## Public Entry

```ts
import { languages } from "@codemirror-treesitter/language-data";

const markdown = languages.find((language) => language.name == "Markdown");
const support = await markdown?.load();
```

The root entry point is `src/index.ts`, and the package exports only `.` and
`./package.json`.

## Asset Model

`vite.config.ts` copies `src/wasm` into the built package. Source code also
uses `?url` and `?raw` imports for grammar WASM files and highlight queries
provided by dependencies. The loader helpers choose the correct path for
browser-like runtimes, Vite local development, and Node-based tests/builds.

## Relationship to Other Packages

This package depends on `@codemirror-treesitter/language` and returns
`LanguageSupport` objects built from `TreeSitterLanguage`. It is consumed by
apps, examples, LiveMD, and any caller that wants a registry of language
loaders.

## Validation

Run from the workspace root:

```bash
vp check
vp run -r test
vp run audit
```

The audit checks metadata parity with upstream language-data and verifies that
all built language entries load.
