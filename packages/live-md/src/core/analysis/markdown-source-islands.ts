import { type EditorState, type SelectionRange, type Text } from "@codemirror/state";
import { type DocRange, type Tree } from "@codemirror-treesitter/language";
import {
  type MarkdownLeafKind,
  type MarkdownLeafRecord,
  walkMarkdownLeaves,
} from "./markdown-leaf-spike.js";
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
  let walked = walkMarkdownLeaves(input.tree, input.state.doc);
  let leaves = withMarkerOnlySourceIslands(
    input.state.doc,
    walked.leaves.map((leaf) => sourceIslandLeaf(input.state.doc, leaf)),
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

function leafAtSelectionHead(
  doc: Text,
  leaves: readonly LiveMdSourceIslandLeaf[],
  range: SelectionRange,
) {
  let index = lastLeafStartingAtOrBefore(leaves, range.head);
  if (index >= 0) {
    let leaf = leaves[index]!;
    if (leafOwnsSelectionHead(doc, leaf, range)) return leaf;
    if (leaf.sourceRange.from == range.head && index > 0) {
      let previous = leaves[index - 1]!;
      if (leafOwnsSelectionHead(doc, previous, range)) return previous;
    }
  }
  return null;
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

function sourceIslandLeaf(doc: Text, leaf: MarkdownLeafRecord): LiveMdSourceIslandLeaf {
  return {
    contextKey: leaf.contextKey,
    kind: leaf.kind,
    sourceRange: leafSourceRange(doc, leaf),
  };
}

function leafSourceRange(doc: Text, leaf: MarkdownLeafRecord): DocRange {
  if (leaf.from >= leaf.to) return { from: leaf.from, to: leaf.to };
  let firstLine = doc.lineAt(leaf.from);
  let lastLine = doc.lineAt(Math.max(leaf.from, leaf.to - 1));
  while (
    lastLine.number > firstLine.number &&
    isWhitespaceOnly(doc.sliceString(lastLine.from, lastLine.to))
  ) {
    lastLine = doc.line(lastLine.number - 1);
  }
  return { from: firstLine.from, to: lastLine.to };
}

function withMarkerOnlySourceIslands(
  doc: Text,
  leaves: readonly LiveMdSourceIslandLeaf[],
): LiveMdSourceIslandLeaf[] {
  let markerLeaves: LiveMdSourceIslandLeaf[] = [];
  let leafIndex = 0;
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
    let line = doc.line(lineNumber);
    while (leafIndex < leaves.length && leaves[leafIndex]!.sourceRange.to <= line.from) {
      leafIndex++;
    }
    if (!isMarkerOnlyLine(doc.sliceString(line.from, line.to))) continue;
    if (lineOverlapsLeaf(line.from, line.to, leaves, leafIndex)) continue;
    markerLeaves.push({
      contextKey: "marker",
      kind: "marker",
      sourceRange: { from: line.from, to: line.to },
    });
  }
  if (!markerLeaves.length) return [...leaves];
  return [...leaves, ...markerLeaves].sort(compareSourceIslandLeaf);
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

function isMarkerOnlyLine(source: string) {
  let rest = source.trimEnd().replace(/^\s+/u, "");
  if (!rest) return false;
  while (rest.startsWith(">")) {
    rest = rest.slice(1).replace(/^\s*/u, "");
    if (!rest) return true;
  }
  return /^(?:[-+*]|\d+[.)])(?:\s*(?:\[[ xX]\])?)?$/u.test(rest);
}

function compareSourceIslandLeaf(left: LiveMdSourceIslandLeaf, right: LiveMdSourceIslandLeaf) {
  return (
    left.sourceRange.from - right.sourceRange.from ||
    left.sourceRange.to - right.sourceRange.to ||
    left.kind.localeCompare(right.kind)
  );
}
