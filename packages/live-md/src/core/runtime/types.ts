import { type ChangeDesc, type RangeSet, type RangeValue, type Text } from "@codemirror/state";
import { type Highlighter, type Tree } from "@codemirror-treesitter/language";
import { type DecorationSet } from "@codemirror/view";
import { type LiveMdSemanticState } from "../analysis/descriptors.js";
import { type LiveMdRenderKeyContext } from "../analysis/markdown-leaf-analysis.js";
import { type LiveMdSourceIslandLeaf } from "../analysis/markdown-source-islands.js";
import { type DocRange, type LiveMdLeafAnalysisTrace } from "../analysis/types.js";
import { type LiveMdMarkdownFeature } from "../features.js";
import { type LiveMdImageSourceResolver } from "../images.js";
import { type CodeFenceLanguageMap, type LiveMdMarkdownParserService } from "../languages.js";
import { type LiveMdLinkBaseUrl } from "../links.js";
import { type LiveMdRenderCache } from "./render-cache.js";

export type LiveMdSemanticTrace = LiveMdLeafAnalysisTrace;

export type LiveMdRuntimeEpochs = {
  codeFenceHighlighters: readonly Highlighter[];
  codeFenceLanguages: CodeFenceLanguageMap | null;
  imageSourceResolver: LiveMdImageSourceResolver | null;
  linkBaseUrl: LiveMdLinkBaseUrl | null;
  markdownFeatures: readonly LiveMdMarkdownFeature[];
  markdownParserService: LiveMdMarkdownParserService | null;
};

export type LiveMdPendingEditSurface = {
  ranges: readonly DocRange[];
};

export type LiveMdPendingAnalysis = {
  baseAnalysis: LiveMdRuntimeState;
  baseDoc: Text;
  changes: ChangeDesc;
  editSurface: LiveMdPendingEditSurface;
  epochs: LiveMdRuntimeEpochs;
  interactiveSafetyRanges: readonly DocRange[];
  revision: number;
  safetyRanges: readonly DocRange[];
  syntaxChangedRanges: readonly DocRange[];
};

export type LiveMdRuntimeState = {
  activeLines: ReadonlySet<number>;
  activeSourceRanges: readonly DocRange[];
  directAtomicRanges: RangeSet<RangeValue>;
  directDecorations: DecorationSet;
  directDestructiveDecorations: DecorationSet;
  directSourceSafeDecorations: DecorationSet;
  legacySurface: LiveMdSurfaceProjection | null;
  pending: LiveMdPendingAnalysis | null;
  renderCache: LiveMdRenderCache;
  renderKeyContext: LiveMdRenderKeyContext;
  revision: number;
  semantic: LiveMdSemanticState | null;
  semanticTrace: LiveMdSemanticTrace | null;
  surfaceInvalidationRanges: readonly DocRange[];
  sourceIslandLeaves: readonly LiveMdSourceIslandLeaf[];
  trace: LiveMdLeafAnalysisTrace;
  tree: Tree;
};

export type LiveMdSurfaceProjection = {
  atomicRanges: RangeSet<RangeValue>;
  decorations: DecorationSet;
  destructiveDecorations: DecorationSet;
  interactiveDecorations: DecorationSet;
  sourceSafeDecorations: DecorationSet;
};

export type LiveMdSurfaceProjectionState = {
  atoms: RangeSet<RangeValue>;
  compiledRanges: readonly DocRange[];
  destructive: DecorationSet;
  interactive: DecorationSet;
  semanticRevision: number;
  sourceSafe: DecorationSet;
};

export type LiveMdAnalysis = LiveMdRuntimeState & {
  atomicRanges: RangeSet<RangeValue>;
  decorations: DecorationSet;
  destructiveDecorations: DecorationSet;
  interactiveDecorations: DecorationSet;
  sourceSafeDecorations: DecorationSet;
  surfaceAtomicRanges: RangeSet<RangeValue>;
  surfaceDecorations: DecorationSet;
  surfaceDestructiveDecorations: DecorationSet;
  surfaceInteractiveDecorations: DecorationSet;
  surfaceSourceSafeDecorations: DecorationSet;
};
