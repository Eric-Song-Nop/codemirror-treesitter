import { type ChangeDesc, type Text } from "@codemirror/state";
import { mergeDocRanges } from "@codemirror-treesitter/language";
import { type DocRange } from "./types.js";

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function clampRangeToDoc(range: DocRange, docLength: number): DocRange {
  return {
    from: clamp(range.from, 0, docLength),
    to: clamp(range.to, 0, docLength),
  };
}

export function mapRange(range: DocRange, changes: ChangeDesc): DocRange {
  let from = changes.mapPos(clamp(range.from, 0, changes.length), 1);
  let to = changes.mapPos(clamp(range.to, 0, changes.length), -1);
  return from <= to ? { from, to } : { from: to, to: from };
}

export function mapInclusiveRange(range: DocRange, changes: ChangeDesc): DocRange {
  let from = changes.mapPos(clamp(range.from, 0, changes.length), -1);
  let to = changes.mapPos(clamp(range.to, 0, changes.length), 1);
  return from <= to ? { from, to } : { from: to, to: from };
}

export function normalizeRanges(ranges: readonly DocRange[], docLength: number): DocRange[] {
  return mergeDocRanges(
    ranges.map((range) => ({
      from: clamp(Math.min(range.from, range.to), 0, docLength),
      to: clamp(Math.max(range.from, range.to), 0, docLength),
    })),
  );
}

export function textChangeContextRanges(
  oldDoc: Text,
  newDoc: Text,
  changes: ChangeDesc,
): DocRange[] {
  let ranges: DocRange[] = [];
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    ranges.push(
      expandTextChangeRange(oldDoc, newDoc, { from: fromA, to: toA }, { from: fromB, to: toB }),
    );
  }, true);
  return ranges;
}

export function oldTextChangeContextRanges(
  oldDoc: Text,
  newDoc: Text,
  changes: ChangeDesc,
): DocRange[] {
  let ranges: DocRange[] = [];
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    ranges.push(
      expandOldTextChangeRange(oldDoc, newDoc, { from: fromA, to: toA }, { from: fromB, to: toB }),
    );
  }, true);
  return ranges;
}

export function isBroadContainerSyntaxRange(
  range: DocRange,
  textContextRanges: readonly DocRange[],
  docLength: number,
) {
  let size = range.to - range.from;
  if (size < Math.min(1024, docLength / 4)) return false;
  return textContextRanges.some(
    (textRange) => range.from <= textRange.from && range.to >= textRange.to,
  );
}

export function subtractRanges(
  ranges: readonly DocRange[],
  remove: readonly DocRange[],
): DocRange[] {
  if (!ranges.length || !remove.length) return [...ranges];
  let removed = mergeDocRanges(remove);
  let kept: DocRange[] = [];
  for (let range of ranges) {
    let segments: DocRange[] = [range];
    for (let removeRange of removed) {
      let next: DocRange[] = [];
      for (let segment of segments) {
        if (!rangesTouchPoint(segment, removeRange)) {
          next.push(segment);
          continue;
        }
        if (segment.from < removeRange.from) {
          next.push({ from: segment.from, to: Math.min(segment.to, removeRange.from) });
        }
        if (removeRange.to < segment.to) {
          next.push({ from: Math.max(segment.from, removeRange.to), to: segment.to });
        }
      }
      segments = next;
      if (!segments.length) break;
    }
    kept.push(...segments.filter((segment) => segment.from < segment.to));
  }
  return mergeDocRanges(kept);
}

export function rangesSame(left: DocRange, right: DocRange) {
  return left.from == right.from && left.to == right.to;
}

export function rangesEqual(left: readonly DocRange[], right: readonly DocRange[]) {
  return (
    left.length == right.length && left.every((range, index) => rangesSame(range, right[index]!))
  );
}

/** Point-aware touch used by cache and source-island invalidation. */
export function rangesTouchPoint(left: DocRange, right: DocRange) {
  if (left.from == left.to && right.from == right.to) return left.from == right.from;
  if (left.from == left.to) return left.from >= right.from && left.from < right.to;
  if (right.from == right.to) return left.from <= right.from && left.to >= right.from;
  return left.from < right.to && right.from < left.to;
}

