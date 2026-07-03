import {
  type ChangeDesc,
  type Range,
  RangeSet,
  RangeSetBuilder,
  type RangeValue,
} from "@codemirror/state";
import { patchRangeSet } from "@codemirror-treesitter/language";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { type DocRange } from "../analysis/types.js";
import { liveMdProjectionValueOwnerKeys, type LiveMdProjectionLayer } from "../projection/emit.js";

export type ProjectionSets = {
  atomicRanges: RangeSet<RangeValue>;
  destructiveDecorations: DecorationSet;
  interactiveDecorations: DecorationSet;
  sourceSafeDecorations: DecorationSet;
  structuralLineDecorations: DecorationSet;
};

export function emptyProjectionSets(): ProjectionSets {
  return {
    atomicRanges: RangeSet.empty,
    destructiveDecorations: Decoration.none,
    interactiveDecorations: Decoration.none,
    sourceSafeDecorations: Decoration.none,
    structuralLineDecorations: Decoration.none,
  };
}

export function projectionSetsFromLayer(layer: LiveMdProjectionLayer): ProjectionSets {
  return {
    atomicRanges: layer.atomicRanges,
    destructiveDecorations: layer.destructiveDecorations,
    interactiveDecorations: layer.interactiveDecorations,
    sourceSafeDecorations: layer.sourceSafeDecorations,
    structuralLineDecorations: layer.structuralLineDecorations,
  };
}

export function projectionLayerFromSets(sets: ProjectionSets): LiveMdProjectionLayer {
  return {
    ...sets,
    decorations: joinProjectionSets(sets),
  };
}

export function joinProjectionSets(sets: ProjectionSets): DecorationSet {
  return RangeSet.join([
    sets.sourceSafeDecorations,
    sets.structuralLineDecorations,
    sets.interactiveDecorations,
    sets.destructiveDecorations,
  ]);
}

export function mergeProjectionSets(
  primary: ProjectionSets,
  secondary: ProjectionSets,
): ProjectionSets {
  return {
    atomicRanges: RangeSet.join([primary.atomicRanges, secondary.atomicRanges]),
    destructiveDecorations: RangeSet.join([
      primary.destructiveDecorations,
      secondary.destructiveDecorations,
    ]),
    interactiveDecorations: RangeSet.join([
      primary.interactiveDecorations,
      secondary.interactiveDecorations,
    ]),
    sourceSafeDecorations: RangeSet.join([
      primary.sourceSafeDecorations,
      secondary.sourceSafeDecorations,
    ]),
    structuralLineDecorations: RangeSet.join([
      primary.structuralLineDecorations,
      secondary.structuralLineDecorations,
    ]),
  };
}

export function mapProjectionSets(
  sets: ProjectionSets,
  changes: ChangeDesc,
  revealRanges: readonly DocRange[],
): ProjectionSets {
  return revealProjectionSets(
    {
      atomicRanges: sets.atomicRanges.map(changes),
      destructiveDecorations: sets.destructiveDecorations.map(changes),
      interactiveDecorations: sets.interactiveDecorations.map(changes),
      sourceSafeDecorations: sets.sourceSafeDecorations.map(changes),
      structuralLineDecorations: sets.structuralLineDecorations.map(changes),
    },
    revealRanges,
  );
}

export function revealProjectionSets(
  sets: ProjectionSets,
  ranges: readonly DocRange[],
  options: { clearStructuralLineDecorations?: boolean } = {},
): ProjectionSets {
  if (!ranges.length) return sets;
  return {
    ...sets,
    atomicRanges: clearRangeSetRanges(sets.atomicRanges, ranges),
    destructiveDecorations: clearRangeSetRanges(sets.destructiveDecorations, ranges),
    structuralLineDecorations: options.clearStructuralLineDecorations
      ? clearRangeSetRanges(sets.structuralLineDecorations, ranges)
      : sets.structuralLineDecorations,
  };
}

export function clearInteractiveProjectionSets(
  sets: ProjectionSets,
  ranges: readonly DocRange[],
): ProjectionSets {
  if (!ranges.length) return sets;
  return {
    ...sets,
    interactiveDecorations: clearRangeSetRanges(sets.interactiveDecorations, ranges),
  };
}

export function patchProjectionSets(
  sets: ProjectionSets,
  ranges: readonly DocRange[],
  additions: ProjectionSets,
  removeOwnerKeys: ReadonlySet<string>,
  options: { patchStructuralLineDecorations?: boolean } = {},
): ProjectionSets {
  return {
    atomicRanges: patchOwnedRangeSet(
      sets.atomicRanges,
      ranges,
      collectRangeSetRanges(additions.atomicRanges, [{ from: 0, to: Number.MAX_SAFE_INTEGER }]),
      removeOwnerKeys,
    ),
    destructiveDecorations: patchOwnedRangeSet(
      sets.destructiveDecorations,
      ranges,
      collectRangeSetRanges(additions.destructiveDecorations, [
        { from: 0, to: Number.MAX_SAFE_INTEGER },
      ]),
      removeOwnerKeys,
    ),
    interactiveDecorations: patchOwnedRangeSet(
      sets.interactiveDecorations,
      ranges,
      collectRangeSetRanges(additions.interactiveDecorations, [
        { from: 0, to: Number.MAX_SAFE_INTEGER },
      ]),
      removeOwnerKeys,
    ),
    sourceSafeDecorations: patchOwnedRangeSet(
      sets.sourceSafeDecorations,
      ranges,
      collectRangeSetRanges(additions.sourceSafeDecorations, [
        { from: 0, to: Number.MAX_SAFE_INTEGER },
      ]),
      removeOwnerKeys,
    ),
    structuralLineDecorations:
      options.patchStructuralLineDecorations === false
        ? sets.structuralLineDecorations
        : patchRangeSet(
            sets.structuralLineDecorations,
            ranges,
            collectRangeSetRanges(additions.structuralLineDecorations, [
              { from: 0, to: Number.MAX_SAFE_INTEGER },
            ]),
          ),
  };
}

