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
  type LiveMdLeafSemanticAnalysisInput,
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
  type LiveMdSourceIslandLeaf,
} from "./markdown-source-islands.js";
import {
  emptyLiveMdLeafAnalysisTrace,
  type DocRange,
  type LiveMdLeafAnalysisTrace,
} from "./types.js";

export type LeafAnalysisCacheTrace = LiveMdLeafAnalysisTrace;

export type LeafAnalysisCacheTransition = {
  cache: LeafAnalysisCache;
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

type MappedOldRecord = {
  cacheSourceRange: DocRange;
  record: LeafAnalysisRecord;
  range: DocRange;
  sourceRange: DocRange;
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
  "cacheIndexCallbacks" | "cacheIndexQueries" | "recordsMappedIndividually"
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

export function emptyLeafAnalysisCacheTrace(): LeafAnalysisCacheTrace {
  return emptyLiveMdLeafAnalysisTrace();
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
  if (trace) trace.cacheIndexQueries += ranges.length;

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
  snapshot: MarkdownBlockSnapshot;
  startCacheId?: number;
  yieldCheck?: () => void;
}): LeafAnalysisCacheTransition {
  let nextCacheId = input.startCacheId ?? 1;
  let trace = emptyLeafAnalysisCacheTrace();
  let units = markdownLeafAnalysisUnits(input.analysisInput.state.doc, input.snapshot);
  trace.recordsVisited = units.length;
  trace.leavesCollected = units.length;
  let records: LeafAnalysisRecord[] = [];
  let inlineSession: MarkdownInlineAnalysisSession | null = null;
  try {
    for (let index = 0; index < units.length; index++) {
      if (index % 32 == 0) input.yieldCheck?.();
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
    }
  } finally {
    disposeInlineSession(inlineSession);
  }
  return {
    cache: createLeafAnalysisCache(records, nextCacheId),
    trace,
  };

  function inlineSessionHolder() {
    return (inlineSession ??= createMarkdownInlineAnalysisSession({
      blockTree: input.analysisInput.tree,
      doc: input.analysisInput.state.doc,
      service: input.analysisInput.service,
      trace,
    }));
  }
}

export function transitionLeafAnalysisCache(input: {
  analysisInput: LiveMdLeafSemanticAnalysisInput;
  changes: ChangeDesc;
  oldCache: LeafAnalysisCache;
  oldDoc: Text;
  snapshot: MarkdownBlockSnapshot;
  yieldCheck?: () => void;
}): LeafAnalysisCacheTransition {
  let units = markdownLeafAnalysisUnits(input.analysisInput.state.doc, input.snapshot);
  let trace = emptyLeafAnalysisCacheTrace();
  let oldCandidates = mappedOldRecordCandidates(
    materializeLeafAnalysisCacheRecords(input.oldCache, trace),
    input.changes,
    input.yieldCheck,
    trace,
  );
  let nextCacheId = input.oldCache.nextCacheId;
  trace.recordsVisited = units.length;
  trace.leavesCollected = units.length;
  let records: LeafAnalysisRecord[] = [];
  let usedOldIds = new Set<number>();
  let inlineSession: MarkdownInlineAnalysisSession | null = null;

  try {
    for (let index = 0; index < units.length; index++) {
      if (index % 32 == 0) input.yieldCheck?.();
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
          continue;
        }
        trace.recordsReused++;
        records.push(createAnalysisRecord(unit, reused.record.analysis, reused.record.cacheId));
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
    }
  } finally {
    disposeInlineSession(inlineSession);
  }

  return {
    cache: createLeafAnalysisCache(records, nextCacheId),
    trace,
  };

  function inlineSessionHolder() {
    return (inlineSession ??= createMarkdownInlineAnalysisSession({
      blockTree: input.analysisInput.tree,
      doc: input.analysisInput.state.doc,
      service: input.analysisInput.service,
      trace,
    }));
  }
}

