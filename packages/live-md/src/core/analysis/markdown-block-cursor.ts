import { type Text } from "@codemirror/state";
import { type DocRange, type SyntaxNode, type Tree } from "@codemirror-treesitter/language";
import { isWhitespaceOnly } from "../util.js";
import {
  type MarkdownBlockContext,
  type MarkdownBlockSnapshot,
  type MarkdownBlockTrace,
  type MarkdownLeaf,
  type MarkdownLeafKind,
  type MarkdownListItemContext,
  type MarkdownMarkerKind,
  type MarkdownMarkerRecord,
} from "./markdown-block-types.js";

type MarkdownTreeCursor = NonNullable<ReturnType<Tree["cursor"]>>;

type SnapshotBuilder = {
  leaves: MarkdownLeaf[];
  markers: MarkdownMarkerRecord[];
  seenLeaves: Set<string>;
  seenMarkers: Set<string>;
  trace: MarkdownBlockTrace;
};

const emptyContext: MarkdownBlockContext = { listPath: [], quoteDepth: 0, quoteMarkers: [] };

const leafKinds: ReadonlyMap<string, MarkdownLeafKind> = new Map([
  ["paragraph", "paragraph"],
  ["atx_heading", "heading"],
  ["setext_heading", "heading"],
  ["pipe_table", "table"],
  ["fenced_code_block", "fencedCode"],
  ["indented_code_block", "indentedCode"],
  ["html_block", "html"],
  ["thematic_break", "rule"],
]);

export function classifyMarkdownLeaf(node: SyntaxNode): MarkdownLeafKind | null {
  return leafKinds.get(node.name) ?? null;
}

export function walkMarkdownBlocks(
  tree: Tree,
  doc: Text,
): {
  snapshot: MarkdownBlockSnapshot;
  trace: MarkdownBlockTrace;
} {
  let builder = snapshotBuilder();
  let cursor = tree.cursor();
  if (!cursor) return finishSnapshot(builder, doc);
  try {
    walkFullCursor(cursor, doc, emptyContext, builder);
  } finally {
    cursor.delete();
  }
  return finishSnapshot(builder, doc);
}

export function collectMarkdownBlocksInRanges(
  tree: Tree,
  doc: Text,
  ranges: readonly DocRange[],
): {
  snapshot: MarkdownBlockSnapshot;
  trace: MarkdownBlockTrace;
} {
  let builder = snapshotBuilder();
  let checkedRanges = normalizeRanges(ranges, doc.length);

  for (let range of checkedRanges) {
    let cursor = tree.cursor();
    if (!cursor) continue;
    try {
      walkRangeCursor(cursor, doc, range, emptyContext, builder);
    } finally {
      cursor.delete();
    }
  }

  builder.trace.checkedRanges = checkedRanges;
  return finishSnapshot(builder, doc);
}

export function markdownBlockContextKey(context: MarkdownBlockContext) {
  let listPath = context.listPath
    .map((item) => `${item.markerText}${item.task ? (item.task.checked ? "[x]" : "[ ]") : ""}`)
    .join(">");
  return `q${context.quoteDepth}|${listPath}`;
}

export function compareMarkdownLeaves(left: MarkdownLeaf, right: MarkdownLeaf) {
  return (
    left.range.from - right.range.from ||
    left.range.to - right.range.to ||
    left.kind.localeCompare(right.kind)
  );
}

export function compareMarkdownMarkers(left: MarkdownMarkerRecord, right: MarkdownMarkerRecord) {
  return (
    left.range.from - right.range.from ||
    left.range.to - right.range.to ||
    left.kind.localeCompare(right.kind)
  );
}

function walkFullCursor(
  cursor: MarkdownTreeCursor,
  doc: Text,
  context: MarkdownBlockContext,
  builder: SnapshotBuilder,
) {
  builder.trace.visitedBlockNodes++;
  collectContainerMarkers(cursor, doc, context, builder, null);

  let node = cursor.node;
  let kind = classifyMarkdownLeaf(node);
  if (kind) {
    addLeaf(builder, leafRecord(node, kind, context, doc));
    return;
  }

  let childContext = contextAfterEntering(cursor, doc, context);
  let child = cursor.copy();
  try {
    if (child.firstChild()) {
      do {
        walkFullCursor(child, doc, childContext, builder);
      } while (child.nextSibling());
    }
  } finally {
    child.delete();
  }
}

