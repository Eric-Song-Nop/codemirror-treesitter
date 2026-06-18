import { RangeSet, type EditorState, type RangeValue } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import type { LiveMdInvalidation, LiveMdSemanticIndex } from "../analysis/index.js";
import type { LiveMdRuntimeConfig } from "./config.js";

export type LiveMdProjectionInput = {
  config: LiveMdRuntimeConfig;
  invalidation: LiveMdInvalidation;
  previous: LiveMdProjectionResult | null;
  semanticIndex: LiveMdSemanticIndex;
  state: EditorState;
};

export type LiveMdProjectionResult = {
  atomicRanges: RangeSet<RangeValue>;
  decorations: DecorationSet;
};

const emptyLiveMdProjection: LiveMdProjectionResult = {
  atomicRanges: RangeSet.empty,
  decorations: Decoration.none,
};

export function projectLiveMdRuntime(_input: LiveMdProjectionInput): LiveMdProjectionResult {
  return emptyLiveMdProjection;
}
