import {
  EditorState,
  type ChangeDesc,
  type Range,
  RangeSet,
  type RangeValue,
} from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { syntaxTreeChangedRanges } from "./language.js";
import type { DocRange } from "./tree.js";

export function changedLineRanges(update: ViewUpdate): readonly DocRange[] {
  let transaction = update.transactions[0];
  return lineRangesForChanges(
    update.state,
    update.changes,
    transaction ? syntaxTreeChangedRanges(transaction) : [],
  );
}

export function lineRangesForChanges(
  state: EditorState,
  changes: ChangeDesc,
  syntaxChangedRanges: readonly DocRange[] = [],
) {
  let ranges: DocRange[] = [];
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    addTouchedLineRange(state, ranges, fromB, toB);
  });
  for (let range of syntaxChangedRanges) {
    addTouchedLineRange(state, ranges, range.from, range.to);
  }
  return mergeDocRanges(ranges);
}

export function addTouchedLineRange(
  state: EditorState,
  ranges: DocRange[],
  rangeFrom: number,
  rangeTo: number,
) {
  let from = clamp(rangeFrom, 0, state.doc.length);
  let to = clamp(rangeTo, 0, state.doc.length);
  let firstLine = state.doc.lineAt(from);
  let lastLine = state.doc.lineAt(Math.max(from, to - 1));
  ranges.push({ from: firstLine.from, to: lastLine.to });
}

export function mergeDocRanges(ranges: readonly DocRange[]) {
  let sorted = ranges.slice().sort((left, right) => left.from - right.from || left.to - right.to);
  let merged: DocRange[] = [];
  for (let range of sorted) {
    let last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

export function patchRangeSet<T extends RangeValue>(
  current: RangeSet<T>,
  dirtyRanges: readonly DocRange[],
  additions: readonly Range<T>[],
) {
  let next = current;
  for (let range of dirtyRanges) {
    next = next.update({
      filter: (from, to) => !rangesTouch(from, to, range.from, range.to),
      filterFrom: range.from,
      filterTo: range.to,
    });
  }
  return additions.length ? next.update({ add: additions, sort: true }) : next;
}

export function clipToRanges(ranges: readonly DocRange[], bounds: readonly DocRange[]) {
  let clipped: DocRange[] = [];
  for (let range of ranges) {
    for (let bound of bounds) {
      let from = Math.max(range.from, bound.from);
      let to = Math.min(range.to, bound.to);
      if (from <= to) clipped.push({ from, to });
    }
  }
  return mergeDocRanges(clipped);
}

export function rangesTouch(from: number, to: number, rangeFrom: number, rangeTo: number) {
  if (from == to && rangeFrom == rangeTo) return from == rangeFrom;
  if (from == to) return from >= rangeFrom && from < rangeTo;
  if (rangeFrom == rangeTo) return from <= rangeFrom && to >= rangeFrom;
  return from < rangeTo && to > rangeFrom;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
