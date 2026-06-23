import { type RangeSet, type RangeValue } from "@codemirror/state";
import { type Tree } from "@codemirror-treesitter/language";
import { type DecorationSet } from "@codemirror/view";
import { type LiveMdSemanticState } from "../analysis/descriptors.js";
import { type LiveMdSourceIslandLeaf } from "../analysis/markdown-source-islands.js";
import { type DocRange, type LiveMdLeafAnalysisTrace } from "../analysis/types.js";

export type LiveMdSemanticTrace = LiveMdLeafAnalysisTrace;

export type LiveMdAnalysis = {
  activeLines: ReadonlySet<number>;
  activeSourceRanges: readonly DocRange[];
  atomicRanges: RangeSet<RangeValue>;
  decorations: DecorationSet;
  semantic: LiveMdSemanticState | null;
  semanticTrace: LiveMdSemanticTrace | null;
  sourceIslandLeaves: readonly LiveMdSourceIslandLeaf[];
  trace: LiveMdLeafAnalysisTrace;
  tree: Tree;
};
