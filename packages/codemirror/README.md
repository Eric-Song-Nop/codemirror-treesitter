# @codemirror-treesitter/basic-setup

This directory publishes `@codemirror-treesitter/basic-setup`. It assembles the
Tree-sitter workspace packages into CodeMirror setup arrays equivalent to the
official `basicSetup` and `minimalSetup` entry points.

## Responsibilities

- Export `basicSetup`, a full editor extension list with line numbers, active
  line gutter, special-character highlighting, history, fold gutter, selection
  drawing, drop cursor, multiple selections, indent-on-input, syntax
  highlighting, bracket matching, close brackets, autocompletion, rectangular
  selection, active-line highlighting, search match highlighting, and keymaps.
- Export `minimalSetup`, a smaller setup with special-character highlighting,
  history, selection drawing, fallback syntax highlighting, and default/history
  keymaps.
- Re-export `EditorView` from `@codemirror/view` for compatibility with the
  upstream `codemirror` package entry.
- Preserve upstream extension and keymap ordering where the audit enforces it.

## Public Entry

```ts
import { basicSetup, minimalSetup } from "@codemirror-treesitter/basic-setup";
```

The root entry point is `src/index.ts`, and the package exports only `.` and
`./package.json`.

## Relationship to Other Packages

This package composes `@codemirror-treesitter/language`,
`@codemirror-treesitter/commands`, and
`@codemirror-treesitter/autocomplete` with official CodeMirror packages that do
not introduce Lezer into the local implementation path.

## Validation

Run from the workspace root:

```bash
vp check
vp run -r test
vp run audit
```

The audit checks that `basicSetup`, `minimalSetup`, and keymap ordering match
the upstream expectations.
