import { type ChangeDesc, type Range, RangeSet, RangeValue, type Text } from "@codemirror/state";
import {
  type LeafAnalysisCache,
  type LeafAnalysis,
  type LeafAnalysisRecord,
} from "./descriptors.js";
import {
  analyzeMarkdownLeafAnalysisUnit,
  createAnalysisRecord,
  markdownLeafAnalysisUnits,
  rekeyLeafAnalysis,
  rekeyLeafAnalysisForSource,
  type LiveMdLeafSemanticAnalysisInput,
  type LiveMdRenderKeyContext,
  type MarkdownLeafAnalysisUnit,
} from "./markdown-leaf-analysis.js";
import {
  createMarkdownInlineAnalysisSession,
  type MarkdownInlineAnalysisSession,
} from "./markdown-inline-analysis.js";
import { type MarkdownBlockSnapshot } from "./markdown-block-types.js";
import { collectMarkdownBlocksInRanges } from "./markdown-block-cursor.js";
import {
  transitionSourceIslandLeavesFromLeafAnalysisRecords,
  type SourceIslandIndex,
} from "./markdown-source-islands.js";
import {
  emptyLiveMdLeafAnalysisTrace,
  type DocRange,
  type LiveMdLeafAnalysisTrace,
} from "./types.js";
import {
  clamp,
  clampRangeToDoc,
  isBroadContainerSyntaxRange,
  mapRange,
  normalizeRanges,
  oldTextChangeContextRanges,
  rangesEqual,
  rangesSame,
  rangesTouchPoint,
  textChangeContextRanges,
} from "./ranges.js";

export type LeafAnalysisCacheTrace = LiveMdLeafAnalysisTrace;

export type LeafAnalysisCacheTransition = {
  cache: LeafAnalysisCache;
  changedRecordIds?: readonly number[];
  changedRecords?: readonly LeafAnalysisRecord[];
  mappedOldEffectRanges?: readonly DocRange[];
  newEffectRanges?: readonly DocRange[];
  removedRecordIds?: readonly number[];
  fallback?: "fullWalk";
  sourceIslandLeaves?: SourceIslandIndex;
  trace: LeafAnalysisCacheTrace;
};

export type LeafAnalysisCacheLocalTransitionInput = {
  analysisInput: LiveMdLeafSemanticAnalysisInput;
  changes: ChangeDesc;
  mappedOldAffectedRanges?: readonly DocRange[];
  oldAffectedRecords?: readonly LeafAnalysisRecord[];
  oldCache: LeafAnalysisCache;
  oldDoc: Text;
  oldSourceIslandLeaves?: SourceIslandIndex;
  resume?: LeafAnalysisResumeState | null;
  revision?: number;
  syntaxChangedRanges?: readonly DocRange[];
  yieldCheck?: () => void;
};

export type LeafAnalysisMappedOldRecord = {
  cacheSourceRange: DocRange;
  record: LeafAnalysisRecord;
  range: DocRange;
  sourceRange: DocRange;
};

type MappedOldRecord = LeafAnalysisMappedOldRecord;

export type LeafAnalysisOldCandidates = ReadonlyMap<string, readonly LeafAnalysisMappedOldRecord[]>;

export type LeafAnalysisResumeKind = "fresh" | "local" | "transition";

export type LeafAnalysisResumeState = {
  /**
   * Local transitions need this to finish changed-range bookkeeping after a
   * resume. Empty for fresh and full-cache transitions.
   */
  changedOldIds: Set<number>;
  /**
   * Local records that must patch projection layers after the cache commit.
   * Empty for fresh and full-cache transitions.
   */
  changedRecords: LeafAnalysisRecord[];
  /** Inline parser session owned by the resume until commit or cancellation. */
  inlineSession: MarkdownInlineAnalysisSession | null;
  kind: LeafAnalysisResumeKind;
  /** Local transition replacement windows, empty for fresh/full transitions. */
  localWindows: readonly DocRange[];
  nextCacheId: number;
  /** Old changed ranges used by source-island local transitions. */
  oldChangedRanges: readonly DocRange[];
  /**
   * Original old records used to build oldCandidates. Kept because the map is
   * keyed by match signature while local patching needs the original set.
   */
  oldCandidateRecords: LeafAnalysisRecord[];
  oldCandidates: LeafAnalysisOldCandidates;
  /** Completed records in sorted unit order. */
  records: LeafAnalysisRecord[];
  revision: number;
  snapshot: MarkdownBlockSnapshot;
  trace: LeafAnalysisCacheTrace;
  /** Next unit index to process. */
  unitIndex: number;
  usedOldIds: Set<number>;
};

type ReusableOldRecord = {
  record: LeafAnalysisRecord;
  reuseAnalysis: boolean;
};

type LeafAnalysisRecordEntry = {
  index: number;
  record: LeafAnalysisRecord;
};

type LeafAnalysisCacheTraceCounters = Pick<
  LeafAnalysisCacheTrace,
  "cacheIndexCallbacks" | "cacheIndexQueries" | "recordsMappedIndividually" | "safetyIndexQueries"
>;

type RelativeRange = {
  from: number;
  to: number;
};

type RelativeMarkdownBlockContext = {
  listPath: Array<{
    itemRange: RelativeRange;
    markerRange: RelativeRange;
    markerText: string;
    task: null | {
      checked: boolean;
      range: RelativeRange;
    };
  }>;
  quoteDepth: number;
  quoteMarkers: RelativeRange[];
};

type LeafRecordPayload = {
  analysis: LeafAnalysis;
  cacheId: number;
  cacheSourceHash?: number;
  cacheSourceRange?: RelativeRange;
  cacheStructuralKey?: string;
  context: RelativeMarkdownBlockContext;
  contextKey: string;
  effectRange: RelativeRange;
  kind: LeafAnalysisRecord["kind"];
  range: RelativeRange;
  revealRange: RelativeRange | null;
  sourceHash: number;
  sourceRange: RelativeRange;
  structuralKey: string;
};

class PositionedLeafRecord extends RangeValue {
  constructor(readonly payload: LeafRecordPayload) {
    super();
  }
}

