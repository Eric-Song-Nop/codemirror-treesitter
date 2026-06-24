import { type LeafAnalysis, type LeafAnalysisRecord } from "../descriptors.js";
import { type DocRange } from "../types.js";

export type RelativeRange = {
  from: number;
  to: number;
};

export type RelativeMarkdownBlockContext = {
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

export type LeafRecordPayload = {
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

export function leafRecordPayload(record: LeafAnalysisRecord, anchor: number): LeafRecordPayload {
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

export function recordFromPayload(payload: LeafRecordPayload, anchor: number): LeafAnalysisRecord {
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

export function relativeMarkdownBlockContext(
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

export function absoluteMarkdownBlockContext(
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

export function relativeRange(range: DocRange, anchor: number): RelativeRange {
  return { from: range.from - anchor, to: range.to - anchor };
}

export function absoluteRange(range: RelativeRange, anchor: number): DocRange {
  return { from: range.from + anchor, to: range.to + anchor };
}

export function recordCacheSourceRange(record: LeafAnalysisRecord) {
  if (record.kind != "marker") return record.sourceRange;
  return record.cacheSourceRange ?? record.sourceRange;
}

export function recordCacheSourceHash(record: LeafAnalysisRecord) {
  if (record.kind != "marker") return record.sourceHash;
  return record.cacheSourceHash ?? record.sourceHash;
}

export function recordCacheStructuralKey(record: LeafAnalysisRecord) {
  if (record.kind != "marker") return record.structuralKey;
  return record.cacheStructuralKey ?? record.structuralKey;
}

export function recordIdentityRange(record: LeafAnalysisRecord) {
  return record.kind == "marker" ? recordCacheSourceRange(record) : record.range;
}
