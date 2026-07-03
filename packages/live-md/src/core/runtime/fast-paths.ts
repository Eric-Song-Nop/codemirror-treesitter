import { type Transaction } from "@codemirror/state";
import { mergeDocRanges, type Tree } from "@codemirror-treesitter/language";
import { type LeafAnalysisRecord } from "../analysis/descriptors.js";
import { markdownBlockContextKey } from "../analysis/markdown-block-cursor.js";
import {
  findLeafAnalysisRecordsTouchingRanges,
  patchLeafAnalysisCache,
} from "../analysis/markdown-leaf-cache.js";
import {
  analyzeTaskMarkerRecordFastPath,
  rekeyLeafAnalysisForSource,
  type LiveMdRenderKeyContext,
} from "../analysis/markdown-leaf-analysis.js";
import {
  type LiveMdSourceIslandLeaf,
  type SourceIslandIndex,
} from "../analysis/markdown-source-islands.js";
import { type DocRange } from "../analysis/types.js";
import { hashDocRange, lineRangeFor, mapRange, rangesSame } from "../analysis/ranges.js";
import {
  compileIncrementalDirectLayoutProjection,
  type LiveMdProjectionCompileInput,
} from "../projection/compilers.js";
import { projectionSetsFromLayer } from "./projection-state.js";
import { type LiveMdRuntimeState } from "./types.js";

export function taskToggleFastPath(input: {
  activeLines: ReadonlySet<number>;
  activeSourceRanges: readonly DocRange[];
  compileInput: LiveMdProjectionCompileInput;
  transaction: Transaction;
  tree: Tree;
  value: LiveMdRuntimeState;
}): LiveMdRuntimeState | null {
  if (!input.value.semantic || input.value.pending) return null;
  let toggle = taskToggleChange(input.transaction);
  if (!toggle) return null;

  let candidates = findLeafAnalysisRecordsTouchingRanges(input.value.semantic.cache, [
    toggle.oldRange,
  ]).filter((record) => recordMatchesTaskToggle(record, input.transaction, toggle));
  if (candidates.length != 1) return null;

  let oldTaskRecord = candidates[0]!;
  let oldMarkerRange = recordMarkerRange(oldTaskRecord);
  let oldMarkerLine = lineRangeFor(
    input.transaction.startState.doc,
    oldMarkerRange.from,
    oldMarkerRange.to,
  );
  let newMarkerRange = mapRange(oldMarkerRange, input.transaction.changes);
  let newMarkerLine = lineRangeFor(
    input.transaction.state.doc,
    newMarkerRange.from,
    newMarkerRange.to,
  );

  let oldRecords = findLeafAnalysisRecordsTouchingRanges(input.value.semantic.cache, [
    oldMarkerLine,
  ]).filter((record) => recordHasTaskContext(record, oldMarkerRange));
  if (!oldRecords.some((record) => record.cacheId == oldTaskRecord.cacheId)) return null;
  if (oldRecords.some((record) => !recordIsConfinedToLine(record, oldMarkerLine))) return null;

  let newRecords: LeafAnalysisRecord[] = [];
  for (let record of oldRecords) {
    let next =
      record.cacheId == oldTaskRecord.cacheId
        ? analyzeTaskMarkerRecordFastPath({
            checked: toggle.checked,
            doc: input.transaction.state.doc,
            markerRange: newMarkerRange,
            record,
            renderKeyContext: input.value.renderKeyContext,
          })
        : mapTaskContextRecord(
            record,
            input.transaction,
            oldMarkerRange,
            newMarkerRange,
            toggle.checked,
            input.value.renderKeyContext,
          );
    if (!next) return null;
    newRecords.push(next);
  }

  let patchRanges = mergeDocRanges([
    ...oldRecords.map((record) => mapRange(record.effectRange, input.transaction.changes)),
    ...newRecords.map((record) => record.effectRange),
    newMarkerLine,
  ]);
  let cache = patchLeafAnalysisCache(
    input.value.semantic.cache,
    input.transaction.changes,
    patchRanges,
    new Set(oldRecords.map((record) => record.cacheId)),
    newRecords,
    input.value.semantic.cache.nextCacheId,
  );

  input.compileInput.trace.recordsVisited += newRecords.length;
  input.compileInput.trace.recordsAnalyzed += newRecords.length;
  let direct = compileIncrementalDirectLayoutProjection(input.compileInput, cache, {
    changes: input.transaction.changes,
    previous: input.value.direct,
    ranges: patchRanges,
    records: newRecords,
    removeRecordIds: oldRecords.map((record) => record.cacheId),
  });

  let oldContextKey = oldTaskRecord.contextKey;
  let newContextKey = markdownBlockContextKey(newRecords[0]!.context);
  return {
    activeLines: input.activeLines,
    activeSourceRanges: input.activeSourceRanges,
    direct: projectionSetsFromLayer(direct),
    pending: null,
    renderCache: input.value.renderCache,
    renderKeyContext: input.value.renderKeyContext,
    revision: input.value.revision + 1,
    semantic: {
      cache,
      revision: input.value.semantic.revision + 1,
    },
    semanticTrace: input.compileInput.trace,
    surfaceInvalidationRanges: [newMarkerLine],
    sourceIslandLeaves: mapTaskSourceIslandLeaves(
      input.value.sourceIslandLeaves,
      oldMarkerLine,
      oldContextKey,
      newContextKey,
    ),
    trace: input.compileInput.trace,
    tree: input.tree,
  };
}

