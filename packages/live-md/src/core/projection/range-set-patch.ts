import { type Range, RangeSet, type RangeValue } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { type DocRange } from "../analysis/types.js";
import { liveMdProjectionValueOwnerKeys, type LiveMdProjectionLayer } from "./emit.js";

export function mergeCompileRanges(ranges: readonly DocRange[]) {
  let sorted = ranges
    .filter((range) => range.from < range.to)
    .slice()
    .sort((left, right) => left.from - right.from || left.to - right.to);
  let merged: DocRange[] = [];
  for (let range of sorted) {
    let previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
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

export function patchOwnedRangeSet<T extends RangeValue>(
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

export function emptyProjectionLayer(): LiveMdProjectionLayer {
  return {
    atomicRanges: RangeSet.empty,
    decorations: Decoration.none,
    destructiveDecorations: Decoration.none,
    interactiveDecorations: Decoration.none,
    sourceSafeDecorations: Decoration.none,
  };
}
