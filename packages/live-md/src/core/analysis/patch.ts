import { syntaxTree } from "@codemirror-treesitter/language";
import { isWhitespaceOnly } from "../util.js";
import {
  buildLiveMdSemanticIndex,
  collectLiveMdSemanticUnits,
  createLiveMdSemanticIndexFromUnitIndex,
} from "./build.js";
import { queryLiveMdSemanticMatches } from "./query.js";
import { createLiveMdUnitIndex, reconcileLiveMdUnitIndex } from "./unit-index.js";
import {
  activeLiveMdLines,
  expandLiveMdQueryRanges,
  liveMdRangeTouchesPatchRanges,
  liveMdRangeTouchesRanges,
  mergeLiveMdRanges,
  normalizeLiveMdRanges,
} from "./ranges.js";
import type {
  LiveMdDocRange,
  LiveMdInvalidation,
  LiveMdInvalidationReason,
  LiveMdSemanticIndex,
  LiveMdSemanticPatchPlan,
  LiveMdSemanticPatchReconcile,
  LiveMdSemanticUnit,
  LiveMdUnitIndex,
  LiveMdUnitId,
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

  let plan = createLiveMdPatchPlan(state, options);
  let tree = syntaxTree(state);
  let { unitIndex } = reconcileLiveMdSemanticPatch(state, tree, plan);

  return createLiveMdSemanticIndexFromUnitIndex(state, {
    activeLines,
    queryRanges: plan.queryRanges,
    ranges,
    tree,
    unitIndex,
  });
}

export function __testCreateLiveMdPatchPlan(
  state: EditorState,
  options: PatchLiveMdSemanticIndexOptions,
): LiveMdSemanticPatchPlan {
  return createLiveMdPatchPlan(state, options);
}

function createLiveMdPatchPlan(
  state: EditorState,
  options: PatchLiveMdSemanticIndexOptions,
): LiveMdSemanticPatchPlan {
  let mappedPreviousIndex = createLiveMdUnitIndex(liveMdMappedPreviousUnits(options));
  let semanticDirtyRanges = patchLiveMdSemanticDirtyRanges(state, options.invalidation);
  let initialDeleteRanges = patchLiveMdSemanticDeleteRanges(state, semanticDirtyRanges);
  let initiallyTouchedUnits = initialDeleteRanges.length
    ? patchLiveMdTouchedUnits(mappedPreviousIndex, initialDeleteRanges)
    : [];
  let dirtyOwnerRanges = semanticDirtyRanges.length
    ? patchLiveMdDirtyOwnerRanges(initiallyTouchedUnits, semanticDirtyRanges)
    : [];
  let queryRanges = patchLiveMdSemanticQueryRanges(state, dirtyOwnerRanges);
  let deleteRanges = patchLiveMdSemanticDeleteRanges(state, dirtyOwnerRanges);
  let oldTouchedUnits = deleteRanges.length
    ? patchLiveMdTouchedUnits(mappedPreviousIndex, deleteRanges)
    : [];
  let deleteOwnerIds = new Set<LiveMdUnitId>(
    oldTouchedUnits.filter(liveMdPatchUsesLocalOwner).map((unit) => unit.ownerId),
  );

  return {
    deleteOwnerIds,
    deleteRanges,
    dirtyOwnerRanges,
    mappedPreviousIndex,
    oldTouchedUnits,
    queryRanges,
    semanticDirtyRanges,
  };
}

function reconcileLiveMdSemanticPatch(
  state: EditorState,
  tree: ReturnType<typeof syntaxTree>,
  plan: LiveMdSemanticPatchPlan,
): LiveMdSemanticPatchReconcile {
  let newUnits = plan.queryRanges.length
    ? reuseMappedLiveMdUnits(
        plan.mappedPreviousIndex,
        collectLiveMdSemanticUnits(state, queryLiveMdSemanticMatches(tree, plan.queryRanges)),
      )
    : [];
  return {
    newUnits,
    plan,
    unitIndex: reconcileLiveMdUnitIndex(plan.mappedPreviousIndex, plan, newUnits, state),
  };
}

function liveMdMappedPreviousUnits(options: PatchLiveMdSemanticIndexOptions) {
  let previousIndex = options.previousIndex;
  if (!previousIndex) return [];
  if (options.invalidation.reasons.includes("doc")) return options.invalidation.mappedPreviousUnits;
  return options.invalidation.mappedPreviousUnits.length
    ? options.invalidation.mappedPreviousUnits
    : previousIndex.units;
}

function patchLiveMdSemanticDirtyRanges(state: EditorState, invalidation: LiveMdInvalidation) {
  if (!invalidation.reasons.some((reason) => semanticQueryReasons.has(reason))) return [];
  return patchLiveMdPrecedingBlankDirtyRanges(
    state,
    normalizeLiveMdRanges(state, invalidation.semanticDirtyRanges),
  );
}