function walkRangeCursor(
  cursor: MarkdownTreeCursor,
  doc: Text,
  range: DocRange,
  context: MarkdownBlockContext,
  builder: SnapshotBuilder,
) {
  builder.trace.visitedBlockNodes++;
  if (!rangesTouch(cursor, range)) return;
  collectContainerMarkers(cursor, doc, context, builder, range);

  let node = cursor.node;
  let kind = classifyMarkdownLeaf(node);
  if (kind) {
    addLeaf(builder, leafRecord(node, kind, context, doc));
    return;
  }

  let childContext = contextAfterEntering(cursor, doc, context);
  let child = cursor.copy();
  try {
    if (!firstRangeChild(child, range.from)) return;
    do {
      if (child.from > range.to) break;
      if (child.to >= range.from) {
        walkRangeCursor(child, doc, range, childContext, builder);
      }
    } while (child.nextSibling());
  } finally {
    child.delete();
  }
}

function collectContainerMarkers(
  cursor: MarkdownTreeCursor,
  doc: Text,
  context: MarkdownBlockContext,
  builder: SnapshotBuilder,
  range: DocRange | null,
) {
  let node = cursor.node;
  if (node.name == "block_quote") {
    let quoteContext = contextAfterEntering(cursor, doc, context);
    if (range) {
      collectRangeQuoteMarkers(cursor, doc, quoteContext, builder, range);
    } else {
      collectQuoteMarkers(node, doc, quoteContext, builder);
    }
    return;
  }

  if (node.name != "list_item") return;
  let listContext = contextAfterEntering(cursor, doc, context);
  for (let child of node.children) {
    if (isListMarker(child)) {
      addMarker(builder, markerRecord(doc, child, "listMarker", listContext));
    } else if (isTaskMarker(child)) {
      addMarker(builder, markerRecord(doc, child, "taskMarker", listContext));
    }
  }
}

function collectQuoteMarkers(
  node: SyntaxNode,
  doc: Text,
  context: MarkdownBlockContext,
  builder: SnapshotBuilder,
) {
  for (let child of node.children) {
    if (isQuoteMarker(child)) {
      addMarker(builder, markerRecord(doc, child, quoteMarkerKind(child), context));
    } else if (child.name != "block_quote") {
      collectQuoteMarkers(child, doc, context, builder);
    }
  }
}

function collectRangeQuoteMarkers(
  cursor: MarkdownTreeCursor,
  doc: Text,
  context: MarkdownBlockContext,
  builder: SnapshotBuilder,
  range: DocRange,
) {
  for (let line of lineRangesTouchingRange(doc, range)) {
    collectQuoteMarkersInCursorRange(cursor, doc, context, builder, line);
  }
}

function collectQuoteMarkersInCursorRange(
  cursor: MarkdownTreeCursor,
  doc: Text,
  context: MarkdownBlockContext,
  builder: SnapshotBuilder,
  range: DocRange,
) {
  let child = cursor.copy();
  try {
    if (!firstRangeChild(child, range.from)) return;
    do {
      if (child.from > range.to) break;
      if (child.to >= range.from) {
        collectQuoteMarkersInRange(child, doc, context, builder, range);
      }
    } while (child.nextSibling());
  } finally {
    child.delete();
  }
}

function collectQuoteMarkersInRange(
  cursor: MarkdownTreeCursor,
  doc: Text,
  context: MarkdownBlockContext,
  builder: SnapshotBuilder,
  range: DocRange,
) {
  if (!rangesTouch(cursor, range)) return;

  let node = cursor.node;
  if (isQuoteMarker(node)) {
    let line = doc.lineAt(node.from);
    if (line.from == range.from && line.to == range.to) {
      addMarker(builder, markerRecord(doc, node, quoteMarkerKind(node), context));
    }
    return;
  }
  if (node.name == "block_quote") return;

  let child = cursor.copy();
  try {
    if (!firstRangeChild(child, range.from)) return;
    do {
      if (child.from > range.to) break;
      if (child.to >= range.from) {
        collectQuoteMarkersInRange(child, doc, context, builder, range);
      }
    } while (child.nextSibling());
  } finally {
    child.delete();
  }
}

function firstRangeChild(cursor: MarkdownTreeCursor, from: number) {
  let index = searchIndex(cursor, from, -1);
  if (!cursor.firstChildForIndex(index) && (index == from || !cursor.firstChildForIndex(from))) {
    return false;
  }
  while (cursor.to < from) {
    if (!cursor.nextSibling()) return false;
  }
  return true;
}

function contextAfterEntering(
  cursor: MarkdownTreeCursor,
  doc: Text,
  context: MarkdownBlockContext,
): MarkdownBlockContext {
  let node = cursor.node;
  if (node.name == "block_quote") {
    return {
      ...context,
      quoteDepth: context.quoteDepth + 1,
    };
  }
  if (node.name == "list_item") {
    let item = listItemContext(node, doc);
    if (!item) return context;
    return {
      ...context,
      listPath: [...context.listPath, item],
    };
  }
  return context;
}

