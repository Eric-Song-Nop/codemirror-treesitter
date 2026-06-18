import type { EditorState } from "@codemirror/state";
import {
  activeLiveMdLines,
  buildLiveMdSemanticIndex,
  createLiveMdInvalidation,
  type LiveMdDocRange,
  type LiveMdInvalidation,
  type LiveMdRuntimeSnapshot,
} from "../analysis/index.js";
import { LiveMdProjectionCache } from "../projection/index.js";
import { readLiveMdRuntimeConfig, type LiveMdRuntimeConfig } from "./config.js";
import { projectLiveMdRuntime } from "./projection.js";

export type CreateLiveMdRuntimeSnapshotOptions = {
  activeLines?: ReadonlySet<number>;
  config?: LiveMdRuntimeConfig;
  invalidation?: LiveMdInvalidation;
  previous?: LiveMdRuntimeSnapshot | null;
  visibleRanges: readonly LiveMdDocRange[];
};

export function createLiveMdRuntimeSnapshot(
  state: EditorState,
  options: CreateLiveMdRuntimeSnapshotOptions,
): LiveMdRuntimeSnapshot {
  let activeLines = options.activeLines ?? activeLiveMdLines(state);
  let semanticIndex = buildLiveMdSemanticIndex(state, {
    activeLines,
    ranges: options.visibleRanges,
  });
  let config = options.config ?? readLiveMdRuntimeConfig(state);
  let invalidation =
    options.invalidation ??
    createLiveMdInvalidation({
      activeLines,
      state,
      visibleRanges: options.visibleRanges,
    });
  let projectionCache = options.previous?.projectionCache ?? new LiveMdProjectionCache();
  let projection = projectLiveMdRuntime({
    cache: projectionCache,
    config,
    invalidation,
    semanticIndex,
    state,
  });

  return {
    activeLines,
    atomicRanges: projection.atomicRanges,
    codeFenceHighlightTrees: projection.codeFenceParses,
    decorations: projection.decorations,
    invalidation,
    projectionCache,
    ranges: semanticIndex.ranges,
    semanticIndex,
    tree: semanticIndex.tree,
    version: (options.previous?.version ?? 0) + 1,
    visibleRanges: options.visibleRanges,
  };
}
