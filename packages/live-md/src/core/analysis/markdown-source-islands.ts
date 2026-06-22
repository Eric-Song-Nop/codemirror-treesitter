import { type EditorState, type SelectionRange, type Text } from "@codemirror/state";
import { type DocRange, type Tree } from "@codemirror-treesitter/language";
import { walkMarkdownBlocks } from "./markdown-block-cursor.js";
import {
  type MarkdownLeaf,
  type MarkdownLeafKind,
  type MarkdownMarkerRecord,
} from "./markdown-block-types.js";
import { isWhitespaceOnly } from "../util.js";

export type LiveMdSourceIslandLeaf = {
  contextKey: string;
  kind: MarkdownLeafKind | "marker";
  sourceRange: DocRange;
};

export type LiveMdSourceIslandAnalysis = {
  activeSourceRanges: readonly DocRange[];
  leaves: readonly LiveMdSourceIslandLeaf[];
};

export function analyzeLiveMdSourceIslands(input: {
  state: EditorState;
  tree: Tree;
}): LiveMdSourceIslandAnalysis {
  let walked = walkMarkdownBlocks(input.tree, input.state.doc);
  let leaves = withMarkerOnlySourceIslands(
    input.state.doc,
    walked.snapshot.leaves.map(sourceIslandLeaf),
    walked.snapshot.markers,
  );

  return {
    activeSourceRanges: activeMarkdownSourceRanges(input.state, leaves),
    leaves,
  };
}

export function activeMarkdownSourceRanges(
  state: EditorState,
  leaves: readonly LiveMdSourceIslandLeaf[],
) {
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
  leaves: readonly LiveMdSourceIslandLeaf[],
  position: number,
  assoc: -1 | 0 | 1,
) {
  let index = lastLeafStartingAtOrBefore(leaves, position);
  if (index >= 0) {
    let leaf = leaves[index]!;
    if (leafOwnsCaret(doc, leaf, position, assoc)) return leaf;
    if (leaf.sourceRange.from == position && index > 0) {
      let previous = leaves[index - 1]!;
      if (leafOwnsCaret(doc, previous, position, assoc)) return previous;
    }
  }
  return null;
}

function leafAtSelectionHead(
  doc: Text,
  leaves: readonly LiveMdSourceIslandLeaf[],
  range: SelectionRange,
) {
  return findSourceIslandLeaf(doc, leaves, range.head, range.assoc);
}

function lastLeafStartingAtOrBefore(leaves: readonly LiveMdSourceIslandLeaf[], position: number) {
  let low = 0;
  let high = leaves.length;
  while (low < high) {
    let mid = (low + high) >> 1;
    if (leaves[mid]!.sourceRange.from <= position) {
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
