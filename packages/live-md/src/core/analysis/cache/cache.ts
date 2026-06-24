import { type ChangeDesc, RangeSet, type Text } from "@codemirror/state";
import { type LeafAnalysisRecord } from "../descriptors.js";
import { type LiveMdLeafSemanticAnalysisInput } from "../markdown-leaf-analysis.js";
import { type LiveMdSourceIslandLeaf } from "../markdown-source-islands.js";
import {
  emptyLiveMdLeafAnalysisTrace,
  type DocRange,
  type LiveMdLeafAnalysisTrace,
} from "../types.js";
import {
  compareAnalysisRecords,
  leafRecordRanges,
  type LeafRecordSafetyRef,
  type PositionedLeafRecord,
} from "./record-range-value.js";

declare const leafAnalysisCacheBrand: unique symbol;

type LeafAnalysisCacheFields = {
  readonly records: RangeSet<PositionedLeafRecord>;
  readonly safety: RangeSet<LeafRecordSafetyRef>;
  readonly recordCount: number;
  readonly nextCacheId: number;
};

export type LeafAnalysisCache = {
  readonly [leafAnalysisCacheBrand]: "LeafAnalysisCache";
};

type LeafAnalysisCacheData = LeafAnalysisCacheFields & LeafAnalysisCache;

export type LiveMdSemanticState = {
  cache: LeafAnalysisCache;
  revision: number;
};

export type LeafAnalysisCacheTrace = LiveMdLeafAnalysisTrace;

export type LeafAnalysisCacheTransition = {
  cache: LeafAnalysisCache;
  changedRecordIds?: readonly number[];
  changedRecords?: readonly LeafAnalysisRecord[];
  mappedOldEffectRanges?: readonly DocRange[];
  newEffectRanges?: readonly DocRange[];
  removedRecordIds?: readonly number[];
  fallback?: "fullWalk";
  sourceIslandLeaves?: readonly LiveMdSourceIslandLeaf[];
  trace: LeafAnalysisCacheTrace;
};

export type LeafAnalysisCacheLocalTransitionInput = {
  analysisInput: LiveMdLeafSemanticAnalysisInput;
  changes: ChangeDesc;
  mappedOldAffectedRanges?: readonly DocRange[];
  oldAffectedRecords?: readonly LeafAnalysisRecord[];
  oldCache: LeafAnalysisCache;
  oldDoc: Text;
  oldSourceIslandLeaves?: readonly LiveMdSourceIslandLeaf[];
  syntaxChangedRanges?: readonly DocRange[];
  yieldCheck?: () => void;
};

export type LeafAnalysisCacheTraceCounters = Pick<
  LeafAnalysisCacheTrace,
  "cacheIndexCallbacks" | "cacheIndexQueries" | "recordsMappedIndividually" | "safetyIndexQueries"
>;

export function emptyLeafAnalysisCacheTrace(): LeafAnalysisCacheTrace {
  return emptyLiveMdLeafAnalysisTrace();
}

export function createLeafAnalysisCache(
  records: readonly LeafAnalysisRecord[],
  nextCacheId: number,
): LeafAnalysisCache {
  let frozen = records.slice().sort(compareAnalysisRecords);
  let ranges = leafRecordRanges(frozen);
  return createLeafAnalysisCacheFromRangeSets(
    RangeSet.of(ranges.records, true),
    RangeSet.of(ranges.safety, true),
    frozen.length,
    nextCacheId,
  );
}

export function createLeafAnalysisCacheFromRangeSets(
  records: RangeSet<PositionedLeafRecord>,
  safety: RangeSet<LeafRecordSafetyRef>,
  recordCount: number,
  nextCacheId: number,
): LeafAnalysisCache {
  return {
    nextCacheId,
    recordCount,
    records,
    safety,
  } as LeafAnalysisCacheData;
}

export function leafAnalysisCacheRecordCount(cache: LeafAnalysisCache): number {
  return leafAnalysisCacheFields(cache).recordCount;
}

export function leafAnalysisCacheNextId(cache: LeafAnalysisCache): number {
  return leafAnalysisCacheFields(cache).nextCacheId;
}

export function leafAnalysisCacheRecords(cache: LeafAnalysisCache): RangeSet<PositionedLeafRecord> {
  return leafAnalysisCacheFields(cache).records;
}

export function leafAnalysisCacheSafety(cache: LeafAnalysisCache): RangeSet<LeafRecordSafetyRef> {
  return leafAnalysisCacheFields(cache).safety;
}

function leafAnalysisCacheFields(cache: LeafAnalysisCache): LeafAnalysisCacheFields {
  return cache as LeafAnalysisCacheData;
}
