import { RangeSet, RangeValue, Text, type EditorState, type Range } from "@codemirror/state";
import { type Highlighter, type SyntaxNode, type Tree } from "@codemirror-treesitter/language";
import { type Decoration, type DecorationSet } from "@codemirror/view";
import { type LiveMdMarkdownFeature } from "../features.js";
import { type LiveMdImageSourceResolver } from "../images.js";
import { type CodeFenceLanguageMap } from "../languages.js";

export type DocRange = {
  from: number;
  to: number;
};

export type LiveMdBuild = {
  activeLines: Set<number>;
  atomicRanges: DocRange[];
  codeFenceHighlightTrees: CodeFenceHighlightTree[];
  codeFenceHighlighters: readonly Highlighter[];
  codeFenceLanguages: CodeFenceLanguageMap;
  decorations: Array<Range<Decoration>>;
  imageSourceResolver: LiveMdImageSourceResolver | null;
  lineClasses: Map<number, Set<string>>;
  linkBaseUrl: string | null;
  markdownFeatures: readonly LiveMdMarkdownFeature[];
  state: EditorState;
};

export type LiveMdBuildConfig = {
  activeLines: Set<number>;
  codeFenceHighlighters: readonly Highlighter[];
  codeFenceLanguages: CodeFenceLanguageMap;
  imageSourceResolver: LiveMdImageSourceResolver | null;
  linkBaseUrl: string | null;
  markdownFeatures: readonly LiveMdMarkdownFeature[];
  state: EditorState;
};

export type CodeFenceParser =
  CodeFenceLanguageMap extends ReadonlyMap<string, infer Parser> ? Parser : never;

export type CodeFenceHighlightTree = {
  contentFrom: number;
  contentTo: number;
  language: string;
  parser: CodeFenceParser;
  sourceText: Text;
  tree: Tree;
};

export type LiveMdAnalysis = {
  activeLines: ReadonlySet<number>;
  atomicRanges: RangeSet<RangeValue>;
  codeFenceHighlightTrees: readonly CodeFenceHighlightTree[];
  decorations: DecorationSet;
  tree: Tree;
};

export type ParagraphContainerKind = "block" | "document" | "list" | "listItem";

export type ParagraphContainer = {
  children: SyntaxNode[];
  kind: ParagraphContainerKind;
  node: SyntaxNode;
};

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
