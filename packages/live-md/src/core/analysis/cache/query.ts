import { type LeafAnalysisRecord } from "../descriptors.js";
import { type DocRange } from "../types.js";
import {
  leafAnalysisCacheRecords,
  leafAnalysisCacheSafety,
  type LeafAnalysisCache,
  type LeafAnalysisCacheTraceCounters,
} from "./cache.js";
import { recordCacheSourceRange } from "./payload.js";
import { recordFromPositioned, recordFromSafety } from "./record-range-value.js";

export type LeafAnalysisRecordEntry = {
  index: number;
  record: LeafAnalysisRecord;
};

export function findLeafAnalysisRecordsTouchingRanges(
  cache: LeafAnalysisCache,
  ranges: readonly DocRange[],
): readonly LeafAnalysisRecord[] {
  return findLeafAnalysisRecordEntriesTouchingRanges(cache, ranges).map((entry) => entry.record);
}

export function forEachLeafAnalysisCacheRecordTouchingRanges(
  cache: LeafAnalysisCache,
  ranges: readonly DocRange[],
  callback: (record: LeafAnalysisRecord, index: number) => void,
): number {
  let entries = findLeafAnalysisRecordEntriesTouchingRanges(cache, ranges);
  for (let index = 0; index < entries.length; index++) {
    callback(entries[index]!.record, index);
  }
  return entries.length;
}

export function leafAnalysisCacheRangesInDoc(cache: LeafAnalysisCache, docLength: number): boolean {
  let inDoc = true;
  forEachLeafAnalysisCacheRecord(cache, (record) => {
    if (
      !rangeInDoc(record.range, docLength) ||
      !rangeInDoc(record.sourceRange, docLength) ||
      !rangeInDoc(record.effectRange, docLength)
    ) {
      inDoc = false;
    }
  });
  return inDoc;
}

export function forEachLeafAnalysisCacheRecord(
  cache: LeafAnalysisCache,
  callback: (record: LeafAnalysisRecord, index: number) => void,
) {
  let index = 0;
  for (let cursor = leafAnalysisCacheRecords(cache).iter(); cursor.value; cursor.next()) {
    callback(recordFromPositioned(cursor.from, cursor.value), index++);
  }
}

export function findLeafAnalysisRecordEntriesTouchingRanges(
  cache: LeafAnalysisCache,
  ranges: readonly DocRange[],
  trace?: LeafAnalysisCacheTraceCounters,
): readonly LeafAnalysisRecordEntry[] {
  if (!ranges.length) return [];
  if (trace) {
    trace.cacheIndexQueries += ranges.length;
    trace.safetyIndexQueries += ranges.length;
  }

  let records: LeafAnalysisRecordEntry[] = [];
  let seen = new Set<number>();
  for (let range of ranges) {
    leafAnalysisCacheSafety(cache).between(range.from, range.to, (from, _to, value) => {
      if (trace) trace.cacheIndexCallbacks++;
      let record = recordFromSafety(from, value);
      if (!recordTouchesRanges(record, [range])) return;
      if (seen.has(record.cacheId)) return;
      seen.add(record.cacheId);
      records.push({
        index: -1,
        record,
      });
    });
  }
  return records.sort(
    (left, right) =>
      left.record.range.from - right.record.range.from ||
      left.record.range.to - right.record.range.to,
  );
}

export function leafAnalysisRecordEntries(
  cache: LeafAnalysisCache,
  records: readonly LeafAnalysisRecord[],
): readonly LeafAnalysisRecordEntry[] {
  let entries: LeafAnalysisRecordEntry[] = [];
  for (let record of records) {
    let entry = findLeafAnalysisRecordEntriesTouchingRanges(cache, [record.sourceRange]).find(
      (candidate) => candidate.record.cacheId == record.cacheId,
    );
    if (entry) entries.push(entry);
  }
  return entries;
}

function rangeInDoc(range: DocRange, docLength: number) {
  return range.from >= 0 && range.from <= range.to && range.to <= docLength;
}

function recordTouchesRanges(record: LeafAnalysisRecord, ranges: readonly DocRange[]) {
  return ranges.some(
    (range) =>
      rangesTouch(record.range, range) ||
      rangesTouch(record.sourceRange, range) ||
      rangesTouch(record.effectRange, range) ||
      rangesTouch(recordCacheSourceRange(record), range),
  );
}

function rangesTouch(left: DocRange, right: DocRange) {
  if (left.from == left.to && right.from == right.to) return left.from == right.from;
  if (left.from == left.to) return left.from >= right.from && left.from < right.to;
  if (right.from == right.to) return left.from <= right.from && left.to >= right.from;
  return left.from < right.to && right.from < left.to;
}
