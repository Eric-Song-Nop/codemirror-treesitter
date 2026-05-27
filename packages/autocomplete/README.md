# @codemirror-treesitter/autocomplete

Lezer-free autocompletion and bracket-closing infrastructure for the
CodeMirror Tree-sitter build. This package tracks the public surface of
`@codemirror/autocomplete` while using the local language package for syntax
context.

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

The root entry point is `src/index.ts`; supporting modules split completion
logic, state, tooltip rendering, snippets, close brackets, and word completion.

## Relationship to Other Packages

This package depends on `@codemirror-treesitter/language`,
`@codemirror/state`, and `@codemirror/view`. It is used by
`@codemirror-treesitter/basic-setup`, `@codemirror-treesitter/lsp-client`, and
`@codemirror-treesitter/live-md`.

## Validation

Run from the workspace root:

```bash
vp check
vp run -r test
vp run audit
```

The audit checks upstream export parity and verifies that known completion
context placeholders are not present.
