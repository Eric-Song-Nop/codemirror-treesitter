# @codemirror-treesitter/autocomplete

Lezer-free autocompletion and bracket-closing infrastructure for the
CodeMirror Tree-sitter build. This package tracks the public surface of
`@codemirror/autocomplete` while using the local language package for syntax
context.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/language`, `@codemirror/state`, and
  `@codemirror/view`.
- Built as an ES module package with Vite+ `vp pack`.
- Intentionally avoids `@codemirror/autocomplete`, `@codemirror/language`, and
  Lezer imports in implementation code.
- Exports only `.` and `./package.json` from the built package.

## Responsibilities

- Completion context, source, result, section, and option handling.
- Completion lifecycle state, async completion support, filtering, ranking, and
  current/selected completion inspection.
- Tooltip rendering and keyboard navigation for completion lists.
- Snippet expansion and snippet-field navigation.
- Word completion through `completeAnyWord`.
- Close-bracket insertion, bracket-pair deletion, and close-bracket keymaps.

## Public Entry

```ts
import {
  autocompletion,
  closeBrackets,
  completeFromList,
  completionKeymap,
  snippetCompletion,
} from "@codemirror-treesitter/autocomplete";
```

The root entry point is `src/index.ts`.

## Source Layout

- `src/completion.ts`, `src/state.ts`, `src/config.ts`, and `src/view.ts`:
  completion lifecycle, config, state, and view plugin.
- `src/tooltip.ts`: completion list rendering and interactions.
- `src/filter.ts`: completion matching, scoring, and filtering.
- `src/snippet.ts`: snippet parsing and field navigation.
- `src/word.ts`: document word completion.
- `src/closebrackets.ts`: bracket insertion/deletion behavior and keymaps.
- `src/theme.ts`: completion tooltip styling.
- `tests/*`: completion and close-bracket coverage.

## Relationship to Other Packages

This package depends on the local language package for syntax-aware completion
context. It is used by `@codemirror-treesitter/basic-setup`,
`@codemirror-treesitter/lsp-client`, `@codemirror-treesitter/live-md`, and the
apps.

## Current Implementation Notes

- `src/index.ts` exports the active completion state helpers
  `completionStatus`, `currentCompletions`, `selectedCompletion`,
  `selectedCompletionIndex`, and `setSelectedCompletion`.
- Completion UI and selection effects live in `src/view.ts` and
  `src/tooltip.ts`; matching logic is separated into `src/filter.ts`.
- Tests currently cover completion source behavior, filtering, snippet-adjacent
  completion behavior, and close-bracket insertion/deletion.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/autocomplete#check
vp run @codemirror-treesitter/autocomplete#test
vp run audit
```

The audit checks upstream export parity and verifies that known completion
context placeholders are not present.
