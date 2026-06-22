import { type DocRange, type SyntaxNode } from "@codemirror-treesitter/language";

export type MarkdownLeafKind =
  | "paragraph"
  | "heading"
  | "table"
  | "fencedCode"
  | "indentedCode"
  | "html"
  | "rule";

export type MarkdownMarkerKind = "listMarker" | "taskMarker" | "quoteMarker" | "continuation";

export type MarkdownListItemContext = {
  itemRange: DocRange;
  markerRange: DocRange;
  markerText: string;
  task: null | {
    checked: boolean;
    range: DocRange;
  };
};

export type MarkdownBlockContext = {
  listPath: readonly MarkdownListItemContext[];
  quoteDepth: number;
  quoteMarkers: readonly DocRange[];
};

export type MarkdownLeaf = {
  context: MarkdownBlockContext;
  contextKey: string;
  kind: MarkdownLeafKind;
  node: SyntaxNode;
  nodeId: number;
  nodeName: string;
  range: DocRange;
  sourceRange: DocRange;
};

export type MarkdownMarkerRecord = {
  context: MarkdownBlockContext;
  contextKey: string;
  kind: MarkdownMarkerKind;
  lineRange: DocRange;
  range: DocRange;
  text: string;
};

export type MarkdownBlockSnapshot = {
  leaves: readonly MarkdownLeaf[];
  markers: readonly MarkdownMarkerRecord[];
};

export type MarkdownBlockTrace = {
  checkedRanges: readonly DocRange[];
  collectedLeaves: number;
  collectedMarkers: number;
  fallbackCount: number;
  rounds: number;
  visitedBlockNodes: number;
};
