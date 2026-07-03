import { StateEffect, StateField } from "@codemirror/state";
import { mapInclusiveRange } from "./analysis/ranges.js";
import { type DocRange } from "./analysis/types.js";

export type LiveMdEditContinuation = {
  kind: "table";
  lineRange: DocRange;
  sourceRange: DocRange;
};

export const setLiveMdEditContinuation = StateEffect.define<LiveMdEditContinuation | null>();

export const liveMdEditContinuationField = StateField.define<LiveMdEditContinuation | null>({
  create() {
    return null;
  },
  update(value, transaction) {
    for (let effect of transaction.effects) {
      if (effect.is(setLiveMdEditContinuation)) return effect.value;
    }

    if (!value) return null;

    let continuation: LiveMdEditContinuation = {
      kind: value.kind,
      lineRange: mapInclusiveRange(value.lineRange, transaction.changes),
      sourceRange: mapInclusiveRange(value.sourceRange, transaction.changes),
    };
    let head = transaction.state.selection.main.head;
    let line = transaction.state.doc.lineAt(head);
    if (head < continuation.lineRange.from || head > continuation.lineRange.to) return null;
    if (line.from != continuation.lineRange.from) return null;

    let text = transaction.state.sliceDoc(line.from, line.to);
    if (text.trim() && !isPotentialPipeTableRow(text)) return null;
    return continuation;
  },
});

export function isPotentialPipeTableRow(text: string) {
  let trimmed = text.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  return trimmed.indexOf("|", 1) < trimmed.length - 1;
}
