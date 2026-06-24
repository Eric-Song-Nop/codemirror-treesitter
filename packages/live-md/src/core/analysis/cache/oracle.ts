import { type LeafAnalysisRecord } from "../descriptors.js";
import { type LeafAnalysisCache, type LeafAnalysisCacheTrace } from "./cache.js";
import { forEachLeafAnalysisCacheRecord } from "./query.js";

export function materializeLeafAnalysisCacheRecords(
  cache: LeafAnalysisCache,
  trace?: LeafAnalysisCacheTrace,
): readonly LeafAnalysisRecord[] {
  if (trace) trace.cacheFullMaterializations++;
  let records: LeafAnalysisRecord[] = [];
  forEachLeafAnalysisCacheRecord(cache, (record) => records.push(record));
  return Object.freeze(records);
}
