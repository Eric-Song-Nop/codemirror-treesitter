import type { ChangeDesc, EditorState } from "@codemirror/state";
import { mapPreviousLiveMdSemanticUnits } from "./ids.js";
import { liveMdOwnerRangesForUnits, liveMdUnitsById, liveMdUnitsByOwnerId } from "./owners.js";
import { clampLiveMdPosition, liveMdRangeTouchesRanges, mergeLiveMdRanges } from "./ranges.js";
import type {
  LiveMdDocRange,
  LiveMdOwnerRange,
  LiveMdSemanticUnit,
  LiveMdUnitId,
  LiveMdUnitIndex,
  LiveMdUnitIndexPatchDocLength,
  LiveMdUnitIndexReconcilePlan,
} from "./types.js";

export function createLiveMdUnitIndex(units: readonly LiveMdSemanticUnit[]): LiveMdUnitIndex {
  let indexedUnits = sortLiveMdIndexedUnits(dedupeLiveMdUnits(units));
  let unitIndex: LiveMdUnitIndex = {
    ownerRanges: liveMdOwnerRangesForUnits(indexedUnits),
    units: indexedUnits,
    unitsById: liveMdUnitsById(indexedUnits),
    unitsByOwnerId: liveMdUnitsByOwnerId(indexedUnits),
    touching(ranges) {
      return liveMdUnitIndexTouching(unitIndex, ranges);
    },
    map(changes, state) {
      return mapLiveMdUnitIndex(unitIndex, changes, state);
    },
    patch(windows, newUnits, stateOrDocLength) {
      return patchLiveMdUnitIndex(unitIndex, windows, newUnits, stateOrDocLength);
    },
  };
  return unitIndex;
}

export function liveMdUnitIndexTouching(
  index: LiveMdUnitIndex,
  ranges: readonly LiveMdDocRange[],
): readonly LiveMdSemanticUnit[] {
  let windows = mergeLiveMdRanges(ranges);
  if (!windows.length) return [];

  let touchedOwnerIds = liveMdTouchedOwnerIds(index.ownerRanges, windows);
  let touching: LiveMdSemanticUnit[] = [];
  for (let unit of index.units) {
    if (touchedOwnerIds.has(unit.ownerId) || liveMdUnitTouchesRanges(unit, windows)) {
      touching.push(unit);
    }
  }
  return touching;
}

export function mapLiveMdUnitIndex(
  index: LiveMdUnitIndex,
  changes: ChangeDesc,
  state: EditorState,
): LiveMdUnitIndex {
  if (changes.empty) return index;
  return createLiveMdUnitIndex(mapPreviousLiveMdSemanticUnits(index.units, changes, state));
}

export function patchLiveMdUnitIndex(
  index: LiveMdUnitIndex,
  windows: readonly LiveMdDocRange[],
  newUnits: readonly LiveMdSemanticUnit[],
  stateOrDocLength: LiveMdUnitIndexPatchDocLength,
): LiveMdUnitIndex {
  let patchWindows = liveMdPatchWindows(windows, stateOrDocLength);
  if (!patchWindows.length) {
    return newUnits.length ? createLiveMdUnitIndex([...index.units, ...newUnits]) : index;
  }

  let patchedUnits = index.units.filter((unit) => !liveMdUnitOverlapsRanges(unit, patchWindows));
  patchedUnits.push(...newUnits);
  return createLiveMdUnitIndex(patchedUnits);
}

export function reconcileLiveMdUnitIndex(
  index: LiveMdUnitIndex,
  plan: LiveMdUnitIndexReconcilePlan,
  newUnits: readonly LiveMdSemanticUnit[],
  stateOrDocLength: LiveMdUnitIndexPatchDocLength,
): LiveMdUnitIndex {
  let deleteRanges = liveMdPatchWindows(plan.deleteRanges, stateOrDocLength);
  let deleteUnitIds = new Set(plan.oldTouchedUnits.map((unit) => unit.id));
  if (!deleteRanges.length && !deleteUnitIds.size && !plan.deleteOwnerIds.size) {
    return newUnits.length ? createLiveMdUnitIndex([...index.units, ...newUnits]) : index;
  }

  let patchedUnits = index.units.filter(
    (unit) => !deleteUnitIds.has(unit.id) && !plan.deleteOwnerIds.has(unit.ownerId),
  );
  patchedUnits.push(...newUnits);
  return createLiveMdUnitIndex(patchedUnits);
}

function liveMdTouchedOwnerIds(
  ownerRanges: readonly LiveMdOwnerRange[],
  ranges: readonly LiveMdDocRange[],
) {
  let ownerIds = new Set<LiveMdUnitId>();
  for (let owner of ownerRanges) {
    if (liveMdRangeTouchesRanges(owner.range.from, owner.range.to, ranges)) {
      ownerIds.add(owner.id);
    }
  }
  return ownerIds;
}

function liveMdUnitTouchesRanges(unit: LiveMdSemanticUnit, ranges: readonly LiveMdDocRange[]) {
  return (
    liveMdRangeTouchesRanges(unit.range.from, unit.range.to, ranges) ||
    liveMdRangeTouchesRanges(unit.ownerRange.from, unit.ownerRange.to, ranges)
  );
}

function liveMdUnitOverlapsRanges(unit: LiveMdSemanticUnit, ranges: readonly LiveMdDocRange[]) {
  return (
    liveMdRangeOverlapsRanges(unit.range.from, unit.range.to, ranges) ||
    liveMdRangeOverlapsRanges(unit.ownerRange.from, unit.ownerRange.to, ranges)
  );
}

function liveMdRangeOverlapsRanges(from: number, to: number, ranges: readonly LiveMdDocRange[]) {
  return ranges.some((range) => from < range.to && to > range.from);
}

function liveMdPatchWindows(
  windows: readonly LiveMdDocRange[],
  stateOrDocLength: LiveMdUnitIndexPatchDocLength,
) {
  let docLength =
    typeof stateOrDocLength == "number" ? stateOrDocLength : stateOrDocLength.doc.length;
  return mergeLiveMdRanges(
    windows.map((window) => ({
      from: clampLiveMdPosition(window.from, 0, docLength),
      to: clampLiveMdPosition(window.to, 0, docLength),
    })),
  );
}

function dedupeLiveMdUnits(units: readonly LiveMdSemanticUnit[]) {
  let byId = new Map<LiveMdUnitId, LiveMdSemanticUnit>();
  for (let unit of units) byId.set(unit.id, unit);
  return Array.from(byId.values());
}

function sortLiveMdIndexedUnits(units: readonly LiveMdSemanticUnit[]) {
  return [...units].sort(
    (left, right) =>
      left.range.from - right.range.from ||
      left.range.to - right.range.to ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id),
  );
}
