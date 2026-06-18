import { type ChangeDesc, type EditorState } from "@codemirror/state";
import { isWhitespaceOnly } from "../util.js";
import type { LiveMdDocRange } from "./types.js";

export function clampLiveMdPosition(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function fullLiveMdDocRange(state: EditorState): readonly LiveMdDocRange[] {
  return [{ from: 0, to: state.doc.length }];
}

export function liveMdRange(from: number, to: number): LiveMdDocRange {
  return { from, to };
}

export function liveMdNodeRange(node: { from: number; to: number }): LiveMdDocRange {
  return { from: node.from, to: node.to };
}

export function liveMdRangesTouch(
  leftFrom: number,
  leftTo: number,
  rightFrom: number,
  rightTo: number,
) {
  return leftFrom <= rightTo && leftTo >= rightFrom;
}

export function liveMdRangeTouchesRanges(
  from: number,
  to: number,
  ranges: readonly LiveMdDocRange[],
) {
  return ranges.some((range) => liveMdRangesTouch(from, to, range.from, range.to));
}

export function liveMdRangeContains(range: LiveMdDocRange, position: number) {
  return position >= range.from && position <= range.to;
}

export function sameLiveMdRanges(
  left: readonly LiveMdDocRange[],
  right: readonly LiveMdDocRange[],
) {
  if (left.length != right.length) return false;
  for (let index = 0; index < left.length; index++) {
    let leftRange = left[index]!;
    let rightRange = right[index]!;
    if (leftRange.from != rightRange.from || leftRange.to != rightRange.to) return false;
  }
  return true;
}

export function sameLiveMdNumberSet(left: ReadonlySet<number>, right: ReadonlySet<number>) {
  if (left.size != right.size) return false;
  for (let value of left) if (!right.has(value)) return false;
  return true;
}

export function mergeLiveMdRanges(ranges: readonly LiveMdDocRange[]) {
  let sorted = ranges
    .map((range) => ({ from: range.from, to: range.to }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  let merged: LiveMdDocRange[] = [];
  for (let range of sorted) {
    let last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

export function normalizeLiveMdRanges(state: EditorState, ranges: readonly LiveMdDocRange[]) {
  return mergeLiveMdRanges(
    ranges.map((range) => ({
      from: clampLiveMdPosition(range.from, 0, state.doc.length),
      to: clampLiveMdPosition(range.to, 0, state.doc.length),
    })),
  );
}

export function mapLiveMdRanges(
  ranges: readonly LiveMdDocRange[],
  changes: ChangeDesc,
  state: EditorState,
) {
  return mergeLiveMdRanges(
    ranges.map((range) =>
      liveMdLineRangeFor(state, changes.mapPos(range.from, -1), changes.mapPos(range.to, 1)),
    ),
  );
}

export function mapLiveMdRange(
  range: LiveMdDocRange,
  changes: ChangeDesc,
  state: EditorState,
): LiveMdDocRange | null {
  let oldLength = (changes as ChangeDesc & { length: number }).length;
  let oldFrom = clampLiveMdPosition(range.from, 0, oldLength);
  let oldTo = clampLiveMdPosition(range.to, 0, oldLength);
  let from = clampLiveMdPosition(changes.mapPos(oldFrom, 1), 0, state.doc.length);
  let to = clampLiveMdPosition(changes.mapPos(oldTo, -1), 0, state.doc.length);
  return from <= to ? { from, to } : null;
}

export function activeLiveMdLines(state: EditorState) {
  let lines = new Set<number>();
  for (let range of state.selection.ranges) {
    lines.add(state.doc.lineAt(range.head).number);
  }
  return lines;
}

export function activeLiveMdLineRanges(
  state: EditorState,
  lines: ReadonlySet<number> = activeLiveMdLines(state),
) {
  let ranges: LiveMdDocRange[] = [];
  for (let lineNumber of lines) {
    if (lineNumber < 1 || lineNumber > state.doc.lines) continue;
    let line = state.doc.line(lineNumber);
    ranges.push({ from: line.from, to: line.to });
  }
  return ranges;
}

export function previousActiveLiveMdLineRanges(
  startState: EditorState,
  state: EditorState,
  changes: ChangeDesc | null,
  lines: ReadonlySet<number>,
) {
  let ranges: LiveMdDocRange[] = [];
  for (let lineNumber of lines) {
    if (lineNumber < 1 || lineNumber > startState.doc.lines) continue;
    let line = startState.doc.line(lineNumber);
    let from = changes ? changes.mapPos(line.from, 1) : line.from;
    let to = changes ? changes.mapPos(line.to, -1) : line.to;
    ranges.push(liveMdLineRangeFor(state, from, to));
  }
  return ranges;
}

export function liveMdLineRangeFor(state: EditorState, from: number, to: number): LiveMdDocRange {
  let rangeFrom = clampLiveMdPosition(from, 0, state.doc.length);
  let rangeTo = clampLiveMdPosition(to, 0, state.doc.length);
  let firstLine = state.doc.lineAt(rangeFrom);
  let lastLine = state.doc.lineAt(Math.max(rangeFrom, rangeTo - 1));
  return { from: firstLine.from, to: rangeTo >= state.doc.length ? rangeTo : lastLine.to };
}

export function expandLiveMdQueryRanges(state: EditorState, ranges: readonly LiveMdDocRange[]) {
  return expandLiveMdPipeTableRanges(state, expandLiveMdLeadingBlankRanges(state, ranges));
}

export function expandLiveMdLeadingBlankRanges(
  state: EditorState,
  ranges: readonly LiveMdDocRange[],
) {
  return mergeLiveMdRanges(ranges.map((range) => expandLiveMdLeadingBlankRange(state, range)));
}

export function expandLiveMdPipeTableRanges(state: EditorState, ranges: readonly LiveMdDocRange[]) {
  let tableRanges: LiveMdDocRange[] = [];
  for (let range of ranges) {
    if (range.from > range.to) continue;
    let firstLine = state.doc.lineAt(clampLiveMdPosition(range.from, 0, state.doc.length));
    let lastLine = state.doc.lineAt(
      clampLiveMdPosition(Math.max(range.from, range.to - 1), 0, state.doc.length),
    );
    for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber++) {
      let line = state.doc.line(lineNumber);
      if (!liveMdLineMayBePipeTableLine(state.sliceDoc(line.from, line.to))) continue;
      let tableRange = liveMdPipeTableLineBlock(state, lineNumber);
      tableRanges.push(tableRange);
      lineNumber = state.doc.lineAt(Math.max(tableRange.from, tableRange.to - 1)).number;
    }
  }
  return mergeLiveMdRanges([...ranges, ...tableRanges]);
}

function expandLiveMdLeadingBlankRange(state: EditorState, range: LiveMdDocRange): LiveMdDocRange {
  if (range.from <= 0 || state.doc.length == 0) return range;
  let from = clampLiveMdPosition(range.from, 0, state.doc.length);
  let to = clampLiveMdPosition(range.to, 0, state.doc.length);
  let firstLine = state.doc.lineAt(Math.min(from, state.doc.length));
  if (!isWhitespaceOnly(state.sliceDoc(firstLine.from, firstLine.to))) return { from, to };

  let lineNumber = firstLine.number - 1;
  for (; lineNumber >= 1; lineNumber--) {
    let line = state.doc.line(lineNumber);
    from = line.from;
    if (!isWhitespaceOnly(state.sliceDoc(line.from, line.to))) break;
  }
  for (lineNumber--; lineNumber >= 1; lineNumber--) {
    let line = state.doc.line(lineNumber);
    if (isWhitespaceOnly(state.sliceDoc(line.from, line.to))) break;
    from = line.from;
  }
  return { from, to: expandLiveMdToNextNonBlankLineStart(state, to) };
}

function expandLiveMdToNextNonBlankLineStart(state: EditorState, to: number) {
  let lineNumber = state.doc.lineAt(clampLiveMdPosition(to, 0, state.doc.length)).number;
  for (; lineNumber <= state.doc.lines; lineNumber++) {
    let line = state.doc.line(lineNumber);
    if (line.to < to) continue;
    if (!isWhitespaceOnly(state.sliceDoc(line.from, line.to))) return Math.max(to, line.from);
  }
  return to;
}

function liveMdPipeTableLineBlock(state: EditorState, lineNumber: number): LiveMdDocRange {
  let fromLine = lineNumber;
  for (; fromLine > 1; fromLine--) {
    let previous = state.doc.line(fromLine - 1);
    if (!liveMdLineMayBePipeTableLine(state.sliceDoc(previous.from, previous.to))) break;
  }

  let toLine = lineNumber;
  for (; toLine < state.doc.lines; toLine++) {
    let next = state.doc.line(toLine + 1);
    if (!liveMdLineMayBePipeTableLine(state.sliceDoc(next.from, next.to))) break;
  }

  let lastLine = state.doc.line(toLine);
  let to = lastLine.to < state.doc.length ? lastLine.to + 1 : lastLine.to;
  return { from: state.doc.line(fromLine).from, to };
}

function liveMdLineMayBePipeTableLine(text: string) {
  return text.trim().length > 0 && liveMdHasUnescapedPipe(text);
}

function liveMdHasUnescapedPipe(text: string) {
  let backslashes = 0;
  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index);
    if (code == 92) {
      backslashes++;
      continue;
    }
    if (code == 124 && backslashes % 2 == 0) return true;
    backslashes = 0;
  }
  return false;
}