function listItemContext(node: SyntaxNode, doc: Text): MarkdownListItemContext | null {
  let marker = node.children.find(isListMarker);
  if (!marker) return null;
  let task = node.children.find(isTaskMarker);
  return {
    itemRange: nodeRange(node),
    markerRange: nodeRange(marker),
    markerText: doc.sliceString(marker.from, marker.to).trim(),
    task: task
      ? {
          checked: task.name == "task_list_marker_checked",
          range: nodeRange(task),
        }
      : null,
  };
}

function leafRecord(
  node: SyntaxNode,
  kind: MarkdownLeafKind,
  context: MarkdownBlockContext,
  doc: Text,
): MarkdownLeaf {
  let from = clamp(node.from, 0, doc.length);
  let to = clamp(node.to, from, doc.length);
  let range = { from, to };
  return {
    context,
    contextKey: markdownBlockContextKey(context),
    kind,
    node,
    nodeId: node.id,
    nodeName: node.name,
    range,
    sourceRange: range,
  };
}

function leafSourceRange(
  doc: Text,
  range: DocRange,
  context: MarkdownBlockContext,
  markers: readonly MarkdownMarkerRecord[],
): DocRange {
  if (range.from >= range.to) return { from: range.from, to: range.to };
  let firstLine = doc.lineAt(range.from);
  let lastLine = doc.lineAt(Math.max(range.from, range.to - 1));
  while (
    lastLine.number > firstLine.number &&
    isWhitespaceOnly(doc.sliceString(lastLine.from, lastLine.to))
  ) {
    lastLine = doc.line(lastLine.number - 1);
  }
  let to = lastLine.to;
  for (let lineNumber = firstLine.number + 1; lineNumber <= lastLine.number; lineNumber++) {
    let line = doc.line(lineNumber);
    let owner = deepestLineMarker(markers, line);
    if (owner && !sameBlockOwnerContext(owner.context, context)) {
      to = doc.line(lineNumber - 1).to;
      break;
    }
  }
  return { from: firstLine.from, to };
}

function markerRecord(
  doc: Text,
  node: SyntaxNode,
  kind: MarkdownMarkerKind,
  context: MarkdownBlockContext,
): MarkdownMarkerRecord {
  let range = nodeRange(node);
  let line = doc.lineAt(range.from);
  return {
    context,
    contextKey: markdownBlockContextKey(context),
    kind,
    lineRange: { from: line.from, to: line.to },
    range,
    text: doc.sliceString(range.from, range.to),
  };
}

function addLeaf(builder: SnapshotBuilder, leaf: MarkdownLeaf) {
  let key = `${leaf.kind}:${leaf.range.from}:${leaf.range.to}:${leaf.contextKey}`;
  if (builder.seenLeaves.has(key)) return;
  builder.seenLeaves.add(key);
  builder.leaves.push(leaf);
}

function addMarker(builder: SnapshotBuilder, marker: MarkdownMarkerRecord) {
  let key = `${marker.kind}:${marker.range.from}:${marker.range.to}:${marker.contextKey}`;
  if (builder.seenMarkers.has(key)) return;
  builder.seenMarkers.add(key);
  builder.markers.push(marker);
}

function snapshotBuilder(): SnapshotBuilder {
  return {
    leaves: [],
    markers: [],
    seenLeaves: new Set(),
    seenMarkers: new Set(),
    trace: emptyTrace(),
  };
}

function finishSnapshot(builder: SnapshotBuilder, doc: Text) {
  builder.leaves.sort(compareMarkdownLeaves);
  builder.markers.sort(compareMarkdownMarkers);
  builder.trace.collectedLeaves = builder.leaves.length;
  builder.trace.collectedMarkers = builder.markers.length;
  let markers = Object.freeze([...builder.markers]);
  let leaves = Object.freeze(
    builder.leaves.map((leaf) => {
      let sourceRange = leafSourceRange(doc, leaf.range, leaf.context, markers);
      let context = contextWithLeafQuoteMarkers(leaf.context, sourceRange, markers);
      return { ...leaf, context, sourceRange };
    }),
  );
  return {
    snapshot: {
      leaves,
      markers,
    },
    trace: builder.trace,
  };
}

