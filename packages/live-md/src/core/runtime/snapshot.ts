import type { EditorState } from "@codemirror/state";
import {
  activeLiveMdLines,
  buildLiveMdGlobalState,
  buildLiveMdSemanticIndex,
  createLiveMdInvalidation,
  patchLiveMdSemanticIndex,
  type LiveMdDocRange,
  type LiveMdInvalidation,
  type LiveMdRuntimeSnapshot,
  type LiveMdSemanticIndex,
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
  let config = options.config ?? readLiveMdRuntimeConfig(state);
  let invalidation =
    options.invalidation ??
    createLiveMdInvalidation({
      activeLines,
      state,
      visibleRanges: options.visibleRanges,
    });
  let semanticIndex = buildLiveMdRuntimeSemanticIndex(state, {
    activeLines,
    invalidation,
    previous: options.previous ?? null,
    visibleRanges: options.visibleRanges,
  });
  let projectionCache = options.previous?.projectionCache ?? new LiveMdProjectionCache();
  projectionCache.beginProjection();
  let projection = projectLiveMdRuntime({
    cache: projectionCache,
    config,
    invalidation,
    semanticIndex,
    state,
  });
  projectionCache.pruneUnused();

  return {
    activeLines,
    atomicRanges: projection.atomicRanges,
    codeFenceHighlightTrees: projection.codeFenceParses,
    decorations: projection.decorations,
    globalState: buildLiveMdGlobalState(state),
    invalidation,
    projectionCache,
    ranges: semanticIndex.ranges,
    semanticIndex,
    tree: semanticIndex.tree,
    version: (options.previous?.version ?? 0) + 1,
    visibleRanges: options.visibleRanges,
  };
}

type BuildLiveMdRuntimeSemanticIndexOptions = {
  activeLines: ReadonlySet<number>;
  invalidation: LiveMdInvalidation;
  previous: LiveMdRuntimeSnapshot | null;
  visibleRanges: readonly LiveMdDocRange[];
};

function buildLiveMdRuntimeSemanticIndex(
  state: EditorState,
  options: BuildLiveMdRuntimeSemanticIndexOptions,
): LiveMdSemanticIndex {
  let previous = options.previous;
  if (!shouldPatchLiveMdRuntimeSemanticIndex(previous, options.invalidation)) {
    return buildLiveMdSemanticIndex(state, {
      activeLines: options.activeLines,
      ranges: options.visibleRanges,
    });
  }

  return patchLiveMdSemanticIndex(state, {
    activeLines: options.activeLines,
    invalidation: options.invalidation,
    previousIndex: previous.semanticIndex,
    ranges: options.visibleRanges,
  });
}

function shouldPatchLiveMdRuntimeSemanticIndex(
  previous: LiveMdRuntimeSnapshot | null,
  invalidation: LiveMdInvalidation,
): previous is LiveMdRuntimeSnapshot {
  return !!previous && !invalidation.reasons.includes("init");
}
