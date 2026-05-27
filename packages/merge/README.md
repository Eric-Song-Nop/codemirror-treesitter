# @codemirror-treesitter/merge

Lezer-free diff and merge views for the CodeMirror Tree-sitter build. This
package tracks the public surface of `@codemirror/merge` and uses the local
language package when syntax-highlighting deleted text in unified merge views.

## Responsibilities

- Compute and present document diffs through `diff(...)`,
  `presentableDiff(...)`, `Change`, and `Chunk`.
- Provide `MergeView` for side-by-side editors with changed chunk
  decorations, gutters, optional revert controls, unchanged-region collapsing,
  and vertical alignment.
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

The root entry point is `src/index.ts`; implementation is split across diff,
chunk, side-by-side merge view, unified merge view, decorations, and theme
modules.

## Relationship to Other Packages

This package depends on `@codemirror-treesitter/language`,
`@codemirror/state`, `@codemirror/view`, and `style-mod`. It is exercised in
the examples app against the official merge package.

## Validation

Run from the workspace root:

```bash
vp check
vp run -r test
vp run audit
```

The audit checks upstream export parity and verifies that unified deletion
highlighting uses the local Tree-sitter language helpers.
