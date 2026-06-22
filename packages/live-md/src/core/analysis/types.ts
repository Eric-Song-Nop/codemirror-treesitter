import { RangeSet, RangeValue, Text, type EditorState } from "@codemirror/state";
import { type Highlighter, type SyntaxNode, type Tree } from "@codemirror-treesitter/language";
import { type Decoration, type DecorationSet, type WidgetType } from "@codemirror/view";
import { type LiveMdMarkdownFeature } from "../features.js";
import { type LiveMdImageSourceResolver } from "../images.js";
import { type CodeFenceLanguageMap } from "../languages.js";
import { type LiveMdSourceIslandLeaf } from "./markdown-source-islands.js";

export type DocRange = {
  from: number;
  to: number;
};

export type LiveMdBuild = {
  activeLines: Set<number>;
  activeSourceRanges: readonly DocRange[];
  codeFenceHighlightTrees: CodeFenceHighlightTree[];
  codeFenceHighlighters: readonly Highlighter[];
  codeFenceLanguages: CodeFenceLanguageMap;
  effects: LiveMdEffect[];
  imageSourceResolver: LiveMdImageSourceResolver | null;
  linkBaseUrl: string | null;
  markdownFeatures: readonly LiveMdMarkdownFeature[];
  sourceIslandMode: boolean;
  state: EditorState;
};

export type LiveMdBuildConfig = {
  activeLines: Set<number>;
  activeSourceRanges?: readonly DocRange[];
  codeFenceHighlighters: readonly Highlighter[];
  codeFenceLanguages: CodeFenceLanguageMap;
  imageSourceResolver: LiveMdImageSourceResolver | null;
  linkBaseUrl: string | null;
  markdownFeatures: readonly LiveMdMarkdownFeature[];
  sourceIslandMode?: boolean;
  state: EditorState;
};

export type CodeFenceParser =
  CodeFenceLanguageMap extends ReadonlyMap<string, infer Parser> ? Parser : never;

export type LiveMdEffect =
  | {
      decoration: Decoration;
      from: number;
      kind: "mark";
      to: number;
    }
  | {
      block?: boolean;
      from: number;
      kind: "replace";
      atomic?: boolean;
      to: number;
      widget: WidgetType;
    }
  | {
      className: string;
      from: number;
      kind: "lineClass";
      to: number;
    }
  | {
      decoration?: Decoration;
      from: number;
      kind: "syntax";
      to: number;
    }
  | {
      from: number;
      kind: "atomic";
      to: number;
    };

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
  activeSourceRanges: readonly DocRange[];
  atomicRanges: RangeSet<RangeValue>;
  codeFenceHighlightTrees: readonly CodeFenceHighlightTree[];
  decorations: DecorationSet;
  sourceIslandLeaves: readonly LiveMdSourceIslandLeaf[];
  tree: Tree;
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
