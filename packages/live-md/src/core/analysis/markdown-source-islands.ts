import {
  type ChangeDesc,
  type EditorState,
  type SelectionRange,
  type Text,
} from "@codemirror/state";
import { type DocRange, type Tree } from "@codemirror-treesitter/language";
import { walkMarkdownBlocks } from "./markdown-block-cursor.js";
import {
  type MarkdownLeaf,
  type MarkdownLeafKind,
  type MarkdownBlockSnapshot,
  type MarkdownMarkerRecord,
} from "./markdown-block-types.js";
import { type LeafAnalysisRecord } from "./descriptors.js";
import { isWhitespaceOnly } from "../util.js";
import { mapRange, normalizeRanges, rangesTouchPoint } from "./ranges.js";

export type LiveMdSourceIslandLeaf = {
  contextKey: string;
  kind: MarkdownLeafKind | "marker";
  sourceRange: DocRange;
};

export type SourceIslandIndex = {
  readonly length: number;
  at(index: number): LiveMdSourceIslandLeaf | undefined;
  find(doc: Text, position: number, assoc: -1 | 0 | 1): LiveMdSourceIslandLeaf | null;
  /** Materializes; O(n). Prefer at()/find(). */
  toArray(): readonly LiveMdSourceIslandLeaf[];
};

export type LiveMdSourceIslandAnalysis = {
  activeSourceRanges: readonly DocRange[];
  leaves: SourceIslandIndex;
};

const sourceIslandLeafSegments = Symbol("sourceIslandLeafSegments");

type SourceIslandLeafSegment =
  | {
      leaves: SourceIslandIndex;
      type: "leaves";
    }
  | {
      changes: ChangeDesc;
      fromIndex: number;
      leaves: SourceIslandIndex;
      toIndex: number;
      type: "mapped";
    };

type SegmentedSourceIslandIndex = SourceIslandIndex & {
  [sourceIslandLeafSegments]?: readonly SourceIslandLeafSegment[];
};

export function analyzeLiveMdSourceIslands(input: {
  state: EditorState;
  tree: Tree;
}): LiveMdSourceIslandAnalysis {
  let walked = walkMarkdownBlocks(input.tree, input.state.doc);
  let leaves = sourceIslandLeavesFromMarkdownSnapshot(input.state.doc, walked.snapshot);

  return {
    activeSourceRanges: activeMarkdownSourceRanges(input.state, leaves),
    leaves,
  };
}

export function sourceIslandLeavesFromMarkdownSnapshot(
  doc: Text,
  snapshot: MarkdownBlockSnapshot,
): SourceIslandIndex {
  return sourceIslandIndexFromLeaves(
    withMarkerOnlySourceIslands(doc, snapshot.leaves.map(sourceIslandLeaf), snapshot.markers),
  );
}

export function sourceIslandLeavesFromLeafAnalysisRecords(
  doc: Text,
  records: readonly LeafAnalysisRecord[],
): SourceIslandIndex {
  let leaves = records
    .filter((record) => record.kind != "marker")
    .map((record) => ({
      contextKey: record.contextKey,
      kind: record.kind as MarkdownLeafKind,
      sourceRange: record.sourceRange,
    }));
  let markers = records
    .filter((record) => record.kind == "marker")
    .map(
      (record): MarkdownMarkerRecord => ({
        context: record.context,
        contextKey: record.contextKey,
        kind: "listMarker",
        lineRange: record.sourceRange,
        range: record.range,
        text: doc.sliceString(record.range.from, record.range.to),
      }),
    );
  return sourceIslandIndexFromLeaves(withMarkerOnlySourceIslands(doc, leaves, markers));
}

export function transitionSourceIslandLeavesFromLeafAnalysisRecords(input: {
  changes: ChangeDesc;
  doc: Text;
  localRecords: readonly LeafAnalysisRecord[];
  localWindows: readonly DocRange[];
  oldChangedRanges: readonly DocRange[];
  oldDoc: Text;
  oldLeaves: SourceIslandIndex;
}): SourceIslandIndex {
  let oldLocalWindows = input.localWindows.map((range) =>
    mapRange(range, input.changes.invertedDesc),
  );
  let oldRemovalRanges = normalizeRanges(
    [...input.oldChangedRanges, ...oldLocalWindows],
    input.oldDoc.length,
  );
  let excludedIndexes = sourceIslandLeafIndexesTouchingRanges(input.oldLeaves, oldRemovalRanges);
  let localLeaves = sourceIslandLeavesFromLeafAnalysisRecords(input.doc, input.localRecords);
  let segments: SourceIslandLeafSegment[] = [
    ...mappedSourceIslandLeafSegments(input.oldLeaves, input.changes, excludedIndexes),
  ];
  if (localLeaves.length) segments.push({ leaves: localLeaves, type: "leaves" });
  return createSegmentedSourceIslandIndex(segments);
}

