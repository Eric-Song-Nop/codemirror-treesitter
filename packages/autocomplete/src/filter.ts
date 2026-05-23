import type { EditorState } from "@codemirror/state";

export interface CompletionOptionForFilter {
  label: string;
  displayLabel?: string;
  sortText?: string;
}

export interface CompletionResultForFilter<T extends CompletionOptionForFilter> {
  options: readonly T[];
  filter?: boolean;
}

export function filterCompletionOptions<T extends CompletionOptionForFilter>(
  state: EditorState,
  result: CompletionResultForFilter<T>,
  from: number,
  to: number,
): readonly T[] {
  if (result.filter === false) return result.options;
  let query = state.sliceDoc(from, to).toLowerCase();
  if (!query) return result.options;
  return result.options.filter((option) =>
    (option.sortText || option.displayLabel || option.label).toLowerCase().startsWith(query),
  );
}