type TaskToggleChange = {
  checked: boolean;
  oldRange: DocRange;
};

function taskToggleChange(transaction: Transaction): TaskToggleChange | null {
  if (!transaction.isUserEvent("input.task")) return null;

  let change: TaskToggleChange | null = null;
  let count = 0;
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    count++;
    if (count > 1 || toA - fromA != 1 || toB - fromB != 1) return;
    let oldText = transaction.startState.doc.sliceString(fromA, toA);
    let newText = transaction.state.doc.sliceString(fromB, toB);
    let checked = toggledTaskChecked(oldText, newText);
    if (checked == null) return;
    change = {
      checked,
      oldRange: { from: fromA, to: toA },
    };
  }, true);

  return count == 1 ? change : null;
}

function toggledTaskChecked(oldText: string, newText: string) {
  if (oldText == " " && isTaskCheckedText(newText)) return true;
  if (isTaskCheckedText(oldText) && newText == " ") return false;
  return null;
}

function isTaskCheckedText(value: string) {
  return value == "x" || value == "X";
}

function recordMatchesTaskToggle(
  record: LeafAnalysisRecord,
  transaction: Transaction,
  toggle: TaskToggleChange,
) {
  if (record.kind != "marker") return false;
  let markerRange = recordMarkerRange(record);
  if (markerRange.to - markerRange.from != 3) return false;
  if (toggle.oldRange.from != markerRange.from + 1 || toggle.oldRange.to != markerRange.from + 2) {
    return false;
  }
  let oldMarker = transaction.startState.doc.sliceString(markerRange.from, markerRange.to);
  if (!taskMarkerTextChecked(oldMarker, !toggle.checked)) return false;

  let descriptor = record.analysis.structuralEffects.find((effect) => effect.kind == "taskMarker");
  return descriptor?.kind == "taskMarker" && descriptor.checked != toggle.checked;
}

