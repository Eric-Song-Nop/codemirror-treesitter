import type { DocRange, NestedTree, TreeConfig } from "./tree.js";

export interface NestedTreeMatcherStats {
  indexedGroups: number;
  indexedRanges: number;
  exactLookups: number;
  intervalQueries: number;
  intervalNodeVisits: number;
  rangeComparisons: number;
}

export interface NestedTreeMatch {
  readonly tree: NestedTree;
  readonly exact: boolean;
}

interface ExactQueue {
  readonly entries: MatchEntry[];
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
  readonly order: number;
}

interface IntervalNode {
  readonly range: IndexedRange;
  left: IntervalNode | null;
  right: IntervalNode | null;
  height: number;
  maxTo: number;
}

interface ParserIndex {
  readonly exact: Map<string, ExactQueue>;
  intervals: IntervalNode | null;
}

export class NestedTreeMatcher {
  readonly stats: NestedTreeMatcherStats;

  private readonly indexes = new Map<TreeConfig, ParserIndex>();
  private readonly entries: MatchEntry[] = [];
  private nestedIndex = 0;
  private rangeIndex = 0;
  private rangeOrder = 0;
  private activeEntry: MatchEntry | null = null;
  private activeKey = "";
  private ready = false;

  constructor(
    private readonly nested: readonly NestedTree[],
    stats: NestedTreeMatcherStats = {
      indexedGroups: 0,
      indexedRanges: 0,
      exactLookups: 0,
      intervalQueries: 0,
      intervalNodeVisits: 0,
      rangeComparisons: 0,
    },
    deferred = false,
  ) {
    this.stats = stats;
    if (!deferred) this.work();
  }

  work(shouldStop?: () => boolean): boolean {
    if (this.ready) return true;
    while (this.nestedIndex < this.nested.length) {
      if (shouldStop?.()) return false;
      let entry = this.activeEntry;
      if (!entry) {
        entry = { tree: this.nested[this.nestedIndex]!, taken: false };
        this.activeEntry = entry;
        this.entries.push(entry);
        this.stats.indexedGroups++;
      }

      let { tree } = entry;
      let parserIndex = this.indexes.get(tree.parser);
      if (!parserIndex) {
        parserIndex = { exact: new Map(), intervals: null };
        this.indexes.set(tree.parser, parserIndex);
      }
      while (this.rangeIndex < tree.ranges.length) {
        if (shouldStop?.()) return false;
        let range = tree.ranges[this.rangeIndex++]!;
        this.activeKey += `${range.from}:${range.to};`;
        parserIndex.intervals = insertInterval(parserIndex.intervals, {
          from: range.from,
          to: range.to,
          entry,
          order: this.rangeOrder++,
        });
        this.stats.indexedRanges++;
      }

      let exact = parserIndex.exact.get(this.activeKey);
      if (exact) exact.entries.push(entry);
      else parserIndex.exact.set(this.activeKey, { entries: [entry], next: 0 });
      this.nestedIndex++;
      this.rangeIndex = 0;
      this.activeEntry = null;
      this.activeKey = "";
    }
    this.ready = true;
    return true;
  }

  take(parser: TreeConfig, ranges: readonly DocRange[]): NestedTree | null {
    return this.match(parser, ranges)?.tree ?? null;
  }

  match(parser: TreeConfig, ranges: readonly DocRange[]): NestedTreeMatch | null {
    this.ensureReady();
    let exact = this.takeExactEntry(parser, ranges);
    if (exact.known) return exact.entry ? { tree: exact.entry.tree, exact: true } : null;

    let index = this.indexes.get(parser);
    if (!index) return null;
    for (let range of ranges) {
      this.stats.intervalQueries++;
      let found = this.findOverlap(index.intervals, range);
      if (found) return { tree: found.entry.tree, exact: false };
    }
    return null;
  }

  takeExact(parser: TreeConfig, ranges: readonly DocRange[]): NestedTree | null {
    this.ensureReady();
    return this.takeExactEntry(parser, ranges).entry?.tree ?? null;
  }

  remaining(): NestedTree[] {
    this.ensureReady();
    return this.entries.filter((entry) => !entry.taken).map((entry) => entry.tree);
  }

  private ensureReady() {
    if (!this.ready) throw new Error("Nested tree matcher index is incomplete");
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

function insertInterval(node: IntervalNode | null, range: IndexedRange): IntervalNode {
  if (!node) {
    return { range, left: null, right: null, height: 1, maxTo: range.to };
  }
  if (compareIndexedRanges(range, node.range) < 0) node.left = insertInterval(node.left, range);
  else node.right = insertInterval(node.right, range);
  refreshIntervalNode(node);

  let balance = intervalHeight(node.left) - intervalHeight(node.right);
  if (balance > 1) {
    if (compareIndexedRanges(range, node.left!.range) > 0)
      node.left = rotateIntervalLeft(node.left!);
    return rotateIntervalRight(node);
  }
  if (balance < -1) {
    if (compareIndexedRanges(range, node.right!.range) < 0) {
      node.right = rotateIntervalRight(node.right!);
    }
    return rotateIntervalLeft(node);
  }
  return node;
}

function compareIndexedRanges(left: IndexedRange, right: IndexedRange) {
  return left.from - right.from || left.to - right.to || left.order - right.order;
}

function intervalHeight(node: IntervalNode | null) {
  return node?.height ?? 0;
}

function refreshIntervalNode(node: IntervalNode) {
  node.height = Math.max(intervalHeight(node.left), intervalHeight(node.right)) + 1;
  node.maxTo = Math.max(
    node.range.to,
    node.left?.maxTo ?? -Infinity,
    node.right?.maxTo ?? -Infinity,
  );
}

function rotateIntervalLeft(node: IntervalNode) {
  let right = node.right!;
  node.right = right.left;
  right.left = node;
  refreshIntervalNode(node);
  refreshIntervalNode(right);
  return right;
}

function rotateIntervalRight(node: IntervalNode) {
  let left = node.left!;
  node.left = left.right;
  left.right = node;
  refreshIntervalNode(node);
  refreshIntervalNode(left);
  return left;
}
