# @codemirror-treesitter/lsp-client

Language Server Protocol client integration for the CodeMirror Tree-sitter
build. This package tracks the public surface of `@codemirror/lsp-client` and
uses the local language and autocomplete packages.

## Responsibilities

- Manage JSON-message LSP transport through `LSPClient`.
- Connect editor views to a server through `LSPPlugin` and workspace file
  tracking.
- Map positions and document changes between CodeMirror offsets and LSP
  `{ line, character }` positions.
- Provide extensions for server completions, hover tooltips, diagnostics,
  formatting, rename, go-to-definition/declaration/type-definition/
  implementation, references, and signature help.
- Render Markdown returned by servers, with optional sanitizer and code
  highlighting through local Tree-sitter language support.
- Bundle common LSP extensions through `languageServerExtensions()`.

## Public Entry

```ts
import {
  LSPClient,
  LSPPlugin,
  languageServerExtensions,
  serverCompletion,
} from "@codemirror-treesitter/lsp-client";
```

The root entry point is `src/index.ts`; feature modules live in `completion`,
`hover`, `diagnostics`, `formatting`, `rename`, `definition`, `references`, and
`signature`.

## Relationship to Other Packages

This package depends on `@codemirror-treesitter/language` and
`@codemirror-treesitter/autocomplete`, plus official CodeMirror state/view/lint
packages and `vscode-languageserver-protocol`. It intentionally avoids
`@codemirror/language`, `@codemirror/autocomplete`, and Lezer imports.

## Validation

Run from the workspace root:

```bash
vp check
vp run -r test
vp run audit
```

The audit checks upstream export parity and verifies that the implementation
uses the local Tree-sitter language and autocomplete packages.
