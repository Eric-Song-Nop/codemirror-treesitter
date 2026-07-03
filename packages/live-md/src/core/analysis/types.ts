import { type SyntaxNode } from "@codemirror-treesitter/language";

export type DocRange = {
  from: number;
  to: number;
};

export type LiveMdLeafAnalysisTrace = {
  blockNodesVisited: number;
  checkedRanges: readonly DocRange[];
  codeFenceParserSessionsCreated: number;
  codeFenceParserSessionsDeleted: number;
  codeFenceParses: number;
  codeFenceTreesCreated: number;
  codeFenceTreesDeleted: number;
  inlineHostsWithoutRanges: number;
  inlineRangeGroupsExamined: number;
  exactSourceComparisons: number;
  exactSourceComparedChars: number;
  fallbackCount: number;
  fixedPointRounds: number;
  inlineParsedChars: number;
  inlineParseCalls: number;
  inlineParserSessionDisposals: number;
  inlineParserSessions: number;
  languageApplyMs: number;
  languageWorkIterations: number;
  leavesCollected: number;
  directProjectionRecords: number;
  directProjectionWindows: readonly DocRange[];
  editSurfaceRanges: readonly DocRange[];
  editSurfaceLines: number;
  projectionRecords: number;
  recordsAnalyzed: number;
  cacheFullMaterializations: number;
  recordsCollected: number;
  recordsMappedIndividually: number;
  recordsReused: number;
  recordsVisited: number;
  cacheIndexCallbacks: number;
  cacheIndexQueries: number;
  heavyRenderStarts: number;
  recordIndexQueries: number;
  safetyIndexQueries: number;
  sourceHashCollisions: number;
  staleResultDrops: number;
  surfaceCompileCalls: number;
  surfaceCompileRanges: readonly DocRange[];
  surfaceDescriptorsMapped: number;
  surfaceMapOnlyUpdates: number;
  surfaceRecordsVisited: number;
  tableCellsParsed: number;
  widgetConstructions: number;
};

export function emptyLiveMdLeafAnalysisTrace(): LiveMdLeafAnalysisTrace {
  return {
    blockNodesVisited: 0,
    checkedRanges: [],
    codeFenceParserSessionsCreated: 0,
    codeFenceParserSessionsDeleted: 0,
    codeFenceParses: 0,
    codeFenceTreesCreated: 0,
    codeFenceTreesDeleted: 0,
    inlineHostsWithoutRanges: 0,
    inlineRangeGroupsExamined: 0,
    exactSourceComparisons: 0,
    exactSourceComparedChars: 0,
    fallbackCount: 0,
    fixedPointRounds: 0,
    inlineParsedChars: 0,
    inlineParseCalls: 0,
    inlineParserSessionDisposals: 0,
    inlineParserSessions: 0,
    languageApplyMs: 0,
    languageWorkIterations: 0,
    leavesCollected: 0,
    directProjectionRecords: 0,
    directProjectionWindows: [],
    editSurfaceRanges: [],
    editSurfaceLines: 0,
    projectionRecords: 0,
    recordsAnalyzed: 0,
    cacheFullMaterializations: 0,
    recordsCollected: 0,
    recordsMappedIndividually: 0,
    recordsReused: 0,
    recordsVisited: 0,
    cacheIndexCallbacks: 0,
    cacheIndexQueries: 0,
    heavyRenderStarts: 0,
    recordIndexQueries: 0,
    safetyIndexQueries: 0,
    sourceHashCollisions: 0,
    staleResultDrops: 0,
    surfaceCompileCalls: 0,
    surfaceCompileRanges: [],
    surfaceDescriptorsMapped: 0,
    surfaceMapOnlyUpdates: 0,
    surfaceRecordsVisited: 0,
    tableCellsParsed: 0,
    widgetConstructions: 0,
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
