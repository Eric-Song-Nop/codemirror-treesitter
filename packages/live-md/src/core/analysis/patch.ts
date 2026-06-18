import { syntaxTree } from "@codemirror-treesitter/language";
import { buildLiveMdSemanticIndex, createLiveMdSemanticIndexFromUnitIndex } from "./build.js";
import { createLiveMdUnitIndex } from "./unit-index.js";
import {
  activeLiveMdLines,
  expandLiveMdQueryRanges,
  mergeLiveMdRanges,
  normalizeLiveMdRanges,
} from "./ranges.js";
import type {
  LiveMdDocRange,
  LiveMdInvalidation,
  LiveMdInvalidationReason,
  LiveMdSemanticIndex,
} from "./types.js";
import type { EditorState } from "@codemirror/state";

export type PatchLiveMdSemanticIndexOptions = {
  activeLines?: ReadonlySet<number>;
  invalidation: LiveMdInvalidation;
  previousIndex: LiveMdSemanticIndex | null;
  ranges: readonly LiveMdDocRange[];
};

const semanticQueryReasons = new Set<LiveMdInvalidationReason>(["doc", "tree", "viewport"]);

export function patchLiveMdSemanticIndex(
  state: EditorState,
  options: PatchLiveMdSemanticIndexOptions,
): LiveMdSemanticIndex {
  let activeLines = options.activeLines ?? activeLiveMdLines(state);
  let ranges = normalizeLiveMdRanges(state, options.ranges);
  let previousIndex = options.previousIndex;

  if (!previousIndex || options.invalidation.reasons.includes("init")) {
    return buildLiveMdSemanticIndex(state, { activeLines, ranges });
  }

  let mappedIndex = createLiveMdUnitIndex(
    options.invalidation.mappedPreviousUnits.length
      ? options.invalidation.mappedPreviousUnits
      : previousIndex.units,
  );
  let queryRanges = patchLiveMdSemanticQueryRanges(state, options.invalidation);
  let unitIndex = mappedIndex;

  if (queryRanges.length) {
    let queriedIndex = buildLiveMdSemanticIndex(state, {
      activeLines,
      queryRanges,
      ranges: queryRanges,
    });
    unitIndex = mappedIndex.patch(queryRanges, queriedIndex.units, state);
  }

  return createLiveMdSemanticIndexFromUnitIndex(state, {
    activeLines,
    queryRanges,
    ranges,
    tree: syntaxTree(state),
    unitIndex,
  });
}

function patchLiveMdSemanticQueryRanges(state: EditorState, invalidation: LiveMdInvalidation) {
  if (!invalidation.reasons.some((reason) => semanticQueryReasons.has(reason))) return [];
  let seed = mergeLiveMdRanges(invalidation.semanticDirtyRanges);
  return seed.length ? expandLiveMdQueryRanges(state, seed) : [];
}