class LeafRecordRef extends RangeValue {
  constructor(readonly payload: LeafRecordPayload) {
    super();
  }
}

const leafAnalysisResumeStateKey: unique symbol = Symbol("leafAnalysisResumeState");

type LeafAnalysisYieldError = {
  [leafAnalysisResumeStateKey]?: LeafAnalysisResumeState;
};

export function emptyLeafAnalysisCacheTrace(): LeafAnalysisCacheTrace {
  return emptyLiveMdLeafAnalysisTrace();
}

export function leafAnalysisResumeStateFromYield(error: unknown): LeafAnalysisResumeState | null {
  if (!isObject(error)) return null;
  return (error as LeafAnalysisYieldError)[leafAnalysisResumeStateKey] ?? null;
}

export function takeLeafAnalysisResumeStateFromYield(
  error: unknown,
): LeafAnalysisResumeState | null {
  let resumeState = leafAnalysisResumeStateFromYield(error);
  if (resumeState && isObject(error)) {
    delete (error as LeafAnalysisYieldError)[leafAnalysisResumeStateKey];
  }
  return resumeState;
}

export function disposeLeafAnalysisResumeState(
  resumeState: LeafAnalysisResumeState | null | undefined,
) {
  if (!resumeState) return;
  disposeInlineSession(resumeState.inlineSession);
  resumeState.inlineSession = null;
}

export function cancelLeafAnalysisResumeState(
  resumeState: LeafAnalysisResumeState | null | undefined,
) {
  disposeLeafAnalysisResumeState(resumeState);
}

export function createLeafAnalysisCache(
  records: readonly LeafAnalysisRecord[],
  nextCacheId: number,
): LeafAnalysisCache {
  let frozen = records.slice().sort(compareAnalysisRecords);
  let ranges = leafRecordRanges(frozen);
  return {
    nextCacheId,
    recordCount: frozen.length,
    records: RangeSet.of(ranges.records, true),
    safety: RangeSet.of(ranges.safety, true),
  };
}

export function rekeyLeafAnalysisCache(
  cache: LeafAnalysisCache,
  context: LiveMdRenderKeyContext,
  trace?: LeafAnalysisCacheTrace,
): LeafAnalysisCache {
  let records: LeafAnalysisRecord[] = [];
  let changed = false;
  forEachLeafAnalysisCacheRecord(cache, (record) => {
    let next = rekeyLeafAnalysisRecord(record, context);
    if (next.analysis != record.analysis) changed = true;
    records.push(next);
  });
  if (trace) {
    trace.recordsVisited += records.length;
    trace.recordsReused += records.length;
  }
  return changed ? createLeafAnalysisCache(records, cache.nextCacheId) : cache;
}

function createLeafAnalysisCacheFromRangeSets(
  records: RangeSet<PositionedLeafRecord>,
  safety: RangeSet<LeafRecordRef>,
  recordCount: number,
  nextCacheId: number,
): LeafAnalysisCache {
  return { nextCacheId, recordCount, records, safety };
}

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
      !rangeInDoc(record.effectRange, docLength) ||
      (record.revealRange != null && !rangeInDoc(record.revealRange, docLength))
    ) {
      inDoc = false;
    }
  });
  return inDoc;
}

export function leafAnalysisCacheRecordCount(cache: LeafAnalysisCache): number {
  return cacheRecordCount(cache);
}

export function forEachLeafAnalysisCacheRecord(
  cache: LeafAnalysisCache,
  callback: (record: LeafAnalysisRecord, index: number) => void,
) {
  let index = 0;
  for (let cursor = cache.records.iter(); cursor.value; cursor.next()) {
    callback(recordFromPositioned(cursor.from, cursor.value), index++);
  }
}

export function materializeLeafAnalysisCacheRecords(
  cache: LeafAnalysisCache,
  trace?: LeafAnalysisCacheTrace,
): readonly LeafAnalysisRecord[] {
  if (trace) trace.cacheFullMaterializations++;
  let records: LeafAnalysisRecord[] = [];
  forEachLeafAnalysisCacheRecord(cache, (record) => records.push(record));
  return Object.freeze(records);
}