function mapTaskContextRecord(
  record: LeafAnalysisRecord,
  transaction: Transaction,
  oldMarkerRange: DocRange,
  newMarkerRange: DocRange,
  checked: boolean,
  renderKeyContext: LiveMdRenderKeyContext,
): LeafAnalysisRecord | null {
  let context = taskContextWithChecked(
    record,
    transaction,
    oldMarkerRange,
    newMarkerRange,
    checked,
  );
  if (!context) return null;

  let range = mapRange(record.range, transaction.changes);
  let sourceRange = mapRange(record.sourceRange, transaction.changes);
  let cacheSourceRange = record.cacheSourceRange
    ? mapRange(record.cacheSourceRange, transaction.changes)
    : undefined;
  let cacheSourceHash = cacheSourceRange
    ? hashDocRange(transaction.state.doc, cacheSourceRange)
    : undefined;
  let sourceHash = hashDocRange(transaction.state.doc, sourceRange);
  let renderSourceRange = cacheSourceRange ?? sourceRange;
  let analysis = rekeyLeafAnalysisForSource(record.analysis, {
    context: renderKeyContext,
    kind: record.kind,
    sourceHash: cacheSourceHash ?? sourceHash,
    sourceLength: renderSourceRange.to - renderSourceRange.from,
  });

  return {
    ...record,
    analysis,
    cacheSourceHash,
    cacheSourceRange,
    context,
    contextKey: markdownBlockContextKey(context),
    effectRange: mapRange(record.effectRange, transaction.changes),
    range,
    revealRange: record.revealRange ? mapRange(record.revealRange, transaction.changes) : null,
    sourceHash,
    sourceRange,
  };
}

function taskContextWithChecked(
  record: LeafAnalysisRecord,
  transaction: Transaction,
  oldMarkerRange: DocRange,
  newMarkerRange: DocRange,
  checked: boolean,
) {
  let changed = false;
  let listPath = record.context.listPath.map((item) => {
    let task = item.task
      ? {
          checked: rangesSame(item.task.range, oldMarkerRange) ? checked : item.task.checked,
          range: rangesSame(item.task.range, oldMarkerRange)
            ? newMarkerRange
            : mapRange(item.task.range, transaction.changes),
        }
      : null;
    if (item.task && rangesSame(item.task.range, oldMarkerRange)) changed = true;
    return {
      itemRange: mapRange(item.itemRange, transaction.changes),
      markerRange: mapRange(item.markerRange, transaction.changes),
      markerText: item.markerText,
      task,
    };
  });
  if (!changed) return null;
  return {
    listPath,
    quoteDepth: record.context.quoteDepth,
    quoteMarkers: record.context.quoteMarkers.map((range) => mapRange(range, transaction.changes)),
  };
}

function recordHasTaskContext(record: LeafAnalysisRecord, markerRange: DocRange) {
  return record.context.listPath.some(
    (item) => item.task && rangesSame(item.task.range, markerRange),
  );
}

function recordIsConfinedToLine(record: LeafAnalysisRecord, line: DocRange) {
  let cacheSourceRange = record.cacheSourceRange ?? record.sourceRange;
  return containsRange(line, record.sourceRange) && containsRange(line, cacheSourceRange);
}

function mapTaskSourceIslandLeaves(
  leaves: SourceIslandIndex,
  oldMarkerLine: DocRange,
  oldContextKey: string,
  newContextKey: string,
) {
  let mapped = (leaf: LiveMdSourceIslandLeaf): LiveMdSourceIslandLeaf =>
    leaf.contextKey == oldContextKey && containsRange(oldMarkerLine, leaf.sourceRange)
      ? { ...leaf, contextKey: newContextKey }
      : leaf;
  let index: SourceIslandIndex = {
    length: leaves.length,
    at(position) {
      let leaf = leaves.at(position);
      return leaf ? mapped(leaf) : undefined;
    },
    find(doc, position, assoc) {
      let leaf = leaves.find(doc, position, assoc);
      return leaf ? mapped(leaf) : null;
    },
    toArray() {
      return leaves.toArray().map(mapped);
    },
  };
  return index;
}

function taskMarkerTextChecked(text: string, checked: boolean) {
  return checked ? text == "[x]" || text == "[X]" : text == "[ ]";
}

function recordMarkerRange(record: LeafAnalysisRecord) {
  return record.cacheSourceRange ?? record.range;
}

function containsRange(outer: DocRange, inner: DocRange) {
  return outer.from <= inner.from && inner.to <= outer.to;
}
