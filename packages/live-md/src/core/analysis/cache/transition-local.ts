import {
  type ChangeDesc,
  type Range,
  type RangeSet,
  type RangeValue,
  type Text,
} from "@codemirror/state";
import { type LeafAnalysisRecord } from "../descriptors.js";
import { collectMarkdownBlocksInRanges } from "../markdown-block-cursor.js";
import { type MarkdownBlockSnapshot } from "../markdown-block-types.js";
import {
  analyzeMarkdownLeafAnalysisUnit,
  createAnalysisRecord,
  markdownLeafAnalysisUnits,
} from "../markdown-leaf-analysis.js";
import {
  createMarkdownInlineAnalysisSession,
  type MarkdownInlineAnalysisSession,
} from "../markdown-inline-analysis.js";
import { transitionSourceIslandLeavesFromLeafAnalysisRecords } from "../markdown-source-islands.js";
import { type DocRange } from "../types.js";
import {
  createLeafAnalysisCacheFromRangeSets,
  emptyLeafAnalysisCacheTrace,
  leafAnalysisCacheNextId,
  leafAnalysisCacheRecordCount,
  leafAnalysisCacheRecords,
  leafAnalysisCacheSafety,
  type LeafAnalysisCache,
  type LeafAnalysisCacheLocalTransitionInput,
  type LeafAnalysisCacheTrace,
  type LeafAnalysisCacheTraceCounters,
  type LeafAnalysisCacheTransition,
} from "./cache.js";
import { recordCacheSourceRange } from "./payload.js";
import {
  compareAnalysisRecords,
  leafRecordRanges,
  type LeafRecordSafetyRef,
  type PositionedLeafRecord,
} from "./record-range-value.js";
import {
  findLeafAnalysisRecordEntriesTouchingRanges,
  leafAnalysisRecordEntries,
  type LeafAnalysisRecordEntry,
} from "./query.js";
import {
  analysisInputWithInlineSession,
  disposeInlineSession,
  mappedOldRecordCandidates,
  mapRange,
  normalizeRanges,
  rangesEqual,
  reusableOldRecord,
} from "./transition-full.js";

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
  let changedOldIds = new Set<number>();
  trace.recordsCollected = oldCandidateEntries.length;
  let oldCandidates = mappedOldRecordCandidates(
    oldCandidateRecords,
    input.changes,
    input.yieldCheck,
    trace,
  );
  let nextCacheId = leafAnalysisCacheNextId(input.oldCache);
  trace.recordsVisited = units.length;
  let localRecords: LeafAnalysisRecord[] = [];
  let changedRecords: LeafAnalysisRecord[] = [];
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
          let record = analyzeMarkdownLeafAnalysisUnit(
            analysisInputWithInlineSession(input.analysisInput, inlineSessionHolder),
            unit,
            reused.record.cacheId,
            trace,
          );
          changedOldIds.add(reused.record.cacheId);
          localRecords.push(record);
          changedRecords.push(record);
          continue;
        }
        trace.recordsReused++;
        localRecords.push(
          createAnalysisRecord(unit, reused.record.analysis, reused.record.cacheId),
        );
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
    }
  } finally {
    disposeInlineSession(inlineSession);
  }

  localRecords.sort(compareAnalysisRecords);
  changedRecords.sort(compareAnalysisRecords);
  trace.recordsReused += leafAnalysisCacheRecordCount(input.oldCache) - oldCandidateEntries.length;
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
    return (inlineSession ??= createMarkdownInlineAnalysisSession({
      blockTree: input.analysisInput.tree,
      doc: input.analysisInput.state.doc,
      service: input.analysisInput.service,
      trace,
    }));
  }
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

function patchLeafAnalysisCache(
  oldCache: LeafAnalysisCache,
  changes: ChangeDesc,
  dirtyRanges: readonly DocRange[],
  excludedIds: ReadonlySet<number>,
  localRecords: readonly LeafAnalysisRecord[],
  nextCacheId: number,
) {
  let mappedRecords = leafAnalysisCacheRecords(oldCache).map(
    changes,
  ) as RangeSet<PositionedLeafRecord>;
  let mappedSafety = leafAnalysisCacheSafety(oldCache).map(
    changes,
  ) as RangeSet<LeafRecordSafetyRef>;
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
    leafAnalysisCacheRecordCount(oldCache) - excludedIds.size + localRecords.length,
    nextCacheId,
  );
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
