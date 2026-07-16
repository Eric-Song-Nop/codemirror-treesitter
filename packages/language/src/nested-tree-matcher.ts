import type { DocRange, NestedTree, TreeConfig } from "./tree.js";

export interface NestedTreeMatcherStats {
  indexedGroups: number;
  indexedRanges: number;
  exactLookups: number;
  intervalQueries: number;
  intervalNodeVisits: number;
  rangeComparisons: number;
}

interface ExactQueue {
  readonly entries: readonly MatchEntry[];
  next: number;
}

interface MatchEntry {
  readonly tree: NestedTree;
  taken: boolean;
}

interface IndexedRange {
  readonly from: number;
  readonly to: number;
  readonly entry: MatchEntry;
}

interface IntervalNode {
  readonly range: IndexedRange;
  readonly left: IntervalNode | null;
  readonly right: IntervalNode | null;
  readonly maxTo: number;
}

interface ParserIndex {
  readonly exact: Map<string, ExactQueue>;
  readonly intervals: IntervalNode | null;
}

export class NestedTreeMatcher {
  readonly stats: NestedTreeMatcherStats;

  private readonly indexes = new Map<TreeConfig, ParserIndex>();
  private readonly entries: readonly MatchEntry[];

  constructor(
    nested: readonly NestedTree[],
    stats: NestedTreeMatcherStats = {
      indexedGroups: 0,
      indexedRanges: 0,
      exactLookups: 0,
      intervalQueries: 0,
      intervalNodeVisits: 0,
      rangeComparisons: 0,
    },
  ) {
    this.stats = stats;
    this.entries = nested.map((tree) => ({ tree, taken: false }));
    let exact = new Map<TreeConfig, Map<string, MatchEntry[]>>();
    let intervals = new Map<TreeConfig, IndexedRange[]>();

    for (let entry of this.entries) {
      let { tree } = entry;
      this.stats.indexedGroups++;
      this.stats.indexedRanges += tree.ranges.length;

      let parserExact = exact.get(tree.parser);
      if (!parserExact) exact.set(tree.parser, (parserExact = new Map()));
      let key = rangeKey(tree.ranges);
      let queue = parserExact.get(key);
      if (queue) queue.push(entry);
      else parserExact.set(key, [entry]);

      let parserIntervals = intervals.get(tree.parser);
      if (!parserIntervals) intervals.set(tree.parser, (parserIntervals = []));
      for (let range of tree.ranges) {
        parserIntervals.push({ from: range.from, to: range.to, entry });
      }
    }

    for (let [parser, parserExact] of exact) {
      let parserIntervals = intervals.get(parser) ?? [];
      parserIntervals.sort((a, b) => a.from - b.from || a.to - b.to);
      this.indexes.set(parser, {
        exact: new Map(
          Array.from(parserExact, ([key, entries]) => [key, { entries, next: 0 }] as const),
        ),
        intervals: buildIntervalTree(parserIntervals, 0, parserIntervals.length),
      });
    }
  }

  take(parser: TreeConfig, ranges: readonly DocRange[]): NestedTree | null {
    let exact = this.takeExactEntry(parser, ranges);
    if (exact.known) return exact.entry?.tree ?? null;

    let index = this.indexes.get(parser);
    if (!index) return null;
    for (let range of ranges) {
      this.stats.intervalQueries++;
      let found = this.findOverlap(index.intervals, range);
      if (found) return found.entry.tree;
    }
    return null;
  }

  takeExact(parser: TreeConfig, ranges: readonly DocRange[]): NestedTree | null {
    return this.takeExactEntry(parser, ranges).entry?.tree ?? null;
  }

  remaining(): NestedTree[] {
    return this.entries.filter((entry) => !entry.taken).map((entry) => entry.tree);
  }

  private takeExactEntry(
    parser: TreeConfig,
    ranges: readonly DocRange[],
  ): { known: boolean; entry: MatchEntry | null } {
    this.stats.exactLookups++;
    let exact = this.indexes.get(parser)?.exact.get(rangeKey(ranges));
    if (!exact) return { known: false, entry: null };
    let entry = exact.entries[exact.next++] ?? null;
    if (entry) entry.taken = true;
    return { known: true, entry };
  }

  private findOverlap(node: IntervalNode | null, query: DocRange): IndexedRange | null {
    while (node) {
      this.stats.intervalNodeVisits++;
      if (node.left && node.left.maxTo >= query.from) {
        node = node.left;
        continue;
      }

      this.stats.rangeComparisons++;
      if (node.range.from <= query.to && node.range.to >= query.from) return node.range;
      if (node.range.from > query.to) return null;
      node = node.right;
    }
    return null;
  }
}

function rangeKey(ranges: readonly DocRange[]) {
  let key = "";
  for (let range of ranges) key += `${range.from}:${range.to};`;
  return key;
}

function buildIntervalTree(
  ranges: readonly IndexedRange[],
  from: number,
  to: number,
): IntervalNode | null {
  if (from == to) return null;
  let middle = (from + to) >> 1;
  let left = buildIntervalTree(ranges, from, middle);
  let right = buildIntervalTree(ranges, middle + 1, to);
  let range = ranges[middle]!;
  return {
    range,
    left,
    right,
    maxTo: Math.max(range.to, left?.maxTo ?? -Infinity, right?.maxTo ?? -Infinity),
  };
}
