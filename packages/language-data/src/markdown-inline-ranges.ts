import {
  queryNodeCaptures,
  type DocRange,
  type SyntaxNode,
  type Tree,
  type TreeSitterQueryCapture,
} from "@codemirror-treesitter/language";
import markdownInlineInjectionExclusionQuerySource from "./queries/markdown-inline-injection-exclusions.scm?raw";

const injectionNodeNames = new Set(["inline", "pipe_table_cell"]);
const searchBoundaryNodeNames = new Set([
  ...injectionNodeNames,
  "atx_heading",
  "block_quote",
  "list_item",
  "paragraph",
  "pipe_table",
  "pipe_table_row",
  "setext_heading",
]);

type MarkdownTreeCursor = NonNullable<ReturnType<SyntaxNode["cursor"]>>;

export function* iterateMarkdownInlineRangeGroups(
  tree: Tree,
  within: DocRange = { from: 0, to: tree.length },
): Generator<DocRange[]> {
  let root = searchRoot(tree, within);
  if (!root) return;
  let cursor = root.cursor();
  if (!cursor) return;
  try {
    for (let node of iterateInjectionNodes(cursor, within)) {
      let exclusions =
        node.name == "inline"
          ? queryNodeCaptures(node, markdownInlineInjectionExclusionQuerySource).filter(
              (capture) => capture.name == "injection.excluded",
            )
          : [];
      let ranges = rangesExcludingCaptures(nodeRange(node), exclusions);
      if (ranges.length) yield ranges;
    }
  } finally {
    cursor.delete();
  }
}

export function collectMarkdownInlineRangeGroups(tree: Tree, within?: DocRange): DocRange[][] {
  return Array.from(iterateMarkdownInlineRangeGroups(tree, within));
}

function* iterateInjectionNodes(
  cursor: MarkdownTreeCursor,
  within: DocRange,
): Generator<SyntaxNode> {
  if (!rangesOverlap(cursor, within)) return;
  for (;;) {
    if (rangesOverlap(cursor, within)) {
      if (injectionNodeNames.has(cursor.name)) yield cursor.node;
      else if (cursor.firstChildForIndex(within.from)) continue;
    }
    if (!advanceCursor(cursor, within)) return;
  }
}

function advanceCursor(cursor: MarkdownTreeCursor, within: DocRange) {
  for (;;) {
    if (cursor.nextSibling()) {
      if (cursor.from >= within.to) return false;
      if (cursor.to > within.from) return true;
    } else if (!cursor.parent()) {
      return false;
    }
  }
}

function searchRoot(tree: Tree, within: DocRange): SyntaxNode | null {
  if (within.from >= within.to) return null;
  if (within.from == 0 && within.to == tree.length) return tree.topNode;
  let node =
    tree.topNode.descendantForIndex(within.from, Math.max(within.from, within.to - 1)) ??
    tree.topNode;
  while (node.parent && !searchBoundaryNodeNames.has(node.name)) node = node.parent;
  return node;
}

function rangesExcludingCaptures(range: DocRange, exclusions: readonly TreeSitterQueryCapture[]) {
  let ranges: DocRange[] = [];
  let from = range.from;
  for (let exclusion of exclusions) {
    if (exclusion.node.from < range.from || exclusion.node.to > range.to) continue;
    if (from < exclusion.node.from) ranges.push({ from, to: exclusion.node.from });
    from = Math.max(from, exclusion.node.to);
  }
  if (from < range.to) ranges.push({ from, to: range.to });
  return ranges;
}

function nodeRange(node: SyntaxNode): DocRange {
  return { from: node.from, to: node.to };
}

function rangesOverlap(left: DocRange, right: DocRange) {
  return left.from < right.to && right.from < left.to;
}