export function replaceProjectionSets(
  sets: ProjectionSets,
  ranges: readonly DocRange[],
  additions: ProjectionSets,
): ProjectionSets {
  return {
    atomicRanges: patchRangeSet(
      sets.atomicRanges,
      ranges,
      collectRangeSetRanges(additions.atomicRanges, ranges),
    ),
    destructiveDecorations: patchRangeSet(
      sets.destructiveDecorations,
      ranges,
      collectRangeSetRanges(additions.destructiveDecorations, ranges),
    ),
    interactiveDecorations: patchRangeSet(
      sets.interactiveDecorations,
      ranges,
      collectRangeSetRanges(additions.interactiveDecorations, ranges),
    ),
    sourceSafeDecorations: patchRangeSet(
      sets.sourceSafeDecorations,
      ranges,
      collectRangeSetRanges(additions.sourceSafeDecorations, ranges),
    ),
    structuralLineDecorations: patchRangeSet(
      sets.structuralLineDecorations,
      ranges,
      collectRangeSetRanges(additions.structuralLineDecorations, ranges),
    ),
  };
}

export function restoreProjectionSets(
  sets: ProjectionSets,
  base: ProjectionSets,
  ranges: readonly DocRange[],
): ProjectionSets {
  if (!ranges.length) return sets;
  return {
    ...sets,
    atomicRanges: patchRangeSet(
      sets.atomicRanges,
      ranges,
      collectRangeSetRanges(base.atomicRanges, ranges),
    ),
    destructiveDecorations: patchRangeSet(
      sets.destructiveDecorations,
      ranges,
      collectRangeSetRanges(base.destructiveDecorations, ranges),
    ),
    structuralLineDecorations: patchRangeSet(
      sets.structuralLineDecorations,
      ranges,
      collectRangeSetRanges(base.structuralLineDecorations, ranges),
    ),
  };
}

export function filterProjectionSetsToRanges(
  sets: ProjectionSets,
  ranges: readonly DocRange[],
): ProjectionSets {
  return {
    atomicRanges: filterRangeSetToRanges(sets.atomicRanges, ranges),
    destructiveDecorations: filterRangeSetToRanges(sets.destructiveDecorations, ranges),
    interactiveDecorations: filterRangeSetToRanges(sets.interactiveDecorations, ranges),
    sourceSafeDecorations: filterRangeSetToRanges(sets.sourceSafeDecorations, ranges),
    structuralLineDecorations: filterRangeSetToRanges(sets.structuralLineDecorations, ranges),
  };
}

export function collectRangeSetRanges<T extends RangeValue>(
  rangeSet: RangeSet<T>,
  ranges: readonly DocRange[],
): Range<T>[] {
  let collected: Range<T>[] = [];
  if (!ranges.length) return collected;
  for (let range of ranges) {
    rangeSet.between(range.from, range.to, (from, to, value) => {
      collected.push(value.range(from, to));
    });
  }
  return collected;
}

export function clearRangeSetRanges<T extends RangeValue>(
  rangeSet: RangeSet<T>,
  ranges: readonly DocRange[],
) {
  return ranges.length ? patchRangeSet(rangeSet, ranges, []) : rangeSet;
}

function filterRangeSetToRanges<T extends RangeValue>(
  rangeSet: RangeSet<T>,
  ranges: readonly DocRange[],
): RangeSet<T> {
  if (!ranges.length) return RangeSet.empty;
  let collected: Range<T>[] = [];
  let builder = new RangeSetBuilder<T>();
  for (let range of ranges) {
    rangeSet.between(range.from, range.to, (from, to, value) => {
      collected.push(value.range(from, to));
    });
  }
  collected.sort(
    (left, right) =>
      left.from - right.from ||
      left.value.startSide - right.value.startSide ||
      left.to - right.to ||
      left.value.endSide - right.value.endSide,
  );
  for (let range of collected) {
    builder.add(range.from, range.to, range.value);
  }
  return builder.finish();
}

function patchOwnedRangeSet<T extends RangeValue>(
  current: RangeSet<T>,
  dirtyRanges: readonly DocRange[],
  additions: readonly Range<T>[],
  removeOwnerKeys: ReadonlySet<string>,
) {
  let next = current;
  let removalKeys = new Set(removeOwnerKeys);
  for (let addition of additions) {
    for (let ownerKey of liveMdProjectionValueOwnerKeys(addition.value)) {
      removalKeys.add(ownerKey);
    }
  }
  for (let range of dirtyRanges) {
    next = next.update({
      filter: (_from, _to, value) => {
        let ownerKeys = liveMdProjectionValueOwnerKeys(value);
        return !ownerKeys.some((ownerKey) => removalKeys.has(ownerKey));
      },
      filterFrom: range.from,
      filterTo: range.to,
    });
  }
  return additions.length ? next.update({ add: additions, sort: true }) : next;
}
