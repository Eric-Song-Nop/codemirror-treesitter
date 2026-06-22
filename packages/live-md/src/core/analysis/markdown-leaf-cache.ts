import { type ChangeDesc, type Text } from "@codemirror/state";
import {
  type LeafAnalysisCache,
  type LeafAnalysisRangeIndex,
  type LeafAnalysisRangeIndexEntry,
  type LeafAnalysisRangeIndexNode,
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
import {
  emptyLiveMdLeafAnalysisTrace,
  type DocRange,
  type LiveMdLeafAnalysisTrace,
} from "./types.js";

export type LeafAnalysisCacheTrace = LiveMdLeafAnalysisTrace;

export type LeafAnalysisCacheTransition = {
  cache: LeafAnalysisCache;
  trace: LeafAnalysisCacheTrace;
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

export function emptyLeafAnalysisCacheTrace(): LeafAnalysisCacheTrace {
  return emptyLiveMdLeafAnalysisTrace();
}

export function createLeafAnalysisCache(
  records: readonly LeafAnalysisRecord[],
  nextCacheId: number,
): LeafAnalysisCache {
  let frozen = records.slice();
  let byId = new Map<number, LeafAnalysisRecord>();
  for (let record of frozen) byId.set(record.cacheId, record);
  return {
    byId,
    nextCacheId,
    records: Object.freeze(frozen),
    safetyIndex: buildSafetyIndex(frozen),
  };
}

export function findLeafAnalysisRecordsTouchingRanges(
  cache: LeafAnalysisCache,
  ranges: readonly DocRange[],
): readonly LeafAnalysisRecord[] {
  if (!ranges.length) return [];
  let records: LeafAnalysisRecord[] = [];
  let seen = new Set<number>();
  for (let range of ranges) {
    for (let entry of safetyIndexEntriesTouching(cache.safetyIndex, range)) {
      if (seen.has(entry.record.cacheId)) continue;
      seen.add(entry.record.cacheId);
      records.push(entry.record);
    }
  }
  return records.sort(
    (left, right) => left.range.from - right.range.from || left.range.to - right.range.to,
  );
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
  let oldCandidates = mappedOldRecordCandidates(
    input.oldCache.records,
    input.changes,
    input.yieldCheck,
  );
  let nextCacheId = input.oldCache.nextCacheId;
  let trace = emptyLeafAnalysisCacheTrace();
  trace.recordsVisited = units.length;
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

function mappedOldRecordCandidates(
  records: readonly LeafAnalysisRecord[],
  changes: ChangeDesc,
  yieldCheck?: () => void,
): ReadonlyMap<string, readonly MappedOldRecord[]> {
  let candidates = new Map<string, MappedOldRecord[]>();
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

function buildSafetyIndex(records: readonly LeafAnalysisRecord[]) {
  let entries = records.map((record) => ({
    range: unionRanges(record.range, record.sourceRange, record.effectRange),
    record,
  }));
  return Object.freeze({ root: buildSafetyIndexNode(entries) });
}

function safetyIndexEntriesTouching(index: LeafAnalysisRangeIndex, range: DocRange) {
  let entries: LeafAnalysisRangeIndexEntry[] = [];
  collectSafetyIndexEntriesTouching(index.root, range, entries);
  return entries;
}

function buildSafetyIndexNode(
  entries: readonly LeafAnalysisRangeIndexEntry[],
): LeafAnalysisRangeIndexNode | null {
  if (!entries.length) return null;

  let center = medianRangeCenter(entries);
  let left: LeafAnalysisRangeIndexEntry[] = [];
  let right: LeafAnalysisRangeIndexEntry[] = [];
  let spanning: LeafAnalysisRangeIndexEntry[] = [];
  for (let entry of entries) {
    if (entry.range.to < center) {
      left.push(entry);
    } else if (entry.range.from > center) {
      right.push(entry);
    } else {
      spanning.push(entry);
    }
  }

  return Object.freeze({
    byEnd: Object.freeze(
      spanning
        .slice()
        .sort(
          (a, b) =>
            b.range.to - a.range.to ||
            a.range.from - b.range.from ||
            a.record.cacheId - b.record.cacheId,
        ),
    ),
    byStart: Object.freeze(
      spanning
        .slice()
        .sort(
          (a, b) =>
            a.range.from - b.range.from ||
            a.range.to - b.range.to ||
            a.record.cacheId - b.record.cacheId,
        ),
    ),
    center,
    left: buildSafetyIndexNode(left),
    right: buildSafetyIndexNode(right),
  });
}

function collectSafetyIndexEntriesTouching(
  node: LeafAnalysisRangeIndexNode | null,
  range: DocRange,
  entries: LeafAnalysisRangeIndexEntry[],
) {
  if (!node) return;

  if (range.from == range.to) {
    collectSafetyIndexEntriesTouchingPoint(node, range.from, entries);
    return;
  }

  if (range.to <= node.center) {
    for (let entry of node.byStart) {
      if (entry.range.from >= range.to) break;
      if (rangesTouch(entry.range, range)) entries.push(entry);
    }
    collectSafetyIndexEntriesTouching(node.left, range, entries);
    return;
  }

  if (range.from >= node.center) {
    for (let entry of node.byEnd) {
      if (entry.range.to <= range.from) break;
      if (rangesTouch(entry.range, range)) entries.push(entry);
    }
    collectSafetyIndexEntriesTouching(node.right, range, entries);
    return;
  }

  for (let entry of node.byStart) {
    if (rangesTouch(entry.range, range)) entries.push(entry);
  }
  collectSafetyIndexEntriesTouching(node.left, range, entries);
  collectSafetyIndexEntriesTouching(node.right, range, entries);
}

function collectSafetyIndexEntriesTouchingPoint(
  node: LeafAnalysisRangeIndexNode,
  position: number,
  entries: LeafAnalysisRangeIndexEntry[],
) {
  if (position < node.center) {
    for (let entry of node.byStart) {
      if (entry.range.from > position) break;
      if (rangesTouch(entry.range, { from: position, to: position })) entries.push(entry);
    }
    collectSafetyIndexEntriesTouching(node.left, { from: position, to: position }, entries);
    return;
  }

  if (position > node.center) {
    for (let entry of node.byEnd) {
      if (entry.range.to < position) break;
      if (rangesTouch(entry.range, { from: position, to: position })) entries.push(entry);
    }
    collectSafetyIndexEntriesTouching(node.right, { from: position, to: position }, entries);
    return;
  }

  for (let entry of node.byStart) entries.push(entry);
}

function medianRangeCenter(entries: readonly LeafAnalysisRangeIndexEntry[]) {
  let centers = entries
    .map((entry) => entry.range.from + Math.floor((entry.range.to - entry.range.from) / 2))
    .sort((left, right) => left - right);
  return centers[centers.length >> 1]!;
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
