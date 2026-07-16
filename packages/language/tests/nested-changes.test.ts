import { describe, expect, it } from "vite-plus/test";
import { __testCollectChangedRanges, TreeSitterParser } from "../src/language.js";
import { Tree, type DocRange, type NestedTree } from "../src/tree.js";
import type { Range as TSRange, Tree as TSTree } from "web-tree-sitter";

type MatchStats = {
  indexedGroups: number;
  indexedRanges: number;
  exactLookups: number;
  intervalQueries: number;
  intervalNodeVisits: number;
  rangeComparisons: number;
};

type NativeStub = TSTree & { readonly label: string };

function stats(): MatchStats {
  return {
    indexedGroups: 0,
    indexedRanges: 0,
    exactLookups: 0,
    intervalQueries: 0,
    intervalNodeVisits: 0,
    rangeComparisons: 0,
  };
}

function tsRange(from: number, to: number): TSRange {
  return {
    startIndex: from,
    endIndex: to,
    startPosition: { row: 0, column: from },
    endPosition: { row: 0, column: to },
  } as TSRange;
}

function native(label: string, changed: readonly DocRange[] = [], calls?: string[]): NativeStub {
  return {
    label,
    getChangedRanges(next: TSTree) {
      calls?.push(`${label}->${(next as NativeStub).label}`);
      return changed.map(({ from, to }) => tsRange(from, to));
    },
  } as unknown as NativeStub;
}

function wrapped(
  parser: TreeSitterParser,
  label: string,
  nested: readonly NestedTree[] = [],
  changed: readonly DocRange[] = [],
  calls?: string[],
): Tree {
  return new Tree(native(label, changed, calls), parser, 1_000_000, nested);
}

function nested(
  parser: TreeSitterParser,
  ranges: readonly DocRange[],
  label: string,
  changed: readonly DocRange[] = [],
  calls?: string[],
): NestedTree {
  return {
    parser,
    ranges,
    tree: wrapped(parser, label, [], changed, calls),
  };
}

function ordered(ranges: readonly DocRange[]): DocRange[] {
  return Array.from(ranges, ({ from, to }) => ({ from, to })).sort(
    (a, b) => a.from - b.from || a.to - b.to,
  );
}

function collect(
  oldNested: readonly NestedTree[],
  newNested: readonly NestedTree[],
  matchStats = stats(),
): DocRange[] {
  let outer = TreeSitterParser.getSkippingParser();
  let oldTree = wrapped(outer, "old-outer", oldNested);
  let newTree = wrapped(outer, "new-outer", newNested);
  return __testCollectChangedRanges(oldTree, newTree, matchStats);
}

describe("nested changed-range pairing", () => {
  it("recurses only when parser and the complete range group are identical", () => {
    let parser = TreeSitterParser.getSkippingParser();
    let calls: string[] = [];
    let ranges = [
      { from: 10, to: 20 },
      { from: 30, to: 40 },
    ];
    let oldNested = nested(parser, ranges, "old-child", [{ from: 12, to: 14 }], calls);
    let newNested = nested(parser, ranges, "new-child");

    expect(collect([oldNested], [newNested])).toEqual([{ from: 12, to: 14 }]);
    expect(calls).toEqual(["old-child->new-child"]);
  });

  it.each([
    {
      name: "overlapping but shifted",
      oldRanges: [[{ from: 0, to: 10 }]],
      newRanges: [[{ from: 1, to: 11 }]],
    },
    {
      name: "touching endpoints",
      oldRanges: [[{ from: 0, to: 10 }]],
      newRanges: [[{ from: 10, to: 20 }]],
    },
    {
      name: "split",
      oldRanges: [[{ from: 0, to: 20 }]],
      newRanges: [[{ from: 0, to: 10 }], [{ from: 10, to: 20 }]],
    },
    {
      name: "merge",
      oldRanges: [[{ from: 0, to: 10 }], [{ from: 10, to: 20 }]],
      newRanges: [[{ from: 0, to: 20 }]],
    },
  ])("marks both old and new groups dirty for $name", ({ oldRanges, newRanges }) => {
    let parser = TreeSitterParser.getSkippingParser();
    let calls: string[] = [];
    let oldNested = oldRanges.map((ranges, index) =>
      nested(parser, ranges, `old-${index}`, [], calls),
    );
    let newNested = newRanges.map((ranges, index) => nested(parser, ranges, `new-${index}`));

    expect(ordered(collect(oldNested, newNested))).toEqual(
      ordered([...oldRanges.flat(), ...newRanges.flat()]),
    );
    expect(calls).toEqual([]);
  });

  it("pairs duplicate exact groups FIFO and marks unmatched old and new groups dirty", () => {
    let parser = TreeSitterParser.getSkippingParser();
    let calls: string[] = [];
    let a = [{ from: 100, to: 110 }];
    let b = [{ from: 200, to: 210 }];
    let oldNested = [
      nested(parser, a, "old-a-1", [{ from: 101, to: 102 }], calls),
      nested(parser, a, "old-a-2", [{ from: 103, to: 104 }], calls),
      nested(parser, a, "old-a-unmatched", [], calls),
      nested(parser, b, "old-b-1", [{ from: 201, to: 202 }], calls),
    ];
    let newNested = [
      nested(parser, a, "new-a-1"),
      nested(parser, a, "new-a-2"),
      nested(parser, b, "new-b-1"),
      nested(parser, b, "new-b-unmatched"),
    ];

    expect(ordered(collect(oldNested, newNested))).toEqual(
      ordered([{ from: 101, to: 102 }, { from: 103, to: 104 }, { from: 201, to: 202 }, ...a, ...b]),
    );
    expect(calls).toEqual(["old-a-1->new-a-1", "old-a-2->new-a-2", "old-b-1->new-b-1"]);
  });

  it("pairs 10,000 exact groups with a deterministic linear operation bound", () => {
    let parser = TreeSitterParser.getSkippingParser();
    let count = 10_000;
    let oldNested = Array.from({ length: count }, (_, index) =>
      nested(parser, [{ from: index * 3, to: index * 3 + 1 }], `old-${index}`),
    );
    let newNested = Array.from({ length: count }, (_, index) =>
      nested(parser, [{ from: index * 3, to: index * 3 + 1 }], `new-${index}`),
    );
    let matchStats = stats();

    expect(collect(oldNested, newNested, matchStats)).toEqual([]);
    expect(matchStats.indexedGroups).toBe(count);
    expect(matchStats.indexedRanges).toBe(count);
    expect(matchStats.exactLookups).toBe(count);
    expect(matchStats.intervalQueries).toBe(0);
    expect(matchStats.intervalNodeVisits).toBe(0);
    expect(matchStats.rangeComparisons).toBe(0);
    expect(
      matchStats.indexedGroups + matchStats.indexedRanges + matchStats.exactLookups,
    ).toBeLessThanOrEqual(count * 3);
  });
});
