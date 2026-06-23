import { type ChangeDesc, type Text } from "@codemirror/state";
import { type DocRange, type SyntaxNode, type Tree } from "@codemirror-treesitter/language";

/**
 * Gate B validation spike for Markdown leaf discovery after local edits.
 *
 * Gate B is complete when the bounded walk matches the full-walk oracle on the
 * covered cases and ordinary edits stay local. This module does not install the
 * production immutable cache transition, marker/context model, or final reducer
 * integration.
 *
 * This module is intentionally an oracle/trace harness, not the production
 * incremental LiveMD analysis cache. It keeps exact leaf source in records so
 * the spike can validate correctness without depending on a diagnostic hash.
 */

export type MarkdownLeafKind =
  | "paragraph"
  | "heading"
  | "table"
  | "fencedCode"
  | "indentedCode"
  | "html"
  | "rule";

export type MarkdownLeafRecord = DocRange & {
  kind: MarkdownLeafKind;
  nodeName: string;
  nodeId: number;
  contextKey: string;
  sourceHash: number;
  sourceText: string;
};

export type MarkdownLeafTrace = {
  checkedRanges: readonly DocRange[];
  collectedLeaves: number;
  fallbackCount: number;
  rounds: number;
  visitedBlockNodes: number;
};

export type MarkdownChangedLeafResult = {
  changedLeaves: readonly MarkdownLeafRecord[];
  correct: boolean;
  localLeaves: readonly MarkdownLeafRecord[];
  oracleChangedLeaves: readonly MarkdownLeafRecord[];
  oracleLeaves: readonly MarkdownLeafRecord[];
  trace: MarkdownLeafTrace;
};

type MarkdownTreeCursor = NonNullable<ReturnType<Tree["cursor"]>>;

type WalkContext = {
  quoteDepth: number;
  listPath: readonly string[];
};

const emptyContext: WalkContext = { listPath: [], quoteDepth: 0 };

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

export function walkMarkdownLeaves(
  tree: Tree,
  doc: Text,
): {
  leaves: readonly MarkdownLeafRecord[];
  trace: MarkdownLeafTrace;
} {
  let trace = emptyTrace();
  let leaves: MarkdownLeafRecord[] = [];
  let seen = new Set<string>();
  let cursor = tree.cursor();
  if (!cursor) return { leaves, trace };
  try {
    walkFullCursor(cursor, doc, emptyContext, leaves, seen, trace);
  } finally {
    cursor.delete();
  }
  trace.collectedLeaves = leaves.length;
  return { leaves, trace };
}

export function collectMarkdownLeavesInRanges(
  tree: Tree,
  doc: Text,
  ranges: readonly DocRange[],
): {
  leaves: readonly MarkdownLeafRecord[];
  trace: MarkdownLeafTrace;
} {
  let trace = emptyTrace();
  let checkedRanges = normalizeRanges(ranges, doc.length);
  let leaves: MarkdownLeafRecord[] = [];
  let seen = new Set<string>();

  for (let range of checkedRanges) {
    let cursor = tree.cursor();
    if (!cursor) continue;
    try {
      walkRangeCursor(cursor, doc, range, emptyContext, leaves, seen, trace);
    } finally {
      cursor.delete();
    }
  }

  trace.checkedRanges = checkedRanges;
  trace.collectedLeaves = leaves.length;
  return { leaves: leaves.sort(compareLeaf), trace };
}

