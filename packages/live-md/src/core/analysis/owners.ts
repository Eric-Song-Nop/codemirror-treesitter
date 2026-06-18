import { mergeLiveMdRanges, liveMdRangeTouchesRanges } from "./ranges.js";
import type {
  LiveMdDocRange,
  LiveMdOwnerRange,
  LiveMdSemanticUnit,
  LiveMdUnitId,
} from "./types.js";

export function liveMdOwnerRangesForUnits(units: readonly LiveMdSemanticUnit[]) {
  let byId = new Map<LiveMdUnitId, LiveMdDocRange>();
  for (let unit of units) {
    let current = byId.get(unit.ownerId);
    if (!current) {
      byId.set(unit.ownerId, { from: unit.ownerRange.from, to: unit.ownerRange.to });
      continue;
    }
    current.from = Math.min(current.from, unit.ownerRange.from);
    current.to = Math.max(current.to, unit.ownerRange.to);
  }
  return Array.from(byId, ([id, range]) => ({ id, range })).sort(compareLiveMdOwnerRanges);
}

export function liveMdUnitsById(units: readonly LiveMdSemanticUnit[]) {
  let byId = new Map<LiveMdUnitId, LiveMdSemanticUnit>();
  for (let unit of units) byId.set(unit.id, unit);
  return byId;
}

export function liveMdUnitsByOwnerId(units: readonly LiveMdSemanticUnit[]) {
  let mutable = new Map<LiveMdUnitId, LiveMdSemanticUnit[]>();
  for (let unit of units) {
    let ownerUnits = mutable.get(unit.ownerId);
    if (!ownerUnits) mutable.set(unit.ownerId, (ownerUnits = []));
    ownerUnits.push(unit);
  }

  let byOwner = new Map<LiveMdUnitId, readonly LiveMdSemanticUnit[]>();
  for (let [id, ownerUnits] of mutable) {
    byOwner.set(id, ownerUnits.sort(compareLiveMdUnits));
  }
  return byOwner;
}

export function liveMdDirtyOwnerRanges(
  ownerRanges: readonly LiveMdOwnerRange[],
  dirtyRanges: readonly LiveMdDocRange[],
) {
  if (!dirtyRanges.length) return [];
  let touched = ownerRanges
    .filter((owner) => liveMdRangeTouchesRanges(owner.range.from, owner.range.to, dirtyRanges))
    .map((owner) => owner.range);
  return mergeLiveMdRanges(touched.length ? touched : dirtyRanges);
}

function compareLiveMdOwnerRanges(left: LiveMdOwnerRange, right: LiveMdOwnerRange) {
  return left.range.from - right.range.from || left.range.to - right.range.to;
}

function compareLiveMdUnits(left: LiveMdSemanticUnit, right: LiveMdSemanticUnit) {
  return left.range.from - right.range.from || left.range.to - right.range.to;
}
