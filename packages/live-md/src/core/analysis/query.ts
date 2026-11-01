import {
  type SyntaxNode,
  type TreeSitterQueryCapture,
  type TreeSitterQueryMatch,
} from "@codemirror-treesitter/language";
import liveMdMarkdownInlineQuerySourceRaw from "../queries/decorations-markdown-inline.scm?raw";
import liveMdMarkdownQuerySourceRaw from "../queries/decorations-markdown.scm?raw";
import { type DocRange, type LiveMdMatchKind } from "./types.js";

export const liveMdMarkdownBlockQuerySource = liveMdMarkdownQuerySourceRaw;
export const liveMdMarkdownInlineQuerySource = liveMdMarkdownInlineQuerySourceRaw;

export function isInsideSkippedRange(node: SyntaxNode, ranges: readonly DocRange[]) {
  return ranges.some((range) => node.from >= range.from && node.to <= range.to);
}

export function matchRoot(match: TreeSitterQueryMatch): SyntaxNode | null {
  return capture(match, "feature")?.node ?? match.captures[0]?.node ?? null;
}

export function matchKind(match: TreeSitterQueryMatch): LiveMdMatchKind | null {
  let kind = match.setProperties?.["liveMd.kind"];
  if (typeof kind != "string" || !isLiveMdMatchKind(kind)) return null;
  return kind;
}

function isLiveMdMatchKind(kind: string): kind is LiveMdMatchKind {
  switch (kind) {
    case "codeFence":
    case "heading":
    case "image":
    case "latex":
    case "link":
    case "rule":
    case "table":
      return true;
    default:
      return false;
  }
}

export function capture(match: TreeSitterQueryMatch, name: string) {
  return match.captures.find((item) => item.name == name) ?? null;
}

export function captures(match: TreeSitterQueryMatch, name: string) {
  return match.captures.filter((item) => item.name == name);
}

export function captureKey(capture: TreeSitterQueryCapture) {
  return `${capture.name}:${nodeKey(capture.node)}`;
}

export function nodeKey(node: SyntaxNode) {
  return `${node.name}:${node.id}:${node.from}:${node.to}`;
}

export function sortedNodes(nodes?: Iterable<SyntaxNode>) {
  return Array.from(nodes ?? []).sort(compareNodes);
}

export function compareNodes(left: SyntaxNode, right: SyntaxNode) {
  return left.from - right.from || left.to - right.to || left.name.localeCompare(right.name);
}