export function findChangedMarkdownLeaves(input: {
  changes: ChangeDesc;
  newDoc: Text;
  newTree: Tree;
  oldDoc: Text;
  oldTree: Tree;
  syntaxChangedRanges?: readonly DocRange[];
}): MarkdownChangedLeafResult {
  let changeRanges: Array<{ newRange: DocRange; oldRange: DocRange }> = [];
  input.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    changeRanges.push({
      newRange: { from: fromB, to: toB },
      oldRange: { from: fromA, to: toA },
    });
  });

  let textContextRanges = changeRanges.map((range) =>
    expandTextChangeRange(input.oldDoc, input.newDoc, range.oldRange, range.newRange),
  );
  let initialOldRanges = changeRanges.map((range) =>
    expandOldTextChangeRange(input.oldDoc, input.newDoc, range.oldRange, range.newRange),
  );
  let oldTouched = collectMarkdownLeavesInRanges(input.oldTree, input.oldDoc, initialOldRanges);
  let mappedOldTouchedRanges = oldTouched.leaves.map((leaf) => mapLeafRange(leaf, input.changes));
  let syntaxRanges = (input.syntaxChangedRanges ?? [])
    .filter((range) => !isBroadContainerSyntaxRange(range, textContextRanges, input.newDoc.length))
    .map((range) => expandToLineContext(input.newDoc, range));

  let ranges = normalizeRanges(
    [...textContextRanges, ...syntaxRanges, ...mappedOldTouchedRanges],
    input.newDoc.length,
  );

  let local = collectWithFixedPoint(input.newTree, input.newDoc, ranges);
  let oldFull = walkMarkdownLeaves(input.oldTree, input.oldDoc);
  let changedLeaves = diffNewLeaves(local.leaves, oldFull.leaves, input.changes);
  let newFull = walkMarkdownLeaves(input.newTree, input.newDoc);
  let oracleChangedLeaves = diffNewLeaves(newFull.leaves, oldFull.leaves, input.changes);
  let correct = leafSetKey(changedLeaves) == leafSetKey(oracleChangedLeaves);

  return {
    changedLeaves,
    correct,
    localLeaves: local.leaves,
    oracleChangedLeaves,
    oracleLeaves: newFull.leaves,
    trace: local.trace,
  };
}

function collectWithFixedPoint(tree: Tree, doc: Text, initialRanges: readonly DocRange[]) {
  let ranges = normalizeRanges(initialRanges, doc.length);
  let local = collectMarkdownLeavesInRanges(tree, doc, ranges);
  for (let round = 1; round <= 3; round++) {
    let expanded = normalizeRanges(
      [...ranges, ...local.leaves.map((leaf) => ({ from: leaf.from, to: leaf.to }))],
      doc.length,
    );
    if (rangesEqual(ranges, expanded)) {
      local.trace.rounds = round;
      return local;
    }
    ranges = expanded;
    local = collectMarkdownLeavesInRanges(tree, doc, ranges);
  }

  let fallback = walkMarkdownLeaves(tree, doc);
  return {
    leaves: fallback.leaves,
    trace: {
      ...fallback.trace,
      checkedRanges: [{ from: 0, to: doc.length }],
      fallbackCount: 1,
      rounds: 4,
    },
  };
}

