import {
  queryTreeMatches,
  type SyntaxNode,
  type Tree,
  type TreeSitterParser,
  type TreeSitterQueryMatch,
  type TreeSitterQuerySource,
} from "@codemirror-treesitter/language";
import liveMdMarkdownInlineQuerySource from "../queries/live-md-markdown-inline.scm?raw";
import liveMdMarkdownQuerySource from "../queries/live-md-markdown.scm?raw";
import { liveMdRangeTouchesRanges, liveMdRangesTouch, mergeLiveMdRanges } from "./ranges.js";
import type { LiveMdDocRange, LiveMdMatchedQuery } from "./types.js";

export function queryLiveMdSemanticMatches(
  tree: Tree,
  ranges: readonly LiveMdDocRange[],
  includeNested?: boolean,
) {
  return queryLiveMdMatchesFromSource(tree, liveMdTreeQuerySource, ranges, includeNested);
}

export function queryLiveMdMatchesFromSource(
  tree: Tree,
  source: TreeSitterQuerySource,
  ranges: readonly LiveMdDocRange[],
  includeNested?: boolean,
) {
  let matches: LiveMdMatchedQuery[] = [];
  let seen = new Set<string>();
  for (let range of queryLiveMdRanges(tree, ranges)) {
    let queryMatches = queryTreeMatches(tree, source, {
      from: range.from,
      includeNested,
      to: range.to,
    });
    for (let match of queryMatches) {
      if (!matchTouchesLiveMdRanges(match, [range])) continue;
      let key = liveMdQueryMatchKey(match);
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ match, range });
    }
  }
  return matches.sort(compareLiveMdMatchedQueries);
}

export function liveMdTreeQuerySource(_parser: TreeSitterParser, tree: Tree) {
  if (tree.topNode.name == "document") return liveMdMarkdownQuerySource;
  if (tree.topNode.name == "inline") return liveMdMarkdownInlineQuerySource;
  return null;
}

export function matchTouchesLiveMdRanges(
  match: TreeSitterQueryMatch,
  ranges: readonly LiveMdDocRange[],
) {
  let feature = liveMdCapture(match, "feature")?.node ?? liveMdMatchFeatureRoot(match);
  if (feature) return liveMdRangeTouchesRanges(feature.from, feature.to, ranges);
  let paragraphChild = liveMdCapture(match, "paragraph.child")?.node;
  if (paragraphChild) return liveMdNodeTouchesRangesInclusive(paragraphChild, ranges);
  return match.captures.some((item) =>
    liveMdRangeTouchesRanges(item.node.from, item.node.to, ranges),
  );
}

export function liveMdMatchKind(match: TreeSitterQueryMatch) {
  let kind = match.setProperties?.["liveMd.kind"];
  return typeof kind == "string" ? kind : null;
}

export function liveMdCapture(match: TreeSitterQueryMatch, name: string) {
  return match.captures.find((item) => item.name == name) ?? null;
}

export function liveMdCaptures(match: TreeSitterQueryMatch, name: string) {
  return match.captures.filter((item) => item.name == name);
}

function queryLiveMdRanges(tree: Tree, ranges: readonly LiveMdDocRange[]) {
  let treeLength = Math.max(0, tree.length);
  return mergeLiveMdRanges(
    ranges
      .map((range) => ({
        from: Math.min(treeLength, Math.max(0, range.from)),
        to: Math.min(treeLength, Math.max(0, range.to)),
      }))
      .filter((range) => range.from <= range.to),
  );
}

function liveMdMatchFeatureRoot(match: TreeSitterQueryMatch) {
  switch (liveMdMatchKind(match)) {
    case "codeFence":
      return liveMdCapture(match, "codeFence")?.node ?? null;
    case "heading":
      return liveMdCapture(match, "heading")?.node ?? null;
    case "image":
      return liveMdCapture(match, "image")?.node ?? null;
    case "latex":
      return liveMdCapture(match, "latex")?.node ?? null;
    case "link":
      return liveMdCapture(match, "link")?.node ?? null;
    case "rule":
      return liveMdCapture(match, "rule")?.node ?? null;
    case "table":
      return liveMdCapture(match, "table")?.node ?? null;
    default:
      return null;
  }
}

function liveMdNodeTouchesRangesInclusive(node: SyntaxNode, ranges: readonly LiveMdDocRange[]) {
  return ranges.some((range) => node.from <= range.to && node.to >= range.from);
}

function liveMdQueryMatchKey({ captures, patternIndex }: TreeSitterQueryMatch) {
  return `${patternIndex}:${captures
    .map(
      (capture) =>
        `${capture.name}:${capture.node.name}:${capture.node.id}:${capture.node.from}:${capture.node.to}`,
    )
    .join(";")}`;
}

function compareLiveMdMatchedQueries(left: LiveMdMatchedQuery, right: LiveMdMatchedQuery) {
  return (
    liveMdMatchedQueryFrom(left) - liveMdMatchedQueryFrom(right) ||
    liveMdMatchedQueryTo(right) - liveMdMatchedQueryTo(left) ||
    left.match.patternIndex - right.match.patternIndex
  );
}

function liveMdMatchedQueryFrom({ match }: LiveMdMatchedQuery) {
  return match.captures.reduce(
    (from, capture) => Math.min(from, capture.node.from),
    Number.POSITIVE_INFINITY,
  );
}

function liveMdMatchedQueryTo({ match }: LiveMdMatchedQuery) {
  return match.captures.reduce((to, capture) => Math.max(to, capture.node.to), 0);
}

export function liveMdRangesOverlap(left: LiveMdDocRange, right: LiveMdDocRange) {
  return liveMdRangesTouch(left.from, left.to, right.from, right.to);
}