/** Inclusive boundary touch used by block cursor traversal. */
export function rangesTouchInclusive(left: DocRange, right: DocRange) {
  return left.from <= right.to && right.from <= left.to;
}

/** Strict overlap used by projection, table, and problem-node checks. */
export function rangesOverlap(left: DocRange, right: DocRange) {
  return left.from < right.to && right.from < left.to;
}

export function lineRangeFor(doc: Text, from: number, to: number): DocRange {
  let rangeFrom = clamp(from, 0, doc.length);
  let rangeTo = clamp(to, 0, doc.length);
  let firstLine = doc.lineAt(rangeFrom);
  let lastLine = doc.lineAt(Math.max(rangeFrom, rangeTo - 1));
  return { from: firstLine.from, to: rangeTo >= doc.length ? rangeTo : lastLine.to };
}

export function countLines(doc: Text, ranges: readonly DocRange[]) {
  let lineCount = 0;
  for (let range of ranges) {
    let from = clamp(range.from, 0, doc.length);
    let to = clamp(range.to, from, doc.length);
    lineCount += doc.lineAt(to).number - doc.lineAt(from).number + 1;
  }
  return lineCount;
}

export function hashStringValue(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}

export function hashString(value: string) {
  return hashStringValue(value).toString(36);
}

export function hashDocRange(doc: Text, range: DocRange) {
  let hash = 0x811c9dc5;
  for (let iter = doc.iterRange(range.from, range.to); !iter.next().done; ) {
    if (iter.lineBreak) {
      hash = hashChar(hash, 10);
      continue;
    }
    let value = iter.value;
    for (let index = 0; index < value.length; index++) {
      hash = hashChar(hash, value.charCodeAt(index));
    }
  }
  return hash >>> 0;
}

function expandTextChangeRange(
  oldDoc: Text,
  newDoc: Text,
  oldRange: DocRange,
  newRange: DocRange,
): DocRange {
  if (isSingleLineRange(oldDoc, oldRange) && isSingleLineRange(newDoc, newRange)) {
    return lineRange(newDoc, newRange);
  }
  return expandToLineContext(newDoc, newRange);
}

function expandOldTextChangeRange(
  oldDoc: Text,
  newDoc: Text,
  oldRange: DocRange,
  newRange: DocRange,
): DocRange {
  if (isSingleLineRange(oldDoc, oldRange) && isSingleLineRange(newDoc, newRange)) {
    return lineRange(oldDoc, oldRange);
  }
  return expandToLineContext(oldDoc, oldRange);
}

function expandToLineContext(doc: Text, range: DocRange): DocRange {
  if (doc.length == 0) return { from: 0, to: 0 };
  let from = clamp(Math.min(range.from, range.to), 0, doc.length);
  let to = clamp(Math.max(range.from, range.to), 0, doc.length);
  let fromLine = doc.lineAt(from);
  let toLine = doc.lineAt(to);
  let startLine = doc.line(Math.max(1, fromLine.number - 1));
  let endLine = doc.line(Math.min(doc.lines, toLine.number + 1));
  return { from: startLine.from, to: endLine.to };
}

function lineRange(doc: Text, range: DocRange): DocRange {
  if (doc.length == 0) return { from: 0, to: 0 };
  let from = clamp(range.from, 0, doc.length);
  let to = clamp(range.to, 0, doc.length);
  if (to < from) [from, to] = [to, from];
  let fromLine = doc.lineAt(from);
  let toLine = doc.lineAt(to);
  return { from: fromLine.from, to: toLine.to };
}

function isSingleLineRange(doc: Text, range: DocRange) {
  if (doc.length == 0) return true;
  let from = clamp(range.from, 0, doc.length);
  let to = clamp(range.to, 0, doc.length);
  if (to < from) [from, to] = [to, from];
  return doc.lineAt(from).number == doc.lineAt(to).number;
}

function hashChar(hash: number, value: number) {
  hash ^= value;
  return Math.imul(hash, 0x01000193);
}
