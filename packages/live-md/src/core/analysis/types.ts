import { type SyntaxNode } from "@codemirror-treesitter/language";

export type DocRange = {
  from: number;
  to: number;
};

export type LiveMdLeafAnalysisTrace = {
  blockNodesVisited: number;
  codeFenceParserSessionsCreated: number;
  codeFenceParserSessionsDeleted: number;
  codeFenceTreesCreated: number;
  codeFenceTreesDeleted: number;
  inlineHostsWithoutRanges: number;
  inlineRangeGroupsExamined: number;
  inlineParsedChars: number;
  inlineParseCalls: number;
  inlineParserSessions: number;
  recordsAnalyzed: number;
  recordsVisited: number;
  tableCellsParsed: number;
};

export function emptyLiveMdLeafAnalysisTrace(): LiveMdLeafAnalysisTrace {
  return {
    blockNodesVisited: 0,
    codeFenceParserSessionsCreated: 0,
    codeFenceParserSessionsDeleted: 0,
    codeFenceTreesCreated: 0,
    codeFenceTreesDeleted: 0,
    inlineHostsWithoutRanges: 0,
    inlineRangeGroupsExamined: 0,
    inlineParsedChars: 0,
    inlineParseCalls: 0,
    inlineParserSessions: 0,
    recordsAnalyzed: 0,
    recordsVisited: 0,
    tableCellsParsed: 0,
  };
}

export type CapturedTable = {
  delimiterCells: Map<string, CapturedTableDelimiterCell>;
  delimiterRow: SyntaxNode | null;
  headerCells: Map<string, SyntaxNode>;
  node: SyntaxNode;
  pipes: Map<string, SyntaxNode>;
  rows: Map<string, CapturedTableRow>;
};

export type CapturedTableDelimiterCell = {
  left: boolean;
  node: SyntaxNode;
  right: boolean;
};

export type CapturedTableRow = {
  cells: Map<string, SyntaxNode>;
  node: SyntaxNode;
};

export type LiveMdMatchKind =
  | "codeFence"
  | "heading"
  | "image"
  | "latex"
  | "link"
  | "rule"
  | "table";
