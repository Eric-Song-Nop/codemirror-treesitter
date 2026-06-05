# @codemirror-treesitter/basic-setup

This directory publishes `@codemirror-treesitter/basic-setup`. It assembles the
Tree-sitter workspace packages into CodeMirror setup arrays equivalent to the
official `basicSetup` and `minimalSetup` entry points.

## Stack and Boundaries

- Depends on local `autocomplete`, `commands`, and `language` packages plus
  official `@codemirror/state`, `@codemirror/view`, `@codemirror/search`, and
  `@codemirror/lint`.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally avoids Lezer and official language-layer packages in the local
  implementation path.
- Exports only `.` and `./package.json` from the built package.

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
import { EditorView, basicSetup, minimalSetup } from "@codemirror-treesitter/basic-setup";
```

The root entry point is `src/index.ts`.

## Source Layout

- `src/index.ts`: setup arrays, keymap assembly, and `EditorView`
  compatibility export.
- `tests/setup.test.ts`: setup export and ordering coverage.

## Relationship to Other Packages

This package composes local `language`, `commands`, and `autocomplete` with
official CodeMirror packages that do not introduce Lezer into the local
implementation path. It is used directly by examples and by LiveMD.

## Local Commands

```bash
vp run @codemirror-treesitter/basic-setup#check
vp run @codemirror-treesitter/basic-setup#test
vp run @codemirror-treesitter/basic-setup#build
```

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/basic-setup#check
vp run @codemirror-treesitter/basic-setup#test
vp run audit
```

The audit checks that `basicSetup`, `minimalSetup`, and keymap ordering match
the upstream expectations.