function patchLiveMdSemanticQueryRanges(
  state: EditorState,
  dirtyRanges: readonly LiveMdDocRange[],
) {
  let seed = mergeLiveMdRanges(dirtyRanges);
  return seed.length ? expandLiveMdQueryRanges(state, seed) : [];
}

function patchLiveMdSemanticDeleteRanges(
  state: EditorState,
  dirtyRanges: readonly LiveMdDocRange[],
) {
  let seed = mergeLiveMdRanges(dirtyRanges);
  return seed.length ? expandLiveMdQueryRanges(state, seed) : [];
}

function patchLiveMdPrecedingBlankDirtyRanges(
  state: EditorState,
  ranges: readonly LiveMdDocRange[],
) {
  let extraRanges: LiveMdDocRange[] = [];
  for (let range of ranges) {
    if (range.from <= 0 || range.from > state.doc.length) continue;
    let line = state.doc.lineAt(range.from);
    if (line.from != range.from || line.number <= 1) continue;
    let previous = state.doc.line(line.number - 1);
    if (isWhitespaceOnly(state.sliceDoc(previous.from, previous.to))) {
      extraRanges.push({ from: previous.from, to: previous.to });
    }
  }
  return extraRanges.length ? mergeLiveMdRanges([...ranges, ...extraRanges]) : ranges;
}

function patchLiveMdDirtyOwnerRanges(
  touchedUnits: readonly LiveMdSemanticUnit[],
  dirtyRanges: readonly LiveMdDocRange[],
) {
  let ownerRanges = touchedUnits
    .map(liveMdPatchQueryOwnerRange)
    .filter((range): range is LiveMdDocRange => !!range);
  return mergeLiveMdRanges([...dirtyRanges, ...ownerRanges]);
}

function patchLiveMdTouchedUnits(
  mappedPreviousIndex: LiveMdUnitIndex,
  ranges: readonly LiveMdDocRange[],
) {
  let windows = mergeLiveMdRanges(ranges);
  if (!windows.length) return [];

  let touchedLocalOwnerIds = new Set<LiveMdUnitId>();
  for (let unit of mappedPreviousIndex.units) {
    if (
      liveMdPatchUsesLocalOwner(unit) &&
      liveMdRangeTouchesRanges(unit.ownerRange.from, unit.ownerRange.to, windows)
    ) {
      touchedLocalOwnerIds.add(unit.ownerId);
    }
  }

  let touchedUnits: LiveMdSemanticUnit[] = [];
  for (let unit of mappedPreviousIndex.units) {
    let touchRange = liveMdPatchUnitTouchRange(unit);
    if (
      touchedLocalOwnerIds.has(unit.ownerId) ||
      liveMdPatchUnitTouchesRanges(unit, touchRange, windows)
    ) {
      touchedUnits.push(unit);
    }
  }
  return touchedUnits;
}

function liveMdPatchQueryOwnerRange(unit: LiveMdSemanticUnit): LiveMdDocRange | null {
  if (liveMdPatchUsesLocalOwner(unit)) return unit.ownerRange;
  if (
    unit.kind == "paragraphContainer" &&
    unit.containerKind == "block" &&
    unit.source.nodeName == "section"
  ) {
    return unit.childRange;
  }
  return null;
}

function liveMdPatchUsesLocalOwner(unit: LiveMdSemanticUnit) {
  if (unit.source.nodeName == "document" || unit.source.nodeName == "section") return false;
  if (
    unit.kind == "paragraphContainer" &&
    (unit.containerKind == "document" ||
      (unit.containerKind == "block" && unit.source.nodeName == "section"))
  ) {
    return false;
  }
  return true;
}

function liveMdPatchUnitTouchRange(unit: LiveMdSemanticUnit): LiveMdDocRange {
  if (
    unit.kind == "paragraphContainer" &&
    (unit.containerKind == "document" ||
      (unit.containerKind == "block" && unit.source.nodeName == "section"))
  ) {
    return unit.childRange;
  }
  return unit.range;
}

function liveMdPatchUnitTouchesRanges(
  unit: LiveMdSemanticUnit,
  range: LiveMdDocRange,
  ranges: readonly LiveMdDocRange[],
) {
  return liveMdPatchUsesLocalOwner(unit)
    ? liveMdRangeTouchesRanges(range.from, range.to, ranges)
    : liveMdRangeTouchesPatchRanges(range.from, range.to, ranges);
}

function reuseMappedLiveMdUnits(
  mappedPreviousIndex: LiveMdUnitIndex,
  units: readonly LiveMdSemanticUnit[],
) {
  return units.map((unit) => mappedPreviousIndex.unitsById.get(unit.id) ?? unit);
}