function contextWithLeafQuoteMarkers(
  context: MarkdownBlockContext,
  sourceRange: DocRange,
  markers: readonly MarkdownMarkerRecord[],
): MarkdownBlockContext {
  if (context.quoteDepth == 0) return context;
  let startIndex = firstMarkerStartingAtOrAfter(markers, sourceRange.from);
  let quoteMarkers: DocRange[] = [];
  for (let index = startIndex; index < markers.length; index++) {
    let marker = markers[index]!;
    if (marker.range.from > sourceRange.to) break;
    if (
      (marker.kind == "quoteMarker" || marker.kind == "continuation") &&
      marker.context.quoteDepth == context.quoteDepth &&
      marker.range.to <= sourceRange.to
    ) {
      quoteMarkers.push(marker.range);
    }
  }
  return quoteMarkers.length ? { ...context, quoteMarkers } : context;
}

function firstMarkerStartingAtOrAfter(markers: readonly MarkdownMarkerRecord[], position: number) {
  let low = 0;
  let high = markers.length;
  while (low < high) {
    let mid = (low + high) >> 1;
    if (markers[mid]!.range.from < position) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function deepestLineMarker(markers: readonly MarkdownMarkerRecord[], line: DocRange) {
  let owner: MarkdownMarkerRecord | null = null;
  for (let marker of markers) {
    if (marker.lineRange.from < line.from) continue;
    if (marker.lineRange.from > line.from) break;
    if (marker.lineRange.to != line.to) continue;
    owner = marker;
  }
  return owner;
}

function sameBlockOwnerContext(left: MarkdownBlockContext, right: MarkdownBlockContext) {
  if (left.quoteDepth != right.quoteDepth) return false;
  if (left.listPath.length != right.listPath.length) return false;
  for (let index = 0; index < left.listPath.length; index++) {
    let leftItem = left.listPath[index]!;
    let rightItem = right.listPath[index]!;
    if (!rangesSame(leftItem.itemRange, rightItem.itemRange)) return false;
    if (!rangesSame(leftItem.markerRange, rightItem.markerRange)) return false;
    if (leftItem.task || rightItem.task) {
      if (!leftItem.task || !rightItem.task) return false;
      if (leftItem.task.checked != rightItem.task.checked) return false;
      if (!rangesSame(leftItem.task.range, rightItem.task.range)) return false;
    }
  }
  return true;
}

function isListMarker(node: SyntaxNode) {
  return (
    node.name == "list_marker_dot" ||
    node.name == "list_marker_minus" ||
    node.name == "list_marker_parenthesis" ||
    node.name == "list_marker_plus" ||
    node.name == "list_marker_star"
  );
}

function isTaskMarker(node: SyntaxNode) {
  return node.name == "task_list_marker_checked" || node.name == "task_list_marker_unchecked";
}

function isQuoteMarker(node: SyntaxNode) {
  return node.name == "block_quote_marker" || node.name == "block_continuation";
}

function quoteMarkerKind(node: SyntaxNode): MarkdownMarkerKind {
  return node.name == "block_continuation" ? "continuation" : "quoteMarker";
}

function nodeRange(node: SyntaxNode): DocRange {
  return { from: node.from, to: node.to };
}

function lineRangesTouchingRange(doc: Text, range: DocRange) {
  if (doc.length == 0) return [{ from: 0, to: 0 }];
  let from = clamp(Math.min(range.from, range.to), 0, doc.length);
  let to = clamp(Math.max(range.from, range.to), 0, doc.length);
  let firstLine = doc.lineAt(from);
  let lastLine = doc.lineAt(to > from ? to - 1 : to);
  let lines: DocRange[] = [];
  for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber++) {
    let line = doc.line(lineNumber);
    lines.push({ from: line.from, to: line.to });
  }
  return lines;
}

function normalizeRanges(ranges: readonly DocRange[], docLength: number) {
  let sorted = ranges
    .map((range) => ({
      from: clamp(Math.min(range.from, range.to), 0, docLength),
      to: clamp(Math.max(range.from, range.to), 0, docLength),
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
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

function rangesTouch(a: DocRange, b: DocRange) {
  return a.from <= b.to && b.from <= a.to;
}

function rangesSame(a: DocRange, b: DocRange) {
  return a.from == b.from && a.to == b.to;
}

function searchIndex(range: DocRange, pos: number, side: -1 | 0 | 1) {
  let index = side < 0 && pos > range.from ? pos - 1 : pos;
  if (index >= range.to && range.to > range.from) index = range.to - 1;
  if (index < range.from) index = range.from;
  return index;
}

function emptyTrace(): MarkdownBlockTrace {
  return {
    checkedRanges: [],
    collectedLeaves: 0,
    collectedMarkers: 0,
    fallbackCount: 0,
    rounds: 0,
    visitedBlockNodes: 0,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