function findLeafAnalysisRecordEntriesTouchingRanges(
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
    cache.safety.between(range.from, range.to, (from, _to, value) => {
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

function rangeInDoc(range: DocRange, docLength: number) {
  return range.from >= 0 && range.from <= range.to && range.to <= docLength;
}

export function buildFreshLeafAnalysisCache(input: {
  analysisInput: LiveMdLeafSemanticAnalysisInput;
  resume?: LeafAnalysisResumeState | null;
  revision?: number;
  snapshot: MarkdownBlockSnapshot;
  startCacheId?: number;
  yieldCheck?: () => void;
}): LeafAnalysisCacheTransition {
  let resume = resumeStateFor(input.resume, "fresh", input.revision);
  let snapshot = resume?.snapshot ?? input.snapshot;
  let nextCacheId = resume?.nextCacheId ?? input.startCacheId ?? 1;
  let trace = resume?.trace ?? emptyLeafAnalysisCacheTrace();
  let units = markdownLeafAnalysisUnits(
    input.analysisInput.state.doc,
    snapshot,
    input.analysisInput.renderKeyContext?.featuresEpoch,
  );
  if (!resume) {
    trace.recordsVisited = units.length;
    trace.leavesCollected = units.length;
  }
  let records = resume?.records ?? [];
  let inlineSession = resume?.inlineSession ?? null;
  let resumeState =
    resume ??
    createLeafAnalysisResumeState({
      inlineSession,
      kind: "fresh",
      nextCacheId,
      oldCandidateRecords: [],
      oldCandidates: new Map(),
      records,
      revision: input.revision ?? -1,
      snapshot,
      trace,
    });
  let completed = false;
  try {
    for (let index = resumeState.unitIndex; index < units.length; index++) {
      updateLeafAnalysisResumeProgress(resumeState, index, nextCacheId, inlineSession);
      if (index % 32 == 0) checkpointLeafAnalysisResume(input.yieldCheck, resumeState);
      let unit = units[index]!;
      trace.recordsAnalyzed++;
      records.push(
        analyzeMarkdownLeafAnalysisUnit(
          analysisInputWithInlineSession(input.analysisInput, inlineSessionHolder),
          unit,
          nextCacheId++,
          trace,
        ),
      );
      updateLeafAnalysisResumeProgress(resumeState, index + 1, nextCacheId, inlineSession);
    }
    completed = true;
  } catch (error) {
    disposeLeafAnalysisResumeStateUnlessYield(error, resumeState);
    throw error;
  } finally {
    if (completed) disposeLeafAnalysisResumeState(resumeState);
  }

  return {
    cache: createLeafAnalysisCache(records, nextCacheId),
    trace,
  };

  function inlineSessionHolder() {
    if (!inlineSession) {
      inlineSession = createMarkdownInlineAnalysisSession({
        blockTree: input.analysisInput.tree,
        doc: input.analysisInput.state.doc,
        service: input.analysisInput.service,
        trace,
      });
      resumeState.inlineSession = inlineSession;
    }
    return inlineSession;
  }
}

export function transitionLeafAnalysisCache(input: {
  analysisInput: LiveMdLeafSemanticAnalysisInput;
  changes: ChangeDesc;
  oldCache: LeafAnalysisCache;
  oldDoc: Text;
  resume?: LeafAnalysisResumeState | null;
  revision?: number;
  snapshot: MarkdownBlockSnapshot;
  yieldCheck?: () => void;
}): LeafAnalysisCacheTransition {
  let resume = resumeStateFor(input.resume, "transition", input.revision);
  let snapshot = resume?.snapshot ?? input.snapshot;
  let units = markdownLeafAnalysisUnits(
    input.analysisInput.state.doc,
    snapshot,
    input.analysisInput.renderKeyContext?.featuresEpoch,
  );
  let trace = resume?.trace ?? emptyLeafAnalysisCacheTrace();
  let oldCandidateRecords =
    resume?.oldCandidateRecords ?? materializeLeafAnalysisCacheRecords(input.oldCache, trace);
  let oldCandidates =
    resume?.oldCandidates ??
    mappedOldRecordCandidates(oldCandidateRecords, input.changes, input.yieldCheck, trace);
  let nextCacheId = resume?.nextCacheId ?? input.oldCache.nextCacheId;
  if (!resume) {
    trace.recordsVisited = units.length;
    trace.leavesCollected = units.length;
  }
  let records = resume?.records ?? [];
  let usedOldIds = resume?.usedOldIds ?? new Set<number>();
  let inlineSession = resume?.inlineSession ?? null;
  let resumeState =
    resume ??
    createLeafAnalysisResumeState({
      inlineSession,
      kind: "transition",
      nextCacheId,
      oldCandidateRecords: [...oldCandidateRecords],
      oldCandidates,
      records,
      revision: input.revision ?? -1,
      snapshot,
      trace,
      usedOldIds,
    });
  let completed = false;

  try {
    for (let index = resumeState.unitIndex; index < units.length; index++) {
      updateLeafAnalysisResumeProgress(resumeState, index, nextCacheId, inlineSession);
      if (index % 32 == 0) checkpointLeafAnalysisResume(input.yieldCheck, resumeState);
      let unit = units[index]!;
      let reused = reusableOldRecord(
        input.oldDoc,
        input.analysisInput.state.doc,
        unit,
        oldCandidates,
        trace,
      );
      if (reused && !usedOldIds.has(reused.record.cacheId)) {
        usedOldIds.add(reused.record.cacheId);
        if (!reused.reuseAnalysis) {
          trace.recordsAnalyzed++;
          records.push(
            analyzeMarkdownLeafAnalysisUnit(
              analysisInputWithInlineSession(input.analysisInput, inlineSessionHolder),
              unit,
              reused.record.cacheId,
              trace,
            ),
          );
          updateLeafAnalysisResumeProgress(resumeState, index + 1, nextCacheId, inlineSession);
          continue;
        }
        trace.recordsReused++;
        records.push(
          createAnalysisRecord(
            unit,
            rekeyLeafAnalysis(unit, reused.record.analysis, input.analysisInput.renderKeyContext),
            reused.record.cacheId,
            input.analysisInput.state.doc,
          ),
        );
        updateLeafAnalysisResumeProgress(resumeState, index + 1, nextCacheId, inlineSession);
        continue;
      }

      trace.recordsAnalyzed++;
      records.push(
        analyzeMarkdownLeafAnalysisUnit(
          analysisInputWithInlineSession(input.analysisInput, inlineSessionHolder),
          unit,
          nextCacheId++,
          trace,
        ),
      );
      updateLeafAnalysisResumeProgress(resumeState, index + 1, nextCacheId, inlineSession);
    }
    completed = true;
  } catch (error) {
    disposeLeafAnalysisResumeStateUnlessYield(error, resumeState);
    throw error;
  } finally {
    if (completed) disposeLeafAnalysisResumeState(resumeState);
  }

  return {
    cache: createLeafAnalysisCache(records, nextCacheId),
    trace,
  };

  function inlineSessionHolder() {
    if (!inlineSession) {
      inlineSession = createMarkdownInlineAnalysisSession({
        blockTree: input.analysisInput.tree,
        doc: input.analysisInput.state.doc,
        service: input.analysisInput.service,
        trace,
      });
      resumeState.inlineSession = inlineSession;
    }
    return inlineSession;
  }
}

export function transitionLeafAnalysisCacheLocal(
  input: LeafAnalysisCacheLocalTransitionInput,
): LeafAnalysisCacheTransition {
  let resume = resumeStateFor(input.resume, "local", input.revision);
  let local = resume ? null : collectLocalMarkdownSnapshot(input);
  if (local?.trace.fallbackCount) {
    return {
      cache: input.oldCache,
      fallback: "fullWalk",
      trace: local.trace,
    };
  }

  let snapshot = resume?.snapshot ?? local!.snapshot;
  let units = markdownLeafAnalysisUnits(
    input.analysisInput.state.doc,
    snapshot,
    input.analysisInput.renderKeyContext?.featuresEpoch,
  );
  let trace = resume?.trace ?? local!.trace;
  let oldChangedRanges = resume?.oldChangedRanges ?? changedOldRanges(input.changes);
  let localWindows =
    resume?.localWindows ?? localReplacementRanges(input.analysisInput.state.doc.length, snapshot);
  let oldCandidateRecords: readonly LeafAnalysisRecord[];
  let oldCandidateCount: number;
  let oldCandidates: LeafAnalysisOldCandidates;
  if (resume) {
    oldCandidateRecords = resume.oldCandidateRecords;
    oldCandidateCount = resume.oldCandidateRecords.length;
    oldCandidates = resume.oldCandidates;
  } else {
    let oldCandidateEntries = uniqueRecordEntries([
      ...local!.oldAffectedEntries,
      ...localCandidateEntries(
        input.oldCache,
        input.changes,
        oldChangedRanges,
        localWindows,
        trace,
      ),
    ]);
    oldCandidateRecords = oldCandidateEntries.map((entry) => entry.record);
    oldCandidateCount = oldCandidateEntries.length;
    trace.recordsCollected = oldCandidateCount;
    oldCandidates = mappedOldRecordCandidates(
      oldCandidateRecords,
      input.changes,
      input.yieldCheck,
      trace,
    );
  }
  let nextCacheId = resume?.nextCacheId ?? input.oldCache.nextCacheId;
  if (!resume) trace.recordsVisited = units.length;
  let localRecords = resume?.records ?? [];
  let changedRecords = resume?.changedRecords ?? [];
  let changedOldIds = resume?.changedOldIds ?? new Set<number>();
  let usedOldIds = resume?.usedOldIds ?? new Set<number>();
  let inlineSession = resume?.inlineSession ?? null;
  let resumeState =
    resume ??
    createLeafAnalysisResumeState({
      changedOldIds,
      changedRecords,
      inlineSession,
      kind: "local",
      localWindows,
      nextCacheId,
      oldCandidateRecords: [...oldCandidateRecords],
      oldCandidates,
      oldChangedRanges,
      records: localRecords,
      revision: input.revision ?? -1,
      snapshot,
      trace,
      usedOldIds,
    });
  let completed = false;

  try {
    for (let index = resumeState.unitIndex; index < units.length; index++) {
      updateLeafAnalysisResumeProgress(resumeState, index, nextCacheId, inlineSession);
      if (index % 32 == 0) checkpointLeafAnalysisResume(input.yieldCheck, resumeState);
      let unit = units[index]!;
      let reused = reusableOldRecord(
        input.oldDoc,
        input.analysisInput.state.doc,
        unit,
        oldCandidates,
        trace,
      );
      if (reused && !usedOldIds.has(reused.record.cacheId)) {
        usedOldIds.add(reused.record.cacheId);
        if (!reused.reuseAnalysis) {
          trace.recordsAnalyzed++;
          let record = analyzeMarkdownLeafAnalysisUnit(
            analysisInputWithInlineSession(input.analysisInput, inlineSessionHolder),
            unit,
            reused.record.cacheId,
            trace,
          );
          changedOldIds.add(reused.record.cacheId);
          localRecords.push(record);
          changedRecords.push(record);
          updateLeafAnalysisResumeProgress(resumeState, index + 1, nextCacheId, inlineSession);
          continue;
        }
        trace.recordsReused++;
        localRecords.push(
          createAnalysisRecord(
            unit,
            rekeyLeafAnalysis(unit, reused.record.analysis, input.analysisInput.renderKeyContext),
            reused.record.cacheId,
            input.analysisInput.state.doc,
          ),
        );
        updateLeafAnalysisResumeProgress(resumeState, index + 1, nextCacheId, inlineSession);
        continue;
      }

      trace.recordsAnalyzed++;
      let record = analyzeMarkdownLeafAnalysisUnit(
        analysisInputWithInlineSession(input.analysisInput, inlineSessionHolder),
        unit,
        nextCacheId++,
        trace,
      );
      localRecords.push(record);
      changedRecords.push(record);
      updateLeafAnalysisResumeProgress(resumeState, index + 1, nextCacheId, inlineSession);
    }
    completed = true;
  } catch (error) {
    disposeLeafAnalysisResumeStateUnlessYield(error, resumeState);
    throw error;
  } finally {
    if (completed) disposeLeafAnalysisResumeState(resumeState);
  }

  localRecords.sort(compareAnalysisRecords);
  changedRecords.sort(compareAnalysisRecords);
  trace.recordsReused += cacheRecordCount(input.oldCache) - oldCandidateCount;
  let sourceIslandLeaves =
    input.oldSourceIslandLeaves &&
    transitionSourceIslandLeavesFromLeafAnalysisRecords({
      changes: input.changes,
      doc: input.analysisInput.state.doc,
      localRecords,
      localWindows,
      oldChangedRanges,
      oldDoc: input.oldDoc,
      oldLeaves: input.oldSourceIslandLeaves,
    });

  let dirtyRanges = normalizeRanges(
    oldCandidateRecords.flatMap((record) => mappedOldRecordSafetyRanges(record, input.changes)),
    input.analysisInput.state.doc.length,
  );
  let localRecordIds = new Set(localRecords.map((record) => record.cacheId));
  let removedRecordIds = oldCandidateRecords
    .filter((record) => !localRecordIds.has(record.cacheId))
    .map((record) => record.cacheId);
  let oldPatchIds = new Set([...changedOldIds, ...removedRecordIds]);
  let mappedOldEffectRanges = normalizeRanges(
    oldCandidateRecords
      .filter((record) => oldPatchIds.has(record.cacheId))
      .map((record) => mapRange(record.effectRange, input.changes)),
    input.analysisInput.state.doc.length,
  );
  let newEffectRanges = normalizeRanges(
    changedRecords.map((record) => record.effectRange),
    input.analysisInput.state.doc.length,
  );
  let excludedIds = new Set(oldCandidateRecords.map((record) => record.cacheId));
  return {
    cache: patchLeafAnalysisCache(
      input.oldCache,
      input.changes,
      dirtyRanges,
      excludedIds,
      localRecords,
      nextCacheId,
    ),
    changedRecordIds: [...changedOldIds].sort((left, right) => left - right),
    changedRecords,
    mappedOldEffectRanges,
    newEffectRanges,
    removedRecordIds,
    sourceIslandLeaves,
    trace,
  };

  function inlineSessionHolder() {
    if (!inlineSession) {
      inlineSession = createMarkdownInlineAnalysisSession({
        blockTree: input.analysisInput.tree,
        doc: input.analysisInput.state.doc,
        service: input.analysisInput.service,
        trace,
      });
      resumeState.inlineSession = inlineSession;
    }
    return inlineSession;
  }
}

function resumeStateFor(
  resumeState: LeafAnalysisResumeState | null | undefined,
  kind: LeafAnalysisResumeKind,
  revision: number | undefined,
) {
  if (!resumeState) return null;
  if (resumeState.kind != kind) return null;
  if (revision !== undefined && resumeState.revision != revision) return null;
  return resumeState;
}

function createLeafAnalysisResumeState(input: {
  changedOldIds?: Set<number>;
  changedRecords?: LeafAnalysisRecord[];
  inlineSession?: MarkdownInlineAnalysisSession | null;
  kind: LeafAnalysisResumeKind;
  localWindows?: readonly DocRange[];
  nextCacheId: number;
  oldChangedRanges?: readonly DocRange[];
  oldCandidateRecords: readonly LeafAnalysisRecord[];
  oldCandidates: LeafAnalysisOldCandidates;
  records: LeafAnalysisRecord[];
  revision: number;
  snapshot: MarkdownBlockSnapshot;
  trace: LeafAnalysisCacheTrace;
  usedOldIds?: Set<number>;
}): LeafAnalysisResumeState {
  return {
    changedOldIds: input.changedOldIds ?? new Set(),
    changedRecords: input.changedRecords ?? [],
    inlineSession: input.inlineSession ?? null,
    kind: input.kind,
    localWindows: input.localWindows ?? [],
    nextCacheId: input.nextCacheId,
    oldChangedRanges: input.oldChangedRanges ?? [],
    oldCandidateRecords: [...input.oldCandidateRecords],
    oldCandidates: input.oldCandidates,
    records: input.records,
    revision: input.revision,
    snapshot: input.snapshot,
    trace: input.trace,
    unitIndex: 0,
    usedOldIds: input.usedOldIds ?? new Set(),
  };
}

function updateLeafAnalysisResumeProgress(
  resumeState: LeafAnalysisResumeState,
  unitIndex: number,
  nextCacheId: number,
  inlineSession: MarkdownInlineAnalysisSession | null,
) {
  resumeState.unitIndex = unitIndex;
  resumeState.nextCacheId = nextCacheId;
  resumeState.inlineSession = inlineSession;
}

function checkpointLeafAnalysisResume(
  yieldCheck: (() => void) | undefined,
  resumeState: LeafAnalysisResumeState,
) {
  try {
    yieldCheck?.();
  } catch (error) {
    if (isObject(error)) {
      (error as LeafAnalysisYieldError)[leafAnalysisResumeStateKey] = resumeState;
    }
    throw error;
  }
}

function disposeLeafAnalysisResumeStateUnlessYield(
  error: unknown,
  resumeState: LeafAnalysisResumeState,
) {
  if (leafAnalysisResumeStateFromYield(error) == resumeState) return;
  disposeLeafAnalysisResumeState(resumeState);
}

function isObject(value: unknown): value is object {
  return (typeof value == "object" && value != null) || typeof value == "function";
}

function mappedOldRecordCandidates(
  records: readonly LeafAnalysisRecord[],
  changes: ChangeDesc,
  yieldCheck?: () => void,
  trace?: LeafAnalysisCacheTrace,
): ReadonlyMap<string, readonly MappedOldRecord[]> {
  let candidates = new Map<string, MappedOldRecord[]>();
  if (trace) trace.recordsMappedIndividually += records.length;
  for (let index = 0; index < records.length; index++) {
    if (index % 32 == 0) yieldCheck?.();
    let record = records[index]!;
    let mapped: MappedOldRecord = {
      cacheSourceRange: mapRange(recordCacheSourceRange(record), changes),
      range: mapRange(recordIdentityRange(record), changes),
      record,
      sourceRange: mapRange(record.sourceRange, changes),
    };
    let key = matchKey(
      record.kind,
      mapped.range,
      mapped.cacheSourceRange,
      record.contextKey,
      recordCacheSourceHash(record),
      recordCacheStructuralKey(record),
    );
    let bucket = candidates.get(key);
    if (bucket) {
      bucket.push(mapped);
    } else {
      candidates.set(key, [mapped]);
    }
  }
  return candidates;
}

function localCandidateEntries(
  cache: LeafAnalysisCache,
  changes: ChangeDesc,
  oldChangedRanges: readonly DocRange[],
  localWindows: readonly DocRange[],
  trace: LeafAnalysisCacheTrace,
) {
  let oldLocalWindows = localWindows.map((range) => mapRange(range, changes.invertedDesc));
  return findLeafAnalysisRecordEntriesTouchingRanges(
    cache,
    normalizeRanges([...oldChangedRanges, ...oldLocalWindows], changes.length),
    trace,
  );
}

function uniqueRecordEntries(records: readonly LeafAnalysisRecordEntry[]) {
  let unique: LeafAnalysisRecordEntry[] = [];
  let seen = new Set<number>();
  for (let entry of records) {
    if (seen.has(entry.record.cacheId)) continue;
    seen.add(entry.record.cacheId);
    unique.push(entry);
  }
  return unique;
}

function cacheRecordCount(cache: LeafAnalysisCache) {
  return cache.recordCount;
}

export function patchLeafAnalysisCache(
  oldCache: LeafAnalysisCache,
  changes: ChangeDesc,
  dirtyRanges: readonly DocRange[],
  excludedIds: ReadonlySet<number>,
  localRecords: readonly LeafAnalysisRecord[],
  nextCacheId: number,
) {
  let mappedRecords = oldCache.records.map(changes) as RangeSet<PositionedLeafRecord>;
  let mappedSafety = oldCache.safety.map(changes) as RangeSet<LeafRecordRef>;
  let rangesToAdd = leafRecordRanges(localRecords);
  return createLeafAnalysisCacheFromRangeSets(
    patchRangeSet(
      mappedRecords,
      dirtyRanges,
      rangesToAdd.records,
      (value) => !excludedIds.has(value.payload.cacheId),
    ),
    patchRangeSet(
      mappedSafety,
      dirtyRanges,
      rangesToAdd.safety,
      (value) => !excludedIds.has(value.payload.cacheId),
    ),
    oldCache.recordCount - excludedIds.size + localRecords.length,
    nextCacheId,
  );
}

function leafRecordRanges(records: readonly LeafAnalysisRecord[]): {
  records: Array<Range<PositionedLeafRecord>>;
  safety: Array<Range<LeafRecordRef>>;
} {
  let docLength = leafRecordDocumentLength(records);
  let positioned: Array<Range<PositionedLeafRecord>> = [];
  let safety: Array<Range<LeafRecordRef>> = [];
  for (let record of records.slice().sort(compareAnalysisRecords)) {
    let payload = leafRecordPayload(record);
    positioned.push(new PositionedLeafRecord(payload).range(record.range.from, record.range.to));
    let safetyRange = clampRangeToDoc(recordInvalidationRange(record), docLength);
    safety.push(new LeafRecordRef(payload).range(safetyRange.from, safetyRange.to));
  }
  safety.sort((left, right) => left.from - right.from || left.to - right.to);
  return { records: positioned, safety };
}

function leafRecordDocumentLength(records: readonly LeafAnalysisRecord[]) {
  let length = 0;
  for (let record of records) {
    length = Math.max(
      length,
      record.range.to,
      record.revealRange?.to ?? 0,
      record.sourceRange.to,
      record.cacheSourceRange?.to ?? 0,
    );
  }
  return length;
}

function leafRecordPayload(record: LeafAnalysisRecord): LeafRecordPayload {
  let anchor = recordInvalidationRange(record).from;
  return Object.freeze({
    analysis: record.analysis,
    cacheId: record.cacheId,
    cacheSourceHash: record.cacheSourceHash,
    cacheSourceRange: record.cacheSourceRange
      ? relativeRange(record.cacheSourceRange, anchor)
      : undefined,
    cacheStructuralKey: record.cacheStructuralKey,
    context: relativeMarkdownBlockContext(record.context, anchor),
    contextKey: record.contextKey,
    effectRange: relativeRange(record.effectRange, anchor),
    kind: record.kind,
    range: relativeRange(record.range, anchor),
    revealRange: record.revealRange ? relativeRange(record.revealRange, anchor) : null,
    sourceHash: record.sourceHash,
    sourceRange: relativeRange(record.sourceRange, anchor),
    structuralKey: record.structuralKey,
  });
}

function rekeyLeafAnalysisRecord(
  record: LeafAnalysisRecord,
  context: LiveMdRenderKeyContext,
): LeafAnalysisRecord {
  let cacheSourceRange = recordCacheSourceRange(record);
  let analysis = rekeyLeafAnalysisForSource(record.analysis, {
    context,
    kind: record.kind,
    sourceHash: recordCacheSourceHash(record),
    sourceLength: cacheSourceRange.to - cacheSourceRange.from,
  });
  return analysis == record.analysis ? record : { ...record, analysis };
}

function recordFromPositioned(from: number, value: RangeValue): LeafAnalysisRecord {
  let payload = (value as PositionedLeafRecord).payload;
  return recordFromPayload(payload, from - payload.range.from);
}

function recordFromSafety(from: number, value: RangeValue): LeafAnalysisRecord {
  return recordFromPayload((value as LeafRecordRef).payload, from);
}

function recordFromPayload(payload: LeafRecordPayload, anchor: number): LeafAnalysisRecord {
  let record: LeafAnalysisRecord = {
    analysis: payload.analysis,
    cacheId: payload.cacheId,
    context: absoluteMarkdownBlockContext(payload.context, anchor),
    contextKey: payload.contextKey,
    effectRange: absoluteRange(payload.effectRange, anchor),
    kind: payload.kind,
    range: absoluteRange(payload.range, anchor),
    revealRange: payload.revealRange ? absoluteRange(payload.revealRange, anchor) : null,
    sourceHash: payload.sourceHash,
    sourceRange: absoluteRange(payload.sourceRange, anchor),
    structuralKey: payload.structuralKey,
  };
  if (payload.cacheSourceHash !== undefined) record.cacheSourceHash = payload.cacheSourceHash;
  if (payload.cacheSourceRange)
    record.cacheSourceRange = absoluteRange(payload.cacheSourceRange, anchor);
  if (payload.cacheStructuralKey !== undefined) {
    record.cacheStructuralKey = payload.cacheStructuralKey;
  }
  return record;
}

function relativeMarkdownBlockContext(
  context: LeafAnalysisRecord["context"],
  anchor: number,
): RelativeMarkdownBlockContext {
  return {
    listPath: context.listPath.map((item) => ({
      itemRange: relativeRange(item.itemRange, anchor),
      markerRange: relativeRange(item.markerRange, anchor),
      markerText: item.markerText,
      task: item.task
        ? {
            checked: item.task.checked,
            range: relativeRange(item.task.range, anchor),
          }
        : null,
    })),
    quoteDepth: context.quoteDepth,
    quoteMarkers: context.quoteMarkers.map((range) => relativeRange(range, anchor)),
  };
}

function absoluteMarkdownBlockContext(
  context: RelativeMarkdownBlockContext,
  anchor: number,
): LeafAnalysisRecord["context"] {
  return {
    listPath: context.listPath.map((item) => ({
      itemRange: absoluteRange(item.itemRange, anchor),
      markerRange: absoluteRange(item.markerRange, anchor),
      markerText: item.markerText,
      task: item.task
        ? {
            checked: item.task.checked,
            range: absoluteRange(item.task.range, anchor),
          }
        : null,
    })),
    quoteDepth: context.quoteDepth,
    quoteMarkers: context.quoteMarkers.map((range) => absoluteRange(range, anchor)),
  };
}

function relativeRange(range: DocRange, anchor: number): RelativeRange {
  return { from: range.from - anchor, to: range.to - anchor };
}

function absoluteRange(range: RelativeRange, anchor: number): DocRange {
  return { from: range.from + anchor, to: range.to + anchor };
}

function patchRangeSet<T extends RangeValue>(
  current: RangeSet<T>,
  dirtyRanges: readonly DocRange[],
  additions: readonly Range<T>[],
  keep: (value: T) => boolean,
) {
  let next = current;
  for (let range of dirtyRanges) {
    next = next.update({
      filter: (_from, _to, value) => keep(value),
      filterFrom: range.from,
      filterTo: range.to,
    });
  }
  return additions.length ? next.update({ add: additions, sort: true }) : next;
}

/**
 * Collect the smallest block snapshot that can safely replace the changed
 * cache window.
 *
 * Local discovery is valid only when the first collection is already closed
 * over every range that can affect leaf identity. The initial seed contains:
 *
 * - the new and old text-change lines plus one physical line on each side,
 *   covering setext headings, list-item lazy continuation, and blank-line
 *   separator edits whose parse effect is defined by a neighboring line;
 * - mapped old record safety ranges, covering cached leaves whose
 *   source/effect/cache ranges diverge from their syntax node after trimming;
 * - syntax-change ranges after broad-container filtering, covering real
 *   structural reparses that are smaller than the whole-container fallback
 *   threshold.
 *
 * The fixed-point loop remains as a safety net. Simple line-local edits should
 * close after the first collection; broader structural edits may need one more
 * range-local collection after the first snapshot exposes the final leaf source
 * ranges. Reaching the retry limit is traced as `fallbackCount` and handled by
 * the caller's full-walk path.
 */
function collectLocalMarkdownSnapshot(input: LeafAnalysisCacheLocalTransitionInput) {
  let doc = input.analysisInput.state.doc;
  let seed = localInitialCheckRanges(input);
  let ranges = seed.ranges;
  let local = collectMarkdownBlocksInRanges(input.analysisInput.tree, doc, ranges);

  for (let round = 1; round <= 3; round++) {
    input.yieldCheck?.();
    let expanded = normalizeRanges(
      [
        ...ranges,
        ...local.snapshot.leaves.map((leaf) => leaf.sourceRange),
        ...local.snapshot.markers.map((marker) => marker.lineRange),
      ],
      doc.length,
    );
    if (rangesEqual(ranges, expanded)) {
      local.trace.rounds = round;
      return {
        oldAffectedEntries: seed.oldAffectedEntries,
        oldAffectedRecords: seed.oldAffectedRecords,
        mappedOldAffectedRanges: seed.mappedOldAffectedRanges,
        snapshot: local.snapshot,
        trace: traceWithCacheCounters(leafTraceFromBlockTrace(local.trace), seed),
      };
    }
    ranges = expanded;
    local = collectMarkdownBlocksInRanges(input.analysisInput.tree, doc, ranges);
  }

  let trace = leafTraceFromBlockTrace({
    ...local.trace,
    fallbackCount: 1,
    rounds: 3,
  });
  return {
    oldAffectedEntries: seed.oldAffectedEntries,
    oldAffectedRecords: seed.oldAffectedRecords,
    mappedOldAffectedRanges: seed.mappedOldAffectedRanges,
    snapshot: local.snapshot,
    trace: traceWithCacheCounters(trace, seed),
  };
}

function localInitialCheckRanges(input: LeafAnalysisCacheLocalTransitionInput) {
  let newDoc = input.analysisInput.state.doc;
  let textContextRanges = normalizeRanges(
    textChangeContextRanges(input.oldDoc, newDoc, input.changes).map((range) =>
      expandToLineContext(newDoc, range),
    ),
    newDoc.length,
  );
  let oldContextRanges = normalizeRanges(
    oldTextChangeContextRanges(input.oldDoc, newDoc, input.changes).map((range) =>
      expandToLineContext(input.oldDoc, range),
    ),
    input.oldDoc.length,
  );
  let traceCounters: LeafAnalysisCacheTraceCounters = {
    cacheIndexCallbacks: 0,
    cacheIndexQueries: 0,
    recordsMappedIndividually: 0,
    safetyIndexQueries: 0,
  };
  let oldAffectedEntries =
    input.oldAffectedRecords != null
      ? leafAnalysisRecordEntries(input.oldCache, input.oldAffectedRecords)
      : findLeafAnalysisRecordEntriesTouchingRanges(
          input.oldCache,
          oldContextRanges,
          traceCounters,
        );
  let oldAffectedRecords = oldAffectedEntries.map((entry) => entry.record);
  let mappedOldAffectedRanges =
    input.mappedOldAffectedRanges ??
    oldAffectedRecords.flatMap((record) => mappedOldRecordSafetyRanges(record, input.changes));
  let syntaxRanges = (input.syntaxChangedRanges ?? [])
    .filter((range) => !isBroadContainerSyntaxRange(range, textContextRanges, newDoc.length))
    .map((range) => expandToLineContext(newDoc, range));
  let ranges = normalizeRanges(
    [...textContextRanges, ...mappedOldAffectedRanges, ...syntaxRanges],
    newDoc.length,
  );

  return {
    mappedOldAffectedRanges,
    oldAffectedEntries,
    oldAffectedRecords,
    ranges,
    traceCounters,
  };
}

function leafAnalysisRecordEntries(
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

function traceWithCacheCounters(
  trace: LeafAnalysisCacheTrace,
  seed: { traceCounters: LeafAnalysisCacheTraceCounters },
) {
  trace.cacheIndexQueries += seed.traceCounters.cacheIndexQueries;
  trace.cacheIndexCallbacks += seed.traceCounters.cacheIndexCallbacks;
  trace.recordsMappedIndividually += seed.traceCounters.recordsMappedIndividually;
  trace.safetyIndexQueries += seed.traceCounters.safetyIndexQueries;
  return trace;
}

function mappedOldRecordSafetyRanges(record: LeafAnalysisRecord, changes: ChangeDesc) {
  return [
    mapRange(record.range, changes),
    mapRange(record.sourceRange, changes),
    mapRange(record.effectRange, changes),
    mapRange(recordCacheSourceRange(record), changes),
  ];
}

function leafTraceFromBlockTrace(trace: {
  checkedRanges: readonly DocRange[];
  collectedLeaves: number;
  collectedMarkers: number;
  fallbackCount: number;
  rounds: number;
  visitedBlockNodes: number;
}) {
  let leafTrace = emptyLeafAnalysisCacheTrace();
  leafTrace.blockNodesVisited = trace.visitedBlockNodes;
  leafTrace.checkedRanges = trace.checkedRanges;
  leafTrace.fallbackCount = trace.fallbackCount;
  leafTrace.fixedPointRounds = trace.rounds;
  leafTrace.leavesCollected = trace.collectedLeaves + trace.collectedMarkers;
  return leafTrace;
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

function localReplacementRanges(docLength: number, snapshot: MarkdownBlockSnapshot) {
  return normalizeRanges(
    [
      ...snapshot.leaves.flatMap((leaf) => [leaf.range, leaf.sourceRange]),
      ...snapshot.markers.flatMap((marker) => [marker.range, marker.lineRange]),
    ],
    docLength,
  );
}

function changedOldRanges(changes: ChangeDesc) {
  let ranges: DocRange[] = [];
  changes.iterChangedRanges((fromA, toA) => {
    ranges.push({ from: fromA, to: toA });
  });
  return ranges;
}

function recordTouchesRanges(record: LeafAnalysisRecord, ranges: readonly DocRange[]) {
  return ranges.some(
    (range) =>
      rangesTouchPoint(record.range, range) ||
      rangesTouchPoint(record.sourceRange, range) ||
      rangesTouchPoint(record.effectRange, range) ||
      rangesTouchPoint(recordCacheSourceRange(record), range),
  );
}

function recordInvalidationRange(record: LeafAnalysisRecord) {
  return unionRanges(
    record.range,
    record.sourceRange,
    record.effectRange,
    recordCacheSourceRange(record),
    ...(record.revealRange ? [record.revealRange] : []),
  );
}

function compareAnalysisRecords(left: LeafAnalysisRecord, right: LeafAnalysisRecord) {
  return (
    left.range.from - right.range.from ||
    left.range.to - right.range.to ||
    left.kind.localeCompare(right.kind) ||
    left.cacheId - right.cacheId
  );
}

function reusableOldRecord(
  oldDoc: Text,
  newDoc: Text,
  unit: MarkdownLeafAnalysisUnit,
  oldCandidates: ReadonlyMap<string, readonly MappedOldRecord[]>,
  trace: LeafAnalysisCacheTrace,
): ReusableOldRecord | null {
  let key = matchKey(
    unit.kind,
    unitIdentityRange(unit),
    unit.cacheSourceRange,
    unit.contextKey,
    unit.cacheSourceHash,
    unit.cacheStructuralKey,
  );
  let candidates = oldCandidates.get(key);
  if (!candidates) return null;

  let collisionCounted = false;
  for (let candidate of candidates) {
    let old = candidate.record;
    if (!rangesSame(candidate.range, unit.range)) continue;
    if (!rangesSame(candidate.cacheSourceRange, unit.cacheSourceRange)) continue;
    if (
      !exactSourceMatches(oldDoc, newDoc, recordCacheSourceRange(old), unit.cacheSourceRange, trace)
    ) {
      if (!collisionCounted) {
        trace.sourceHashCollisions++;
        collisionCounted = true;
      }
      continue;
    }
    return {
      record: old,
      reuseAnalysis: canReuseAnalysis(candidate, unit),
    };
  }
  return null;
}

function exactSourceMatches(
  oldDoc: Text,
  newDoc: Text,
  oldRange: DocRange,
  newRange: DocRange,
  trace: LeafAnalysisCacheTrace,
) {
  let oldLength = oldRange.to - oldRange.from;
  let newLength = newRange.to - newRange.from;
  if (oldLength != newLength) return false;
  trace.exactSourceComparisons++;
  trace.exactSourceComparedChars += oldLength;
  return oldDoc.slice(oldRange.from, oldRange.to).eq(newDoc.slice(newRange.from, newRange.to));
}

function matchKey(
  kind: LeafAnalysisRecord["kind"],
  range: DocRange,
  cacheSourceRange: DocRange,
  contextKey: string,
  cacheSourceHash: number,
  cacheStructuralKey: string,
) {
  let sourceLength = cacheSourceRange.to - cacheSourceRange.from;
  return `${kind}:${range.from}:${range.to}:${cacheSourceRange.from}:${cacheSourceRange.to}:${contextKey}:${sourceLength}:${cacheSourceHash.toString(16)}:${cacheStructuralKey}`;
}

function canReuseAnalysis(candidate: MappedOldRecord, unit: MarkdownLeafAnalysisUnit) {
  if (candidate.record.structuralKey != unit.structuralKey) return false;
  if (unit.type == "marker") return true;
  return rangesSame(candidate.sourceRange, unit.sourceRange);
}

function recordCacheSourceRange(record: LeafAnalysisRecord) {
  if (record.kind != "marker") return record.sourceRange;
  return record.cacheSourceRange ?? record.sourceRange;
}

function recordCacheSourceHash(record: LeafAnalysisRecord) {
  if (record.kind != "marker") return record.sourceHash;
  return record.cacheSourceHash ?? record.sourceHash;
}

function recordCacheStructuralKey(record: LeafAnalysisRecord) {
  return record.cacheStructuralKey ?? record.structuralKey;
}

function recordIdentityRange(record: LeafAnalysisRecord) {
  return record.kind == "marker" ? recordCacheSourceRange(record) : record.range;
}

function unitIdentityRange(unit: MarkdownLeafAnalysisUnit) {
  return unit.type == "marker" ? unit.cacheSourceRange : unit.range;
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

function analysisInputWithInlineSession(
  input: LiveMdLeafSemanticAnalysisInput,
  session: () => MarkdownInlineAnalysisSession,
): LiveMdLeafSemanticAnalysisInput {
  return {
    ...input,
    inlineSession: session(),
  };
}

function disposeInlineSession(session: MarkdownInlineAnalysisSession | null) {
  session?.dispose();
}