export function sourceIslandIndexFromLeaves(
  leaves: readonly LiveMdSourceIslandLeaf[],
): SourceIslandIndex {
  let index: SourceIslandIndex = {
    length: leaves.length,
    at(position) {
      if (!Number.isInteger(position) || position < 0 || position >= leaves.length) {
        return undefined;
      }
      return leaves[position];
    },
    find(doc, position, assoc) {
      return findSourceIslandLeafInIndex(doc, index, position, assoc);
    },
    toArray() {
      return leaves;
    },
  };
  return index;
}

export function sourceIslandLeavesInDoc(leaves: SourceIslandIndex, docLength: number) {
  let segments = (leaves as SegmentedSourceIslandIndex)[sourceIslandLeafSegments];
  if (segments) return true;
  for (let index = 0; index < leaves.length; index++) {
    let leaf = leaves.at(index)!;
    if (
      leaf.sourceRange.from < 0 ||
      leaf.sourceRange.from > leaf.sourceRange.to ||
      leaf.sourceRange.to > docLength
    ) {
      return false;
    }
  }
  return true;
}

export function activeMarkdownSourceRanges(state: EditorState, leaves: SourceIslandIndex) {
  let active: DocRange[] = [];
  let seen = new Set<string>();
  for (let range of state.selection.ranges) {
    let leaf = leafAtSelectionHead(state.doc, leaves, range);
    if (!leaf) continue;
    let sourceRange = leaf.sourceRange;
    let key = `${sourceRange.from}:${sourceRange.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    active.push(sourceRange);
  }
  return active;
}

export function findSourceIslandLeaf(
  doc: Text,
  leaves: SourceIslandIndex,
  position: number,
  assoc: -1 | 0 | 1,
) {
  return leaves.find(doc, position, assoc);
}

function leafAtSelectionHead(doc: Text, leaves: SourceIslandIndex, range: SelectionRange) {
  return leaves.find(doc, range.head, range.assoc);
}

function createSegmentedSourceIslandIndex(segments: readonly SourceIslandLeafSegment[]) {
  let sortedSegments = segments
    .filter((segment) => segmentLength(segment) > 0)
    .slice()
    .sort(compareSourceIslandLeafSegments);
  let starts: number[] = [];
  let count = 0;
  for (let segment of sortedSegments) {
    starts.push(count);
    count += segmentLength(segment);
  }
  let materialized: readonly LiveMdSourceIslandLeaf[] | null = null;
  let index: SegmentedSourceIslandIndex = {
    get length() {
      return count;
    },
    at(position) {
      return sourceIslandLeafAt(position);
    },
    find(doc, position, assoc) {
      return findSourceIslandLeafInIndex(doc, index, position, assoc);
    },
    toArray() {
      return materializedLeaves();
    },
    [sourceIslandLeafSegments]: sortedSegments,
  };
  return index;

  function sourceIslandLeafAt(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= count) return undefined;
    let segmentIndex = segmentIndexAt(starts, index);
    let segment = sortedSegments[segmentIndex]!;
    return sourceIslandLeafInSegment(segment, index - starts[segmentIndex]!);
  }

  function materializedLeaves() {
    if (!materialized) {
      let leaves: LiveMdSourceIslandLeaf[] = [];
      for (let segment of sortedSegments) {
        for (let index = 0; index < segmentLength(segment); index++) {
          leaves.push(sourceIslandLeafInSegment(segment, index));
        }
      }
      materialized = Object.freeze(leaves);
    }
    return materialized;
  }
}

function compareSourceIslandLeafSegments(
  left: SourceIslandLeafSegment,
  right: SourceIslandLeafSegment,
) {
  return compareSourceIslandLeaf(
    sourceIslandLeafInSegment(left, 0),
    sourceIslandLeafInSegment(right, 0),
  );
}

function segmentIndexAt(starts: readonly number[], index: number) {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    let mid = (low + high) >> 1;
    if (starts[mid]! <= index) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low - 1;
}

function segmentLength(segment: SourceIslandLeafSegment) {
  return segment.type == "leaves" ? segment.leaves.length : segment.toIndex - segment.fromIndex;
}

function sourceIslandLeafInSegment(segment: SourceIslandLeafSegment, index: number) {
  let leaf =
    segment.type == "leaves"
      ? segment.leaves.at(index)!
      : mapSourceIslandLeaf(segment.leaves.at(segment.fromIndex + index)!, segment.changes);
  return leaf;
}

function mapSourceIslandLeaf(
  leaf: LiveMdSourceIslandLeaf,
  changes: ChangeDesc,
): LiveMdSourceIslandLeaf {
  return {
    ...leaf,
    sourceRange: mapRange(leaf.sourceRange, changes),
  };
}

function findSourceIslandLeafInIndex(
  doc: Text,
  leaves: SourceIslandIndex,
  position: number,
  assoc: -1 | 0 | 1,
) {
  let index = lastLeafStartingAtOrBefore(leaves, position);
  if (index >= 0) {
    let leaf = leaves.at(index)!;
    if (leafOwnsCaret(doc, leaf, position, assoc)) return leaf;
    if (leaf.sourceRange.from == position && index > 0) {
      let previous = leaves.at(index - 1)!;
      if (leafOwnsCaret(doc, previous, position, assoc)) return previous;
    }
  }
  return null;
}

function lastLeafStartingAtOrBefore(leaves: SourceIslandIndex, position: number) {
  let low = 0;
  let high = leaves.length;
  while (low < high) {
    let mid = (low + high) >> 1;
    if (leaves.at(mid)!.sourceRange.from <= position) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low - 1;
}

export function leafOwnsSelectionHead(
  doc: Text,
  leaf: LiveMdSourceIslandLeaf,
  range: SelectionRange,
) {
  return leafOwnsCaret(doc, leaf, range.head, range.assoc);
}

export function leafOwnsCaret(
  doc: Text,
  leaf: LiveMdSourceIslandLeaf,
  position: number,
  assoc: -1 | 0 | 1,
) {
  let { from, to } = leaf.sourceRange;
  if (position < from || position > to) return false;
  if (position > from && position < to) return true;
  if (position == from) return assoc >= 0;
  if (position != to || to <= from) return false;
  if (assoc > 0) return false;
  return doc.lineAt(position).number == doc.lineAt(to - 1).number;
}

function sourceIslandLeaf(leaf: MarkdownLeaf): LiveMdSourceIslandLeaf {
  return {
    contextKey: leaf.contextKey,
    kind: leaf.kind,
    sourceRange: leaf.sourceRange,
  };
}

function withMarkerOnlySourceIslands(
  doc: Text,
  leaves: readonly LiveMdSourceIslandLeaf[],
  markers: readonly MarkdownMarkerRecord[],
): LiveMdSourceIslandLeaf[] {
  let markerLeaves: LiveMdSourceIslandLeaf[] = [];
  let leafIndex = 0;
  for (let group of markerLineGroups(markers)) {
    let line = group[0]!.lineRange;
    while (leafIndex < leaves.length && leaves[leafIndex]!.sourceRange.to <= line.from) {
      leafIndex++;
    }
    if (lineOverlapsLeaf(line.from, line.to, leaves, leafIndex)) continue;
    if (!lineContainsOnlyMarkers(doc, line, group)) continue;
    let owner = group[group.length - 1]!;
    markerLeaves.push({
      contextKey: owner.contextKey,
      kind: "marker",
      sourceRange: { from: line.from, to: line.to },
    });
  }
  if (!markerLeaves.length) return [...leaves];
  return [...leaves, ...markerLeaves].sort(compareSourceIslandLeaf);
}

function markerLineGroups(markers: readonly MarkdownMarkerRecord[]) {
  let groups = new Map<string, MarkdownMarkerRecord[]>();
  for (let marker of markers) {
    let key = `${marker.lineRange.from}:${marker.lineRange.to}`;
    let group = groups.get(key);
    if (group) {
      group.push(marker);
    } else {
      groups.set(key, [marker]);
    }
  }
  return Array.from(groups.values()).map((group) =>
    group.sort(
      (left, right) => left.range.from - right.range.from || left.range.to - right.range.to,
    ),
  );
}

function lineOverlapsLeaf(
  from: number,
  to: number,
  leaves: readonly LiveMdSourceIslandLeaf[],
  startIndex: number,
) {
  for (let index = startIndex; index < leaves.length; index++) {
    let range = leaves[index]!.sourceRange;
    if (range.from >= to) break;
    if (range.from < to && from < range.to) return true;
  }
  return false;
}

function lineContainsOnlyMarkers(
  doc: Text,
  line: DocRange,
  markers: readonly MarkdownMarkerRecord[],
) {
  let position = line.from;
  for (let marker of markers) {
    if (!isWhitespaceOnly(doc.sliceString(position, marker.range.from))) return false;
    position = Math.max(position, marker.range.to);
  }
  return isWhitespaceOnly(doc.sliceString(position, line.to));
}

function compareSourceIslandLeaf(left: LiveMdSourceIslandLeaf, right: LiveMdSourceIslandLeaf) {
  return (
    left.sourceRange.from - right.sourceRange.from ||
    left.sourceRange.to - right.sourceRange.to ||
    left.kind.localeCompare(right.kind)
  );
}

function sourceIslandLeafIndexesTouchingRanges(
  leaves: SourceIslandIndex,
  ranges: readonly DocRange[],
) {
  let indexes: number[] = [];
  let seen = new Set<number>();
  for (let range of ranges) {
    let index = firstSourceIslandLeafPossiblyTouchingRange(leaves, range);
    for (; index < leaves.length; index++) {
      let leafRange = leaves.at(index)!.sourceRange;
      if (range.from == range.to ? leafRange.from > range.from : leafRange.from >= range.to) {
        break;
      }
      if (rangesTouchPoint(leafRange, range) && !seen.has(index)) {
        seen.add(index);
        indexes.push(index);
      }
    }
  }
  return indexes.sort((left, right) => left - right);
}

function firstSourceIslandLeafPossiblyTouchingRange(leaves: SourceIslandIndex, range: DocRange) {
  let low = 0;
  let high = leaves.length;
  while (low < high) {
    let mid = (low + high) >> 1;
    if (leaves.at(mid)!.sourceRange.to < range.from) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function mappedSourceIslandLeafSegments(
  leaves: SourceIslandIndex,
  changes: ChangeDesc,
  excludedIndexes: readonly number[],
) {
  let segments: SourceIslandLeafSegment[] = [];
  let start = 0;
  for (let index of excludedIndexes) {
    if (start < index) appendMappedSourceIslandLeafRun(segments, leaves, changes, start, index);
    start = index + 1;
  }
  if (start < leaves.length) {
    appendMappedSourceIslandLeafRun(segments, leaves, changes, start, leaves.length);
  }
  return segments;
}

function appendMappedSourceIslandLeafRun(
  target: SourceIslandLeafSegment[],
  leaves: SourceIslandIndex,
  changes: ChangeDesc,
  fromIndex: number,
  toIndex: number,
) {
  if (fromIndex >= toIndex) return;
  let sourceSegments = (leaves as SegmentedSourceIslandIndex)[sourceIslandLeafSegments];
  if (!sourceSegments) {
    target.push({ changes, fromIndex, leaves, toIndex, type: "mapped" });
    return;
  }

  let segmentStart = 0;
  for (let segment of sourceSegments) {
    let segmentEnd = segmentStart + segmentLength(segment);
    let from = Math.max(fromIndex, segmentStart);
    let to = Math.min(toIndex, segmentEnd);
    if (from < to) {
      appendMappedSourceIslandLeafSegmentRun(
        target,
        segment,
        changes,
        from - segmentStart,
        to - segmentStart,
      );
    }
    if (segmentEnd >= toIndex) break;
    segmentStart = segmentEnd;
  }
}

function appendMappedSourceIslandLeafSegmentRun(
  target: SourceIslandLeafSegment[],
  segment: SourceIslandLeafSegment,
  changes: ChangeDesc,
  fromIndex: number,
  toIndex: number,
) {
  if (fromIndex >= toIndex) return;
  if (segment.type == "leaves") {
    target.push({ changes, fromIndex, leaves: segment.leaves, toIndex, type: "mapped" });
    return;
  }
  appendMappedSourceIslandLeafRun(
    target,
    segment.leaves,
    segment.changes.composeDesc(changes),
    segment.fromIndex + fromIndex,
    segment.fromIndex + toIndex,
  );
}
