import type { EditorState, RangeSet, RangeValue } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import type { LiveMdInvalidation, LiveMdSemanticIndex } from "../analysis/index.js";
import {
  projectLiveMdSemantics,
  type CodeFenceParseResult,
  type LiveMdProjectionCache,
} from "../projection/index.js";
import type { LiveMdRuntimeConfig } from "./config.js";

export type LiveMdRuntimeProjectionInput = {
  cache: LiveMdProjectionCache;
  config: LiveMdRuntimeConfig;
  invalidation: LiveMdInvalidation;
  semanticIndex: LiveMdSemanticIndex;
  state: EditorState;
};

export type LiveMdProjectionResult = {
  atomicRanges: RangeSet<RangeValue>;
  codeFenceParses: readonly CodeFenceParseResult[];
  decorations: DecorationSet;
};

export function projectLiveMdRuntime(input: LiveMdRuntimeProjectionInput): LiveMdProjectionResult {
  return projectLiveMdSemantics(
    {
      activeLines: input.semanticIndex.activeLines,
      codeFenceHighlighters: input.config.codeFenceHighlighters,
      codeFenceLanguages: input.config.codeFenceLanguages,
      imageSourceResolver: input.config.imageSourceResolver,
      linkBaseUrl: input.config.linkBaseUrl,
      markdownFeatures: input.config.markdownFeatures,
      ranges: input.semanticIndex.ranges,
      state: input.state,
    },
    input.semanticIndex,
    input.cache,
  );
}
