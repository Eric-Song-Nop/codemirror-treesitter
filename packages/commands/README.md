# @codemirror-treesitter/commands

Lezer-free editing commands for the CodeMirror Tree-sitter build. This package
tracks the public surface of `@codemirror/commands`, `comment`, and `history`,
but imports syntax helpers from `@codemirror-treesitter/language`.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/language`, `@codemirror/state`, and
  `@codemirror/view`.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally avoids `@codemirror/language`, Lezer imports, and no-op command
  placeholders.
- Exports only `.` and `./package.json` from the built package.

## Responsibilities

- Cursor movement by character, group, subword, line, page, document, bracket,
  and syntax node.
- Selection commands, including select-all, select-line, parent syntax
  selection, and multiple cursors above/below.
- Deletion, line movement/copying, newline insertion, indentation, tab focus
  mode, and `indentWithTab`.
- Line and block commenting driven by language data facets.
- History state, undo/redo commands, history isolation, and history keymaps.
- Standard, default, Emacs-style, and history keymaps.

## Public Entry

```ts
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from "@codemirror-treesitter/commands";
```

The root entry point is `src/index.ts`, with comment helpers in
`src/comment.ts` and history in `src/history.ts`.

## Source Layout

- `src/index.ts`: command exports, cursor/selection/editing commands, and
  keymaps.
- `src/comment.ts`: line and block comment commands backed by language data.
- `src/history.ts`: undo/redo history state, commands, effects, and keymaps.
- `tests/*`: command, history, and indentation behavior coverage.

## Relationship to Other Packages

This package depends on the local language package for indentation,
syntax-tree navigation, bracket matching, and comment token data. It is used by
`@codemirror-treesitter/basic-setup`, `@codemirror-treesitter/live-md`, and the
apps.

## Local Commands

```bash
vp run @codemirror-treesitter/commands#check
vp run @codemirror-treesitter/commands#test
vp run @codemirror-treesitter/commands#build
```

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/commands#check
vp run @codemirror-treesitter/commands#test
vp run audit
```

The audit checks upstream export parity and verifies that known command stubs
are not present.
