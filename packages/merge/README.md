# @codemirror-treesitter/merge

Lezer-free diff and merge views for the CodeMirror Tree-sitter build. This
package tracks the public surface of `@codemirror/merge` and uses the local
language package when syntax-highlighting deleted text in unified merge views.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/language`, `@codemirror/state`,
  `@codemirror/view`, and `style-mod`.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally avoids `@codemirror/language`, `@codemirror/merge`, and Lezer
  imports in implementation code.
- Exports only `.` and `./package.json` from the built package.

## Responsibilities

- Compute and present document diffs through `diff(...)`,
  `presentableDiff(...)`, `Change`, and `Chunk`.
- Provide `MergeView` for side-by-side editors with changed chunk decorations,
  gutters, optional revert controls, unchanged-region collapsing, and vertical
  alignment.
- Provide `unifiedMergeView(...)` for single-editor merge review against an
  original document.
- Expose commands and helpers such as `acceptChunk`, `rejectChunk`,
  `getChunks`, `goToNextChunk`, `goToPreviousChunk`, `getOriginalDoc`, and
  `updateOriginalDoc`.
- Highlight deletion widgets with the active local Tree-sitter language when
  configured to do so.

## Public Entry

```ts
import { MergeView, acceptChunk, getChunks, unifiedMergeView } from "@codemirror-treesitter/merge";
```

The root entry point is `src/index.ts`.

## Source Layout

- `src/diff.ts`: diffing primitives and presentable diff generation.
- `src/chunk.ts`: chunk model, chunk navigation, and accept/reject helpers.
- `src/mergeview.ts`: side-by-side merge view implementation.
- `src/unified.ts`: unified merge view implementation.
- `src/deco.ts` and `src/theme.ts`: decorations and styling.
- `src/merge.ts`: shared merge state and view helpers.
- `tests/*`: diff and chunk behavior coverage.

## Relationship to Other Packages

This package depends on the local language package for Tree-sitter-backed
syntax highlighting of deleted text. It is exercised in the examples app
against the official merge package.

## Current Implementation Notes

- `src/index.ts` re-exports the public surface from `diff`, `chunk`, `merge`,
  `mergeview`, `unified`, and `deco`.
- `src/merge.ts` owns chunk state and navigation; `src/unified.ts` owns
  original-document state and accept/reject behavior.
- The current automated tests focus on diff generation and chunk behavior.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/merge#check
vp run @codemirror-treesitter/merge#test
vp run audit
```

The audit checks upstream export parity and verifies that unified deletion
highlighting uses local Tree-sitter language helpers.