export function transitionLeafAnalysisCacheLocal(
  input: LeafAnalysisCacheLocalTransitionInput,
): LeafAnalysisCacheTransition {
  let local = collectLocalMarkdownSnapshot(input);
  if (local.trace.fallbackCount) {
    return {
      cache: input.oldCache,
      fallback: "fullWalk",
      trace: local.trace,
    };
  }

  let units = markdownLeafAnalysisUnits(input.analysisInput.state.doc, local.snapshot);
  let oldChangedRanges = changedOldRanges(input.changes);
  let localWindows = localReplacementRanges(input.analysisInput.state.doc.length, local.snapshot);
  let trace = local.trace;
  let oldCandidateEntries = uniqueRecordEntries([
    ...local.oldAffectedEntries,
    ...localCandidateEntries(input.oldCache, input.changes, oldChangedRanges, localWindows, trace),
  ]);
  let oldCandidateRecords = oldCandidateEntries.map((entry) => entry.record);
  trace.recordsCollected = oldCandidateEntries.length;
  let oldCandidates = mappedOldRecordCandidates(
    oldCandidateRecords,
    input.changes,
    input.yieldCheck,
    trace,
  );
  let nextCacheId = input.oldCache.nextCacheId;
  trace.recordsVisited = units.length;
  let localRecords: LeafAnalysisRecord[] = [];
  let usedOldIds = new Set<number>();
  let inlineSession: MarkdownInlineAnalysisSession | null = null;

  try {
    for (let index = 0; index < units.length; index++) {
      if (index % 32 == 0) input.yieldCheck?.();
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
          localRecords.push(
            analyzeMarkdownLeafAnalysisUnit(
              analysisInputWithInlineSession(input.analysisInput, inlineSessionHolder),
              unit,
              reused.record.cacheId,
              trace,
            ),
          );
          continue;
        }
        trace.recordsReused++;
        localRecords.push(
          createAnalysisRecord(unit, reused.record.analysis, reused.record.cacheId),
        );
        continue;
      }

      trace.recordsAnalyzed++;
      localRecords.push(
        analyzeMarkdownLeafAnalysisUnit(
          analysisInputWithInlineSession(input.analysisInput, inlineSessionHolder),
          unit,
          nextCacheId++,
          trace,
        ),
      );
    }
  } finally {
    disposeInlineSession(inlineSession);
  }

  localRecords.sort(compareAnalysisRecords);
  trace.recordsReused += cacheRecordCount(input.oldCache) - oldCandidateEntries.length;
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
    sourceIslandLeaves,
    trace,
  };

  function inlineSessionHolder() {
    return (inlineSession ??= createMarkdownInlineAnalysisSession({
      blockTree: input.analysisInput.tree,
      doc: input.analysisInput.state.doc,
      service: input.analysisInput.service,
      trace,
    }));
  }
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

function patchLeafAnalysisCache(
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
    let safetyRange = clampRange(recordInvalidationRange(record), docLength);
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
    sourceHash: record.sourceHash,
    sourceRange: relativeRange(record.sourceRange, anchor),
    structuralKey: record.structuralKey,
  });
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

function clampRange(range: DocRange, docLength: number): DocRange {
  let from = clamp(Math.min(range.from, range.to), 0, docLength);
  let to = clamp(Math.max(range.from, range.to), 0, docLength);
  return { from, to };
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
  let changeRanges: Array<{ newRange: DocRange; oldRange: DocRange }> = [];
  input.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    changeRanges.push({
      newRange: { from: fromB, to: toB },
      oldRange: { from: fromA, to: toA },
    });
  });

  let textContextRanges = changeRanges.map((range) =>
    expandTextChangeRange(input.oldDoc, newDoc, range.oldRange, range.newRange),
  );
  let oldContextRanges = changeRanges.map((range) =>
    expandOldTextChangeRange(input.oldDoc, newDoc, range.oldRange, range.newRange),
  );
  let traceCounters: LeafAnalysisCacheTraceCounters = {
    cacheIndexCallbacks: 0,
    cacheIndexQueries: 0,
    recordsMappedIndividually: 0,
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
      rangesTouch(record.range, range) ||
      rangesTouch(record.sourceRange, range) ||
      rangesTouch(record.effectRange, range) ||
      rangesTouch(recordCacheSourceRange(record), range),
  );
}

function recordInvalidationRange(record: LeafAnalysisRecord) {
  return unionRanges(
    record.range,
    record.sourceRange,
    record.effectRange,
    recordCacheSourceRange(record),
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
  if (record.kind != "marker") return record.structuralKey;
  return record.cacheStructuralKey ?? record.structuralKey;
}

function recordIdentityRange(record: LeafAnalysisRecord) {
  return record.kind == "marker" ? recordCacheSourceRange(record) : record.range;
}

function unitIdentityRange(unit: MarkdownLeafAnalysisUnit) {
  return unit.type == "marker" ? unit.cacheSourceRange : unit.range;
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

function isBroadContainerSyntaxRange(
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

function normalizeRanges(ranges: readonly DocRange[], docLength: number) {
  let sorted = ranges
    .map((range) => ({
      from: clamp(Math.min(range.from, range.to), 0, docLength),
      to: clamp(Math.max(range.from, range.to), 0, docLength),
    }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  let merged: DocRange[] = [];
  for (let range of sorted) {
    let last = merged[merged.length - 1];
    if (!last || range.from > last.to) {
      merged.push({ ...range });
    } else if (range.to > last.to) {
      last.to = range.to;
    }
  }
  return merged;
}

function rangesEqual(left: readonly DocRange[], right: readonly DocRange[]) {
  return (
    left.length == right.length && left.every((range, index) => rangesSame(range, right[index]!))
  );
}

function mapRange(range: DocRange, changes: ChangeDesc): DocRange {
  let from = changes.mapPos(clamp(range.from, 0, changes.length), 1);
  let to = changes.mapPos(clamp(range.to, 0, changes.length), -1);
  return from <= to ? { from, to } : { from: to, to: from };
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

function rangesSame(left: DocRange, right: DocRange) {
  return left.from == right.from && left.to == right.to;
}

function rangesTouch(left: DocRange, right: DocRange) {
  if (left.from == left.to && right.from == right.to) return left.from == right.from;
  if (left.from == left.to) return left.from >= right.from && left.from < right.to;
  if (right.from == right.to) return left.from <= right.from && left.to >= right.from;
  return left.from < right.to && right.from < left.to;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
