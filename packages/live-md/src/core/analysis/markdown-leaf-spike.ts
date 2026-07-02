import { type ChangeDesc, type Text } from "@codemirror/state";
import { type DocRange, type Tree } from "@codemirror-treesitter/language";
import { collectMarkdownBlocksInRanges, walkMarkdownBlocks } from "./markdown-block-cursor.js";
import {
  type MarkdownBlockTrace,
  type MarkdownLeaf,
  type MarkdownLeafKind,
} from "./markdown-block-types.js";
import {
  clamp,
  isBroadContainerSyntaxRange,
  mapRange,
  normalizeRanges,
  oldTextChangeContextRanges,
  rangesEqual,
  textChangeContextRanges,
} from "./ranges.js";

/**
 * Gate B validation harness for Markdown leaf discovery after local edits.
 *
 * Gate B is complete for range-local changed-leaf discovery when the bounded
 * walk matches the full-walk oracle and ordinary edits stay local.
 *
 * Production block traversal, leaf classification, context collection, and
 * marker records live in markdown-block-cursor.ts. This module only owns the
 * edit-range seed expansion, fixed-point retry, and full-walk oracle diff used
 * to verify range-local discovery against the canonical full walk.
 * It is not the production immutable analysis cache transition.
 */

export type { MarkdownLeafKind } from "./markdown-block-types.js";

export type MarkdownLeafRecord = DocRange & {
  contextKey: string;
  kind: MarkdownLeafKind;
  nodeId: number;
  nodeName: string;
  sourceHash: number;
  sourceText: string;
};

export type MarkdownLeafTrace = MarkdownBlockTrace;

export type MarkdownChangedLeafResult = {
  changedLeaves: readonly MarkdownLeafRecord[];
  correct: boolean;
  localLeaves: readonly MarkdownLeafRecord[];
  oracleChangedLeaves: readonly MarkdownLeafRecord[];
  oracleLeaves: readonly MarkdownLeafRecord[];
  trace: MarkdownLeafTrace;
};

export function walkMarkdownLeaves(
  tree: Tree,
  doc: Text,
): {
  leaves: readonly MarkdownLeafRecord[];
  trace: MarkdownLeafTrace;
} {
  let walked = walkMarkdownBlocks(tree, doc);
  return {
    leaves: walked.snapshot.leaves.map((leaf) => leafRecord(leaf, doc)),
    trace: walked.trace,
  };
}

export function collectMarkdownLeavesInRanges(
  tree: Tree,
  doc: Text,
  ranges: readonly DocRange[],
): {
  leaves: readonly MarkdownLeafRecord[];
  trace: MarkdownLeafTrace;
} {
  let walked = collectMarkdownBlocksInRanges(tree, doc, ranges);
  return {
    leaves: walked.snapshot.leaves.map((leaf) => leafRecord(leaf, doc)),
    trace: walked.trace,
  };
}

export function findChangedMarkdownLeaves(input: {
  changes: ChangeDesc;
  newDoc: Text;
  newTree: Tree;
  oldDoc: Text;
  oldTree: Tree;
  syntaxChangedRanges?: readonly DocRange[];
}): MarkdownChangedLeafResult {
  let textContextRanges = textChangeContextRanges(input.oldDoc, input.newDoc, input.changes);
  let initialOldRanges = oldTextChangeContextRanges(input.oldDoc, input.newDoc, input.changes);
  let oldTouched = collectMarkdownLeavesInRanges(input.oldTree, input.oldDoc, initialOldRanges);
  let mappedOldTouchedRanges = oldTouched.leaves.map((leaf) => mapRange(leaf, input.changes));
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

function leafRecord(leaf: MarkdownLeaf, doc: Text): MarkdownLeafRecord {
  let { from, to } = leaf.range;
  let source = doc.sliceString(from, to);
  return {
    contextKey: leaf.contextKey,
    from,
    kind: leaf.kind,
    nodeId: leaf.nodeId,
    nodeName: leaf.nodeName,
    sourceHash: hashLeafSource(source),
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
    ...mapRange(leaf, changes),
  };
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

function hashLeafSource(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
