import type { ChangeDesc, EditorState } from "@codemirror/state";
import type { DocRange } from "@codemirror-treesitter/language";

export type LiveMdDirtyReason = "codeFenceLanguages" | "selection" | "syntax" | "text";

export type LiveMdDirtyRange = {
  from: number;
  reasons: readonly LiveMdDirtyReason[];
  to: number;
};

export type CollectLiveMdDirtyRangesInput = {
  activeLines?: readonly number[];
  changes: ChangeDesc;
  codeFenceLanguagesChanged?: boolean;
  previousActiveLines?: readonly number[];
  startState: EditorState;
  state: EditorState;
  syntaxChangedRanges?: readonly DocRange[];
};

export function collectLiveMdDirtyRanges(input: CollectLiveMdDirtyRangesInput): LiveMdDirtyRange[] {
  let ranges: MutableDirtyRange[] = [];

  input.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    ranges.push({ from: fromB, reasons: new Set(["text"]), to: toB });
  });

  for (let range of input.syntaxChangedRanges ?? []) {
    ranges.push({ from: range.from, reasons: new Set(["syntax"]), to: range.to });
  }

  for (let lineNumber of input.previousActiveLines ?? []) {
    addLineRange(ranges, input.startState, lineNumber, "selection");
  }
  for (let lineNumber of input.activeLines ?? []) {
    addLineRange(ranges, input.state, lineNumber, "selection");
  }

  if (input.codeFenceLanguagesChanged) {
    ranges.push({
      from: 0,
      reasons: new Set(["codeFenceLanguages"]),
      to: input.state.doc.length,
    });
  }

  return mergeDirtyRanges(ranges);
}

export const __testCollectLiveMdDirtyRanges = collectLiveMdDirtyRanges;

type MutableDirtyRange = {
  from: number;
  reasons: Set<LiveMdDirtyReason>;
  to: number;
};

const reasonOrder: readonly LiveMdDirtyReason[] = [
  "text",
  "syntax",
  "selection",
  "codeFenceLanguages",
];

function addLineRange(
  ranges: MutableDirtyRange[],
  state: EditorState,
  lineNumber: number,
  reason: LiveMdDirtyReason,
) {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return;
  let line = state.doc.line(lineNumber);
  ranges.push({ from: line.from, reasons: new Set([reason]), to: line.to });
}

function mergeDirtyRanges(ranges: MutableDirtyRange[]): LiveMdDirtyRange[] {
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  let merged: MutableDirtyRange[] = [];
  for (let range of ranges) {
    let last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
      for (let reason of range.reasons) last.reasons.add(reason);
    } else {
      merged.push({
        from: range.from,
        reasons: new Set(range.reasons),
        to: range.to,
      });
    }
  }
  return merged.map((range) => ({
    from: range.from,
    reasons: reasonOrder.filter((reason) => range.reasons.has(reason)),
    to: range.to,
  }));
}
