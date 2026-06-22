import { type ChangeDesc, type RangeSet, type RangeValue, type Text } from "@codemirror/state";
import { type Highlighter, type Tree } from "@codemirror-treesitter/language";
import { type DecorationSet } from "@codemirror/view";
import { type LiveMdSemanticState } from "../analysis/descriptors.js";
import { type LiveMdSourceIslandLeaf } from "../analysis/markdown-source-islands.js";
import { type DocRange, type LiveMdLeafAnalysisTrace } from "../analysis/types.js";
import { type LiveMdMarkdownFeature } from "../features.js";
import { type LiveMdImageSourceResolver } from "../images.js";
import { type CodeFenceLanguageMap, type LiveMdMarkdownParserService } from "../languages.js";
import { type LiveMdLinkBaseUrl } from "../links.js";

export type LiveMdSemanticTrace = LiveMdLeafAnalysisTrace;

export type LiveMdRuntimeEpochs = {
  codeFenceHighlighters: readonly Highlighter[];
  codeFenceLanguages: CodeFenceLanguageMap | null;
  imageSourceResolver: LiveMdImageSourceResolver | null;
  linkBaseUrl: LiveMdLinkBaseUrl | null;
  markdownFeatures: readonly LiveMdMarkdownFeature[];
  markdownParserService: LiveMdMarkdownParserService | null;
};

export type LiveMdPendingAnalysis = {
  baseAnalysis: LiveMdAnalysis;
  baseDoc: Text;
  changes: ChangeDesc;
  epochs: LiveMdRuntimeEpochs;
  revision: number;
  syntaxChangedRanges: readonly DocRange[];
};

export type LiveMdAnalysis = {
  activeLines: ReadonlySet<number>;
  activeSourceRanges: readonly DocRange[];
  atomicRanges: RangeSet<RangeValue>;
  decorations: DecorationSet;
  destructiveDecorations: DecorationSet;
  interactiveDecorations: DecorationSet;
  pending: LiveMdPendingAnalysis | null;
  revision: number;
  semantic: LiveMdSemanticState | null;
  semanticTrace: LiveMdSemanticTrace | null;
  sourceSafeDecorations: DecorationSet;
  sourceIslandLeaves: readonly LiveMdSourceIslandLeaf[];
  trace: LiveMdLeafAnalysisTrace;
  tree: Tree;
};