function walkFullCursor(
  cursor: MarkdownTreeCursor,
  doc: Text,
  context: WalkContext,
  leaves: MarkdownLeafRecord[],
  seen: Set<string>,
  trace: MarkdownLeafTrace,
) {
  trace.visitedBlockNodes++;
  let node = cursor.node;
  let kind = classifyMarkdownLeaf(node);
  if (kind) {
    addLeaf(leaves, seen, leafRecord(node, kind, context, doc));
    return;
  }

  let childContext = contextAfterEntering(cursor, doc, context);
  let child = cursor.copy();
  try {
    if (child.firstChild()) {
      do {
        walkFullCursor(child, doc, childContext, leaves, seen, trace);
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
  context: WalkContext,
  leaves: MarkdownLeafRecord[],
  seen: Set<string>,
  trace: MarkdownLeafTrace,
) {
  trace.visitedBlockNodes++;
  if (!rangesTouch(cursor, range)) return;

  let node = cursor.node;
  let kind = classifyMarkdownLeaf(node);
  if (kind) {
    addLeaf(leaves, seen, leafRecord(node, kind, context, doc));
    return;
  }

  let childContext = contextAfterEntering(cursor, doc, context);
  let child = cursor.copy();
  try {
    if (!firstRangeChild(child, range.from)) return;
    do {
      if (child.from > range.to) break;
      if (child.to >= range.from) {
        walkRangeCursor(child, doc, range, childContext, leaves, seen, trace);
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
  context: WalkContext,
): WalkContext {
  let node = cursor.node;
  if (node.name == "block_quote") {
    return { ...context, quoteDepth: context.quoteDepth + 1 };
  }
  if (node.name == "list_item") {
    return {
      ...context,
      listPath: [...context.listPath, listItemMarkerText(cursor, doc)],
    };
  }
  return context;
}

function listItemMarkerText(cursor: MarkdownTreeCursor, doc: Text) {
  let node = cursor.node;
  let prefix = doc.sliceString(node.from, Math.min(node.to, node.from + 48));
  return prefix.match(/^\s*(?:[-+*]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/u)?.[0] ?? prefix;
}

function leafRecord(
  node: SyntaxNode,
  kind: MarkdownLeafKind,
  context: WalkContext,
  doc: Text,
): MarkdownLeafRecord {
  let from = clamp(node.from, 0, doc.length);
  let to = clamp(node.to, from, doc.length);
  let source = doc.sliceString(from, to);
  return {
    contextKey: contextKey(context),
    from,
    kind,
    nodeId: node.id,
    nodeName: node.name,
    sourceHash: hashString(source),
    sourceText: source,
    to,
  };
}

function diffNewLeaves(
  newLeaves: readonly MarkdownLeafRecord[],
  oldLeaves: readonly MarkdownLeafRecord[],
  changes: ChangeDesc,
) {
  let mappedOld = new Set(oldLeaves.map((leaf) => leafKey(mapOldLeaf(leaf, changes))));
  return newLeaves.filter((leaf) => !mappedOld.has(leafKey(leaf))).sort(compareLeaf);
}

function mapOldLeaf(leaf: MarkdownLeafRecord, changes: ChangeDesc): MarkdownLeafRecord {
  return {
    ...leaf,
    ...mapLeafRange(leaf, changes),
  };
}

function mapLeafRange(range: DocRange, changes: ChangeDesc): DocRange {
  let length = changes.length;
  let from = changes.mapPos(clamp(range.from, 0, length), 1);
  let to = changes.mapPos(clamp(range.to, 0, length), -1);
  return from <= to ? { from, to } : { from: to, to: from };
}

function addLeaf(leaves: MarkdownLeafRecord[], seen: Set<string>, leaf: MarkdownLeafRecord) {
  let key = `${leaf.kind}:${leaf.from}:${leaf.to}:${leaf.contextKey}`;
  if (seen.has(key)) return;
  seen.add(key);
  leaves.push(leaf);
}

function contextKey(context: WalkContext) {
  return `q${context.quoteDepth}|${context.listPath.join(">")}`;
}

function leafKey(leaf: MarkdownLeafRecord) {
  return JSON.stringify([leaf.kind, leaf.from, leaf.to, leaf.contextKey, leaf.sourceText]);
}

function leafSetKey(leaves: readonly MarkdownLeafRecord[]) {
  return JSON.stringify(leaves.map(leafKey).sort());
}

function compareLeaf(a: MarkdownLeafRecord, b: MarkdownLeafRecord) {
  return a.from - b.from || a.to - b.to || a.kind.localeCompare(b.kind);
}

function expandToLineContext(doc: Text, range: DocRange): DocRange {
  if (doc.length == 0) return { from: 0, to: 0 };
  let from = clamp(range.from, 0, doc.length);
  let to = clamp(range.to, 0, doc.length);
  if (to < from) [from, to] = [to, from];
  let fromLine = doc.lineAt(from);
  let toLine = doc.lineAt(to);
  let startLine = doc.line(Math.max(1, fromLine.number - 1));
  let endLine = doc.line(Math.min(doc.lines, toLine.number + 1));
  return { from: startLine.from, to: endLine.to };
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

function rangesEqual(a: readonly DocRange[], b: readonly DocRange[]) {
  return a.length == b.length && a.every((range, index) => rangesSame(range, b[index]!));
}

function rangesSame(a: DocRange, b: DocRange) {
  return a.from == b.from && a.to == b.to;
}

function rangesTouch(a: DocRange, b: DocRange) {
  return a.from <= b.to && b.from <= a.to;
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

function searchIndex(range: DocRange, pos: number, side: -1 | 0 | 1) {
  let index = side < 0 && pos > range.from ? pos - 1 : pos;
  if (index >= range.to && range.to > range.from) index = range.to - 1;
  if (index < range.from) index = range.from;
  return index;
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function emptyTrace(): MarkdownLeafTrace {
  return {
    checkedRanges: [],
    collectedLeaves: 0,
    fallbackCount: 0,
    rounds: 0,
    visitedBlockNodes: 0,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
