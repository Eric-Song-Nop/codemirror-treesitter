# @codemirror-treesitter/lsp-client

Language Server Protocol client integration for the CodeMirror Tree-sitter
build. This package tracks the public surface of `@codemirror/lsp-client` and
uses the local language and autocomplete packages.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/language`,
  `@codemirror-treesitter/autocomplete`, official CodeMirror state/view/lint
  packages, `marked`, and `vscode-languageserver-protocol`.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally avoids `@codemirror/language`, `@codemirror/autocomplete`, and
  Lezer imports in implementation code.
- Exports only `.` and `./package.json` from the built package.

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

The root entry point is `src/index.ts`.

## Source Layout

- `src/client.ts`: LSP transport and request/notification handling.
- `src/plugin.ts`: editor plugin and server lifecycle integration.
- `src/workspace.ts`: document tracking and workspace file mapping.
- `src/pos.ts` and `src/text.ts`: CodeMirror/LSP position and text helpers.
- `src/completion.ts`, `src/hover.ts`, `src/diagnostics.ts`,
  `src/formatting.ts`, `src/rename.ts`, `src/definition.ts`,
  `src/references.ts`, and `src/signature.ts`: feature extensions.
- `src/theme.ts`: LSP UI styling.
- `tests/*`: position mapping and rendering coverage.

## Relationship to Other Packages

This package depends on local `language` and `autocomplete` for syntax-aware
features and completion UI. It is exercised in the examples app against the
official LSP client package.

## Local Commands

```bash
vp run @codemirror-treesitter/lsp-client#check
vp run @codemirror-treesitter/lsp-client#test
vp run @codemirror-treesitter/lsp-client#build
```

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/lsp-client#check
vp run @codemirror-treesitter/lsp-client#test
vp run audit
```

The audit checks upstream export parity and verifies that the implementation
uses local Tree-sitter language and autocomplete packages.
