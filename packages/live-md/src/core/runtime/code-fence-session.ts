import { ChangeSet, Text, type ChangeDesc } from "@codemirror/state";
import {
  highlightTree,
  type Highlighter,
  type Tree,
  type TreeSitterParser,
} from "@codemirror-treesitter/language";
import { hashString } from "../analysis/ranges.js";
import { type DocRange, type LiveMdLeafAnalysisTrace } from "../analysis/types.js";
import {
  type LiveMdCodeFenceHighlightResult,
  type LiveMdCodeFenceHighlightSpan,
} from "./render-cache.js";

type NativeParser = ReturnType<TreeSitterParser["createParser"]>;
type NativeTree = NonNullable<ReturnType<TreeSitterParser["parseWith"]>>;

/** Native resources belong to an attached view, never to immutable editor states. */
export class LiveMdCodeFenceSession {
  private nativeParser: NativeParser;
  private nestedParsers = new Map<TreeSitterParser, NativeParser>();
  private base: Tree | null = null;
  private baseDoc: Text | null = null;
  private editedBase: Tree | null = null;
  private parsed: NativeTree | null = null;
  private builder: ReturnType<TreeSitterParser["startTreeBuild"]> | null = null;
  private highlighting: Tree | null = null;
  private highlightFrom = 0;
  private spans: LiveMdCodeFenceHighlightSpan[] = [];
  private doc: Text = Text.empty;
  private source = "";
  private highlighters: readonly Highlighter[] = [];
  private key = "";
  private trace: LiveMdLeafAnalysisTrace;
  private disposed = false;
  pending = false;
  result: LiveMdCodeFenceHighlightResult | null = null;

  constructor(
    readonly parser: TreeSitterParser,
    public range: DocRange,
    trace: LiveMdLeafAnalysisTrace,
  ) {
    this.trace = trace;
    this.nativeParser = parser.createParser();
    trace.codeFenceParserSessionsCreated++;
  }

  request(
    source: string,
    key: string,
    highlighters: readonly Highlighter[],
    trace: LiveMdLeafAnalysisTrace,
  ) {
    if (this.key == key && this.source == source) return;
    this.cancel();
    this.trace = trace;
    this.source = source;
    this.doc = Text.of(source.split("\n"));
    this.highlighters = highlighters;
    this.key = key;
    this.result = null;
    if (this.base && this.baseDoc) {
      if (this.baseDoc.eq(this.doc)) {
        // A theme change only needs new highlight classes, not a new parse.
        this.highlighting = this.base;
      } else {
        let changes = sourceChanges(this.baseDoc, this.doc);
        this.editedBase = this.parser.editWrappedTree(this.base, changes, this.baseDoc, this.doc);
        if (this.editedBase === this.base) this.editedBase = null;
        if (this.editedBase) trace.codeFenceTreesCreated += countTrees(this.editedBase);
      }
    }
    this.pending = true;
    trace.heavyRenderStarts++;
  }

  work(shouldStop: () => boolean): boolean {
    if (!this.pending || this.disposed) return true;
    try {
      if (!this.highlighting) {
        if (!this.parsed) {
          this.trace.codeFenceParses++;
          this.parsed = this.parser.parseWith(
            this.nativeParser,
            this.doc,
            this.editedBase?.tree ?? null,
            shouldStop,
          );
          if (!this.parsed) return false;
          this.trace.codeFenceTreesCreated++;
        }
        this.builder ??= this.parser.startTreeBuild(
          this.parsed,
          this.doc,
          this.editedBase,
          this.nestedParsers,
        );
        let before = this.nestedParsers.size;
        let tree = this.builder.work(shouldStop);
        this.trace.codeFenceParserSessionsCreated += this.nestedParsers.size - before;
        if (!tree) return false;
        this.trace.codeFenceTreesCreated += countTrees(tree) - 1;
        this.parsed = null;
        this.builder = null;
        this.deleteTree(this.editedBase);
        this.editedBase = null;
        this.deleteTree(this.base);
        this.base = tree;
        this.baseDoc = this.doc;
        this.highlighting = tree;
      }
      while (this.highlightFrom < this.doc.length) {
        if (shouldStop()) return false;
        // Query only a bounded source window, retaining completed windows on yield.
        let to = Math.min(this.doc.length, this.highlightFrom + 8192);
        highlightTree(
          this.highlighting,
          this.highlighters,
          (from, end, className) => {
            let previous = this.spans.at(-1);
            if (previous && previous.to == from && previous.className == className)
              previous.to = end;
            else this.spans.push({ from, to: end, className });
          },
          this.highlightFrom,
          to,
        );
        this.highlightFrom = to;
      }
      this.result = {
        resultKey: hashString(JSON.stringify(this.spans)),
        source: this.source,
        spans: this.spans,
      };
      this.spans = [];
      this.highlighting = null;
      this.pending = false;
      return true;
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  cancel() {
    this.nativeParser.reset();
    let builder = this.builder;
    builder?.cancel();
    this.builder = null;
    if (this.parsed) {
      if (!builder) this.parsed.delete();
      this.trace.codeFenceTreesDeleted++;
    }
    this.parsed = null;
    this.deleteTree(this.editedBase);
    this.editedBase = null;
    this.highlighting = null;
    this.spans = [];
    this.highlightFrom = 0;
    this.pending = false;
    this.key = "";
  }

  dispose() {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.deleteTree(this.base);
    this.base = null;
    this.baseDoc = null;
    for (let parser of this.nestedParsers.values()) {
      parser.delete();
      this.trace.codeFenceParserSessionsDeleted++;
    }
    this.nestedParsers.clear();
    this.nativeParser.delete();
    this.trace.codeFenceParserSessionsDeleted++;
  }

  map(changes: ChangeDesc) {
    if (changes.touchesRange(this.range.from, this.range.to)) this.cancel();
    this.range = {
      from: changes.mapPos(this.range.from, -1),
      to: changes.mapPos(this.range.to, 1),
    };
  }

  private deleteTree(tree: Tree | null) {
    if (!tree) return;
    let count = countTrees(tree);
    tree.delete();
    this.trace.codeFenceTreesDeleted += count;
  }
}

function sourceChanges(oldDoc: Text, doc: Text) {
  let oldSource = oldDoc.toString(),
    source = doc.toString();
  let from = 0;
  let oldEnd = oldSource.length,
    end = source.length;
  while (from < oldEnd && from < end && oldSource.charCodeAt(from) == source.charCodeAt(from))
    from++;
  while (
    oldEnd > from &&
    end > from &&
    oldSource.charCodeAt(oldEnd - 1) == source.charCodeAt(end - 1)
  ) {
    oldEnd--;
    end--;
  }
  return ChangeSet.of({ from, to: oldEnd, insert: source.slice(from, end) }, oldSource.length);
}

function countTrees(tree: Tree): number {
  let count = 0;
  let pending = [tree];
  let visited = new Set<Tree>();
  while (pending.length) {
    let current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (current.tree) count++;
    for (let nested of current.nested) pending.push(nested.tree);
  }
  return count;
}
