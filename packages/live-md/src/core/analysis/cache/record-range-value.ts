import { type Range, RangeValue } from "@codemirror/state";
import { type LeafAnalysisRecord } from "../descriptors.js";
import { type DocRange } from "../types.js";
import {
  leafRecordPayload,
  type LeafRecordPayload,
  recordCacheSourceRange,
  recordFromPayload,
} from "./payload.js";

export class PositionedLeafRecord extends RangeValue {
  constructor(readonly payload: LeafRecordPayload) {
    super();
  }
}

export class LeafRecordSafetyRef extends RangeValue {
  constructor(readonly payload: LeafRecordPayload) {
    super();
  }
}

export function leafRecordRanges(records: readonly LeafAnalysisRecord[]): {
  records: Array<Range<PositionedLeafRecord>>;
  safety: Array<Range<LeafRecordSafetyRef>>;
} {
  let docLength = leafRecordDocumentLength(records);
  let positioned: Array<Range<PositionedLeafRecord>> = [];
  let safety: Array<Range<LeafRecordSafetyRef>> = [];
  for (let record of records.slice().sort(compareAnalysisRecords)) {
    let anchor = recordInvalidationRange(record).from;
    let payload = leafRecordPayload(record, anchor);
    positioned.push(new PositionedLeafRecord(payload).range(record.range.from, record.range.to));
    let safetyRange = clampRange(recordInvalidationRange(record), docLength);
    safety.push(new LeafRecordSafetyRef(payload).range(safetyRange.from, safetyRange.to));
  }
  safety.sort((left, right) => left.from - right.from || left.to - right.to);
  return { records: positioned, safety };
}

export function recordFromPositioned(from: number, value: RangeValue): LeafAnalysisRecord {
  let payload = (value as PositionedLeafRecord).payload;
  return recordFromPayload(payload, from - payload.range.from);
}

export function recordFromSafety(from: number, value: RangeValue): LeafAnalysisRecord {
  return recordFromPayload((value as LeafRecordSafetyRef).payload, from);
}

export function recordInvalidationRange(record: LeafAnalysisRecord) {
  return unionRanges(
    record.range,
    record.sourceRange,
    record.effectRange,
    recordCacheSourceRange(record),
  );
}

export function leafRecordDocumentLength(records: readonly LeafAnalysisRecord[]) {
  let length = 0;
  for (let record of records) {
    length = Math.max(
      length,
      record.range.to,
      record.sourceRange.to,
      record.cacheSourceRange?.to ?? 0,
    );
  }
  return length;
}

export function compareAnalysisRecords(left: LeafAnalysisRecord, right: LeafAnalysisRecord) {
  return (
    left.range.from - right.range.from ||
    left.range.to - right.range.to ||
    left.kind.localeCompare(right.kind) ||
    left.cacheId - right.cacheId
  );
}

function unionRanges(...ranges: readonly DocRange[]): DocRange {
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (let range of ranges) {
    from = Math.min(from, range.from);
    to = Math.max(to, range.to);
  }
  return { from, to };
}

function clampRange(range: DocRange, docLength: number): DocRange {
  let from = clamp(Math.min(range.from, range.to), 0, docLength);
  let to = clamp(Math.max(range.from, range.to), 0, docLength);
  return { from, to };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
