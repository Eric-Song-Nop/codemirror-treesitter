import {
  ChangeDesc,
  EditorState,
  type Extension,
  Facet,
  StateEffect,
  StateField,
  Text,
  type TextIterator,
  Transaction,
} from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate, logException } from "@codemirror/view";
import {
  Edit,
  Language as TSLanguage,
  Parser as TSParser,
  Query as TSQuery,
  type QueryOptions as TSQueryOptions,
  type QueryProperties as TSQueryProperties,
  type Range as TSRange,
  Tree as TSTree,
  type Node as TSNode,
  type Point,
} from "web-tree-sitter";
import {
  type DocRange,
  type NestedTree,
  NodeProp,
  type NodePropSource,
  NodeType,
  SyntaxNode,
  Tree,
  type TreeConfig,
  disposeNativeTree,
  disposeTree,
  pointAfterText,
} from "./tree.js";
import { NestedTreeMatcher, type NestedTreeMatcherStats } from "./nested-tree-matcher.js";
import { Tag, tagsForCapture } from "./tags.js";

export {
  NodeProp,
  NodeType,
  Tree,
  type DocRange,
  type NestedTree,
  type NodePropSource,
  type SyntaxNode,
  type SyntaxNodeRef,
} from "./tree.js";
export {
  Tag,
  classHighlighter,
  getStyleTags,
  styleTags,
  tagHighlighter,
  tags,
  type Highlighter,
  type StyleTags,
} from "./tags.js";

export const languageDataProp = new NodeProp<Facet<{ [name: string]: unknown }>>();

export function defineLanguageFacet(baseData?: { [name: string]: unknown }) {
  return Facet.define<{ [name: string]: unknown }>({
    combine: baseData ? (values) => values.concat(baseData) : undefined,
  });
}

export interface Sublanguage {
  type?: "replace" | "extend";
  test: (node: SyntaxNode, state: EditorState) => boolean;
  facet: Facet<{ [name: string]: unknown }>;
}

export const sublanguageProp = new NodeProp<Sublanguage[]>();

export interface TreeSitterParserConfig {
  implicitFinalNewline?: boolean;
  props?: readonly NodePropSource[];
  styleTags?: Record<string, Tag | readonly Tag[]>;
  highlightQuery?: string;
  nested?: readonly NestedParserSource[];
}

export type NestedParser =
  | TreeSitterParser
  | ((tree: Tree, ranges: readonly DocRange[]) => TreeSitterParser | null);

export type NestedParserRanges = readonly DocRange[] | Iterable<readonly DocRange[]>;

export type TreeSitterQuerySource =
  | string
  | ((parser: TreeSitterParser, tree: Tree) => null | string | undefined);

export type TreeSitterQueryCapture = {
  name: string;
  node: SyntaxNode;
  patternIndex: number;
};

export type TreeSitterQueryProperties = TSQueryProperties;

export type TreeSitterQueryMatch = {
  assertedProperties?: TreeSitterQueryProperties;
  captures: TreeSitterQueryCapture[];
  patternIndex: number;
  refutedProperties?: TreeSitterQueryProperties;
  setProperties?: TreeSitterQueryProperties;
};

export type TreeSitterQueryOptions = {
  from?: number;
  includeNested?: boolean;
  to?: number;
};

export interface NestedParserSource {
  parser: NestedParser;
  ranges: (tree: Tree) => NestedParserRanges;
}

/**
 * Maps a grammar WASM URL passed to `TreeSitterParser.load` to what
 * web-tree-sitter should load (a URL, a file path, or the bytes). The default
 * is the identity; hosts that serve assets from bundler-specific URLs (for
 * example Vite `/@fs/` paths under Node) can install their own.
 */
export type TreeSitterAssetResolver = (
  url: string,
) => string | Uint8Array | Promise<string | Uint8Array>;

export interface TreeSitterParserLoadConfig extends TreeSitterParserConfig {
  /** Per-call override of the resolver set with `TreeSitterParser.setAssetResolver`. */
  resolveAsset?: TreeSitterAssetResolver;
}

let assetResolver: TreeSitterAssetResolver | null = null;
const languageLoads = new Map<string, Promise<TSLanguage>>();

/** Load each grammar once per resolved URL; failed loads are retried on the next request. */
function loadLanguage(source: string | Uint8Array) {
  if (typeof source != "string") return TSLanguage.load(source);
  let found = languageLoads.get(source);
  if (!found) {
    found = TSLanguage.load(source);
    languageLoads.set(source, found);
    let current = found;
    void current.catch(() => {
      if (languageLoads.get(source) === current) languageLoads.delete(source);
    });
  }
  return found;
}

let parserInit: Promise<void> | null = null;
let queryCache = new WeakMap<TreeSitterParser, Map<string, TSQuery>>();
const maxCachedQueriesPerParser = 64;
const maxCachedHighlightRangesPerTree = 16;
const editedTreeOwnership = new WeakMap<Tree, Set<Tree>>();
const parserQueries = new WeakMap<TreeSitterParser, Set<TSQuery>>();
/** Owns one native query and deletes it at most once. */
class NativeQueryOwner {
  private deleted = false;

  constructor(private readonly deleteNative: () => void) {}

  dispose() {
    if (this.deleted) return;
    this.deleted = true;
    this.deleteNative();
  }
}

const managedQueryOwners = new WeakMap<TSQuery, NativeQueryOwner>();
const nativeQueryFinalizer =
  typeof FinalizationRegistry == "undefined"
    ? null
    : new FinalizationRegistry<NativeQueryOwner>((owner) => owner.dispose());

function queryResources(parser: TreeSitterParser) {
  let queries = parserQueries.get(parser);
  if (!queries) {
    queries = new Set();
    parserQueries.set(parser, queries);
  }
  return queries;
}

function createQuery(parser: TreeSitterParser, source: string) {
  let query = manageQuery(new TSQuery(parser.language!, source));
  queryResources(parser).add(query);
  return query;
}

/**
 * Return a plain `Query` facade that shares the native query address with
 * `query`. The owner keeps the original instance (so it can always delete the
 * native query), while the facade is what callers hold: when it becomes
 * unreachable the finalizer deletes the native query, and an explicit
 * `delete()` does so once and unregisters the finalizer.
 */
function manageQuery(query: TSQuery): TSQuery {
  let owner = new NativeQueryOwner(query.delete.bind(query));
  let managed = Object.assign(
    Object.create(Object.getPrototypeOf(query) as object),
    query,
  ) as TSQuery;
  Object.defineProperty(managed, "delete", {
    configurable: true,
    writable: true,
    value() {
      nativeQueryFinalizer?.unregister(managed);
      owner.dispose();
      (managed as unknown as { 0: number })[0] = 0;
    },
  });
  managedQueryOwners.set(managed, owner);
  nativeQueryFinalizer?.register(managed, owner, managed);
  return managed;
}

export function __testManagedQuery(query: TSQuery) {
  return managedQueryOwners.has(query);
}

function disposeQueries(queries: Set<TSQuery>) {
  for (let query of queries) query.delete();
  queries.clear();
}

export class TreeSitterParser implements TreeConfig {
  private readonly typeCache = new Map<string, NodeType>();
  private highlightQueryValue: TSQuery | null | undefined;
  private highlightTagCache = new WeakMap<Tree, Map<string, Map<number, readonly Tag[]>>>();
  readonly styleTags: ReadonlyMap<string, readonly Tag[]>;

  private constructor(
    readonly language: TSLanguage | null,
    readonly props: readonly NodePropSource[] = [],
    styleTags: Record<string, Tag | readonly Tag[]> = {},
    readonly highlightQuerySource: string | null = null,
    readonly nestedParsers: readonly NestedParserSource[] = [],
    private readonly skipUntil: Promise<unknown> | null = null,
    private readonly implicitFinalNewline = false,
  ) {
    this.styleTags = new Map(
      Object.entries(styleTags).map(([name, value]) => [
        name,
        value instanceof Tag ? [value] : Array.from(value),
      ]),
    );
    queryResources(this);
    this.highlightQueryValue =
      language && highlightQuerySource ? createQuery(this, highlightQuerySource) : null;
  }

  get highlightQuery() {
    if (this.highlightQueryValue === undefined) {
      this.highlightQueryValue =
        this.language && this.highlightQuerySource
          ? createQuery(this, this.highlightQuerySource)
          : null;
    }
    return this.highlightQueryValue;
  }

  createParser() {
    if (!this.language) throw new RangeError("Skipping parsers can not parse directly");
    let parser = new TSParser();
    try {
      parser.setLanguage(this.language);
      return parser;
    } catch (error) {
      parser.delete();
      throw error;
    }
  }

  static async init(options?: Parameters<typeof TSParser.init>[0]) {
    if (!parserInit) {
      let current = TSParser.init(options);
      parserInit = current;
      void current.catch(() => {
        if (parserInit === current) parserInit = null;
      });
    }
    return parserInit;
  }

  /**
   * Install the default resolver applied to string grammar URLs passed to
   * `load` (pass `null` to restore the identity resolver).
   */
  static setAssetResolver(resolver: TreeSitterAssetResolver | null) {
    assetResolver = resolver;
  }

  static async load(wasm: string | Uint8Array, config: TreeSitterParserLoadConfig = {}) {
    await TreeSitterParser.init();
    let resolve = config.resolveAsset ?? assetResolver;
    let source = typeof wasm == "string" && resolve ? await resolve(wasm) : wasm;
    return new TreeSitterParser(
      await loadLanguage(source),
      config.props,
      config.styleTags,
      config.highlightQuery ?? null,
      config.nested,
      null,
      config.implicitFinalNewline ?? false,
    );
  }

  static fromLanguage(language: TSLanguage, config: TreeSitterParserConfig = {}) {
    return new TreeSitterParser(
      language,
      config.props,
      config.styleTags,
      config.highlightQuery ?? null,
      config.nested,
      null,
      config.implicitFinalNewline ?? false,
    );
  }

  static getSkippingParser(until?: Promise<unknown>) {
    return new TreeSitterParser(null, [], {}, null, [], until ?? null);
  }

  configure(config: TreeSitterParserConfig = {}) {
    let mergedStyles: Record<string, readonly Tag[]> = Object.fromEntries(this.styleTags.entries());
    for (let [name, value] of Object.entries(config.styleTags ?? {})) {
      mergedStyles[name] = value instanceof Tag ? [value] : Array.from(value);
    }
    return new TreeSitterParser(
      this.language,
      config.props ? this.props.concat(config.props) : this.props,
      mergedStyles,
      config.highlightQuery ?? this.highlightQuerySource,
      config.nested ? this.nestedParsers.concat(config.nested) : this.nestedParsers,
      this.skipUntil,
      config.implicitFinalNewline ?? this.implicitFinalNewline,
    );
  }

  /** Delete compiled queries. They are recreated lazily when next requested. */
  clearQueryCache() {
    disposeQueries(queryResources(this));
    queryCache.delete(this);
    this.highlightTagCache = new WeakMap();
    this.highlightQueryValue = this.language && this.highlightQuerySource ? undefined : null;
  }

  /**
   * Map node ids in `tree` to the tags of their highlight-query captures
   * within `from`..`to`.
   *
   * Precedence: when several patterns capture the same node, the capture
   * from the pattern that appears last in the query wins (Neovim semantics:
   * later, more specific patterns refine earlier generic ones, which is how
   * grammar `highlights.scm` files are written). Captures from that same
   * pattern are combined. Capture names that map to no tag are ignored.
   *
   * Results are cached per tree and range.
   */
  highlightTags(tree: Tree, from: number, to: number): Map<number, readonly Tag[]> | null {
    let query = this.highlightQuery;
    if (!query || !tree.tree) return null;
    let perTree = this.highlightTagCache.get(tree);
    if (!perTree) this.highlightTagCache.set(tree, (perTree = new Map()));
    let key = `${from}:${to}`;
    let cached = perTree.get(key);
    if (cached) return cached;

    let result = new Map<number, Tag[]>();
    let winningPattern = new Map<number, number>();
    let captures = query.captures(tree.tree.rootNode, rowRangeOptions(tree, from, to));
    for (let capture of captures) {
      if (capture.node.endIndex < from || capture.node.startIndex > to) continue;
      let tags = tagsForCapture(capture.name);
      if (!tags.length) continue;
      let id = capture.node.id;
      let previous = winningPattern.get(id);
      if (previous === undefined || capture.patternIndex > previous) {
        winningPattern.set(id, capture.patternIndex);
        result.set(id, Array.from(tags));
      } else if (capture.patternIndex == previous) {
        addTags(result.get(id)!, tags);
      }
    }
    if (perTree.size >= maxCachedHighlightRangesPerTree) {
      perTree.delete(perTree.keys().next().value as string);
    }
    perTree.set(key, result);
    return result;
  }

  get hasNestedParsers() {
    return this.nestedParsers.length > 0;
  }

  get isSkippingParser() {
    return this.language == null;
  }

  skipNestedRanges(ranges: readonly DocRange[]) {
    let cx = currentContext;
    if (!cx) return;
    for (let range of ranges) cx.skipUntilInView(range.from, range.to);
    if (this.skipUntil) {
      cx.scheduleOn = cx.scheduleOn ? Promise.all([cx.scheduleOn, this.skipUntil]) : this.skipUntil;
    }
  }

  nodeType(type: string, id: number, named: boolean, top = false, error = false): NodeType {
    let key = `${id}:${type}:${top}:${error}`;
    let found = this.typeCache.get(key);
    if (!found) {
      found = new NodeType(type, id, top, error, !named, this);
      this.typeCache.set(key, found);
    }
    return found;
  }

  prop<T>(type: NodeType, prop: NodeProp<T>): T | undefined {
    let result: T | undefined;
    for (let source of this.props) {
      if (source.prop == prop) {
        let value = source.match(type) as T | undefined;
        if (value !== undefined) {
          if (result === undefined) result = value;
          else if (prop.combine) result = prop.combine(result, value);
          else return result;
        }
      }
    }
    return result;
  }

  parse(doc: Text, oldTree: TSTree | Tree | null = null): Tree {
    if (this.isSkippingParser) return Tree.empty;
    let wrappedOldTree = oldTree instanceof Tree ? oldTree : null;
    let oldParsedTree: TSTree | null = wrappedOldTree
      ? wrappedOldTree.tree
      : (oldTree as TSTree | null);
    let nativeParser = this.createParser();
    let parsed: TSTree | null = null;
    let wrapped: Tree | null = null;
    try {
      parsed = this.parseWith(nativeParser, doc, oldParsedTree);
      if (!parsed) return Tree.empty;
      wrapped = this.wrapTree(parsed, doc, wrappedOldTree);
      if (!wrapped) disposeNativeTree(parsed);
      return wrapped ?? Tree.empty;
    } catch (error) {
      if (parsed && !wrapped) disposeNativeTree(parsed);
      throw error;
    } finally {
      nativeParser.delete();
    }
  }

  parseWith(
    parser: TSParser,
    doc: Text,
    oldTree: TSTree | null = null,
    shouldStop?: () => boolean,
    includedRanges?: readonly DocRange[],
  ): TSTree | null {
    if (this.isSkippingParser) return null;
    let appendFinalNewline = this.shouldAppendFinalNewline(doc);
    return parser.parse(
      (index) => {
        if (appendFinalNewline && index == doc.length) return "\n";
        if (index >= doc.length) return undefined;
        return doc.sliceString(index, Math.min(doc.length, index + 4096));
      },
      oldTree,
      shouldStop || includedRanges
        ? {
            progressCallback: shouldStop ? () => shouldStop() : undefined,
            includedRanges: includedRanges?.map((range) => toTSRange(doc, range)),
          }
        : undefined,
    );
  }

  wrapTree(
    tree: TSTree,
    doc: Text,
    oldTree: Tree | null = null,
    shouldStop?: () => boolean,
    nestedParsers?: Map<TreeSitterParser, TSParser>,
  ): Tree | null {
    let build = new NestedTreeBuild(this, tree, doc, oldTree, nestedParsers);
    let result = build.work(shouldStop);
    if (!result) build.cancel();
    return result;
  }

  editTree(tree: TSTree, changes: ChangeDesc, oldDoc: Text, newDoc: Text): TSTree {
    let edited = tree.copy();
    try {
      changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        let startPosition = pointAt(newDoc, fromB);
        edited.edit(
          new Edit({
            startIndex: fromB,
            oldEndIndex: fromB + (toA - fromA),
            newEndIndex: toB,
            startPosition,
            oldEndPosition: pointAfterText(startPosition, oldDoc.sliceString(fromA, toA)),
            newEndPosition: pointAt(newDoc, toB),
          }),
        );
      });
      return edited;
    } catch (error) {
      disposeNativeTree(edited);
      throw error;
    }
  }

  editWrappedTree(tree: Tree, changes: ChangeDesc, oldDoc: Text, newDoc: Text): Tree {
    if (!tree.tree || changes.empty) return tree;
    if (this.shouldAppendFinalNewline(oldDoc) != this.shouldAppendFinalNewline(newDoc)) {
      return Tree.empty;
    }
    let nested: NestedTree[] = [];
    let ownedTrees = new Set<Tree>();
    let editedNativeTree: TSTree | null = null;
    try {
      for (let nest of tree.nested) {
        if (!nest.tree.tree) continue;
        let ranges = normalizeRanges(nest.ranges.map((range) => editRange(changes, range)));
        if (!ranges.length) continue;
        // Editing a native tree cannot remove an included-range component. Keep
        // the mapped ranges for matching, but force a fresh nested parse when a
        // component collapsed or merged during the edit.
        let edited =
          ranges.length == nest.ranges.length
            ? (nest.parser as TreeSitterParser).editWrappedTree(nest.tree, changes, oldDoc, newDoc)
            : Tree.empty;
        nested.push({ parser: nest.parser, tree: edited, ranges });
        let nestedOwnership = editedTreeOwnership.get(edited);
        if (nestedOwnership) for (let owned of nestedOwnership) ownedTrees.add(owned);
      }
      editedNativeTree = this.editTree(tree.tree, changes, oldDoc, newDoc);
      let editedTree = rememberTreeDoc(
        new Tree(editedNativeTree, this, newDoc.length, nested),
        newDoc,
      );
      ownedTrees.add(editedTree);
      editedTreeOwnership.set(editedTree, ownedTrees);
      return editedTree;
    } catch (error) {
      if (editedNativeTree) disposeNativeTree(editedNativeTree);
      for (let nest of nested) {
        if (editedTreeOwnership.has(nest.tree)) disposeWrappedTree(nest.tree);
      }
      throw error;
    }
  }

  private shouldAppendFinalNewline(doc: Text) {
    return this.implicitFinalNewline && doc.length > 0 && !docEndsWithLineBreak(doc);
  }
}

export function compileTreeSitterQuery(parser: TreeSitterParser, source: string): TSQuery {
  if (!parser.language) throw new RangeError("Skipping parsers can not compile queries");
  let parserCache = queryCache.get(parser);
  if (!parserCache) queryCache.set(parser, (parserCache = new Map()));
  let query = parserCache.get(source);
  if (query) {
    parserCache.delete(source);
    parserCache.set(source, query);
  }
  if (!query) {
    query = createQuery(parser, source);
    parserCache.set(source, query);
    if (parserCache.size > maxCachedQueriesPerParser) {
      let oldestSource = parserCache.keys().next().value as string;
      let evicted = parserCache.get(oldestSource)!;
      parserCache.delete(oldestSource);
      queryResources(parser).delete(evicted);
      evicted.delete();
    }
  }
  return query;
}

export function __testCachedQueryCount(parser: TreeSitterParser) {
  return queryCache.get(parser)?.size ?? 0;
}

export function queryTreeCaptures(
  tree: Tree,
  source: TreeSitterQuerySource,
  options: TreeSitterQueryOptions = {},
): TreeSitterQueryCapture[] {
  let captures: InternalQueryCapture[] = [];
  collectTreeCaptures(tree, source, options, captures);
  captures.sort(compareQueryCaptures);
  return captures.map(({ order: _order, ...capture }) => capture);
}

export function queryNodeCaptures(
  node: SyntaxNode,
  source: string,
  options: TreeSitterQueryOptions = {},
): TreeSitterQueryCapture[] {
  let parser = parserForTree(node.tree);
  if (!parser || !node.node || !source) return [];
  let captures = nodeQueryCaptures(node, parser, source, options);
  captures.sort(compareQueryCaptures);
  return captures.map(({ order: _order, ...capture }) => capture);
}

export function queryTreeMatches(
  tree: Tree,
  source: TreeSitterQuerySource,
  options: TreeSitterQueryOptions = {},
): TreeSitterQueryMatch[] {
  let matches: InternalQueryMatch[] = [];
  collectTreeMatches(tree, source, options, matches);
  matches.sort(compareQueryMatches);
  return matches.map(({ order: _order, captures, ...match }) => ({
    ...match,
    captures: captures.map(({ order: _captureOrder, ...capture }) => capture),
  }));
}

export function queryNodeMatches(
  node: SyntaxNode,
  source: string,
  options: TreeSitterQueryOptions = {},
): TreeSitterQueryMatch[] {
  let parser = parserForTree(node.tree);
  if (!parser || !node.node || !source) return [];
  let matches = nodeQueryMatches(node, parser, source, options);
  matches.sort(compareQueryMatches);
  return matches.map(({ order: _order, captures, ...match }) => ({
    ...match,
    captures: captures.map(({ order: _captureOrder, ...capture }) => capture),
  }));
}

type InternalQueryCapture = TreeSitterQueryCapture & {
  order: number;
};

type InternalQueryMatch = Omit<TreeSitterQueryMatch, "captures"> & {
  captures: InternalQueryCapture[];
  order: number;
};

function collectTreeCaptures(
  tree: Tree,
  source: TreeSitterQuerySource,
  options: TreeSitterQueryOptions,
  captures: InternalQueryCapture[],
) {
  let parser = parserForTree(tree);
  if (parser && tree.tree) {
    let querySource = typeof source == "function" ? source(parser, tree) : source;
    if (querySource) {
      captures.push(...nodeQueryCaptures(tree.topNode, parser, querySource, options));
    }
  }

  if (options.includeNested === false) return;
  for (let nest of tree.nested) {
    collectTreeCaptures(nest.tree, source, options, captures);
  }
}

function collectTreeMatches(
  tree: Tree,
  source: TreeSitterQuerySource,
  options: TreeSitterQueryOptions,
  matches: InternalQueryMatch[],
) {
  let parser = parserForTree(tree);
  if (parser && tree.tree) {
    let querySource = typeof source == "function" ? source(parser, tree) : source;
    if (querySource) {
      matches.push(...nodeQueryMatches(tree.topNode, parser, querySource, options));
    }
  }

  if (options.includeNested === false) return;
  for (let nest of tree.nested) {
    collectTreeMatches(nest.tree, source, options, matches);
  }
}

function nodeQueryCaptures(
  root: SyntaxNode,
  parser: TreeSitterParser,
  source: string,
  options: TreeSitterQueryOptions,
): InternalQueryCapture[] {
  if (!root.node || !queryRangeOverlapsNode(root, options)) return [];
  let query = compileTreeSitterQuery(parser, source);
  return query
    .captures(root.node, queryOptions(root, options))
    .filter((capture) => inQueryRange(capture.node, options))
    .map((capture, order) => ({
      name: capture.name,
      node: new SyntaxNode(root.tree, capture.node),
      order,
      patternIndex: capture.patternIndex,
    }));
}

function nodeQueryMatches(
  root: SyntaxNode,
  parser: TreeSitterParser,
  source: string,
  options: TreeSitterQueryOptions,
): InternalQueryMatch[] {
  if (!root.node || !queryRangeOverlapsNode(root, options)) return [];
  let query = compileTreeSitterQuery(parser, source);
  return query
    .matches(root.node, queryOptions(root, options))
    .filter((match) => match.captures.some((capture) => inQueryRange(capture.node, options)))
    .map((match, order) => ({
      assertedProperties: match.assertedProperties,
      captures: match.captures.map((capture, captureOrder) => ({
        name: capture.name,
        node: new SyntaxNode(root.tree, capture.node),
        order: captureOrder,
        patternIndex: capture.patternIndex,
      })),
      order,
      patternIndex: match.patternIndex,
      refutedProperties: match.refutedProperties,
      setProperties: match.setProperties,
    }));
}

function parserForTree(tree: Tree) {
  return tree.config instanceof TreeSitterParser ? tree.config : null;
}

function queryOptions(root: SyntaxNode, options: TreeSitterQueryOptions): TSQueryOptions {
  let from = options.from != null && options.from > root.from ? options.from : null;
  let to = options.to != null && options.to < queryNodeEnd(root) ? options.to : null;
  if (from == null && to == null) return {};
  return rowRangeOptions(root.tree, from ?? root.from, to ?? queryNodeEnd(root));
}

/** Whether a capture node touches the requested `from`/`to` range. */
function inQueryRange(node: TSNode, options: TreeSitterQueryOptions) {
  return (
    (options.from == null || node.endIndex >= options.from) &&
    (options.to == null || node.startIndex <= options.to)
  );
}

const treeDocs = new WeakMap<Tree, Text>();

/** Remember the document a tree was parsed or edited for, so queries can use point ranges. */
function rememberTreeDoc(tree: Tree, doc: Text) {
  treeDocs.set(tree, doc);
  return tree;
}

/**
 * Restrict a query to the rows around `from`..`to`. web-tree-sitter 0.26.9
 * mis-applies the byte-range query options (`startIndex`/`endIndex` return
 * captures from the wrong span), while point ranges work. Rows are a superset
 * of the byte range, so callers filter captures by byte offsets afterwards.
 * Without a known document the query runs unrestricted.
 */
function rowRangeOptions(tree: Tree, from: number, to: number): TSQueryOptions {
  let doc = treeDocs.get(tree);
  if (!doc || doc.length != tree.length) return {};
  let startRow = doc.lineAt(Math.max(0, Math.min(from, doc.length))).number - 1;
  let endRow = doc.lineAt(Math.max(0, Math.min(to, doc.length))).number;
  return { startPosition: { row: startRow, column: 0 }, endPosition: { row: endRow, column: 0 } };
}

function queryRangeOverlapsNode(root: SyntaxNode, options: TreeSitterQueryOptions) {
  let from = options.from ?? 0;
  let to = options.to ?? Number.POSITIVE_INFINITY;
  return from <= queryNodeEnd(root) && to >= root.from;
}

function queryNodeEnd(root: SyntaxNode) {
  return Math.min(root.to, root.tree.length);
}

function compareQueryCaptures(left: InternalQueryCapture, right: InternalQueryCapture) {
  return (
    left.node.from - right.node.from ||
    right.node.to - left.node.to ||
    left.patternIndex - right.patternIndex ||
    left.order - right.order
  );
}

function compareQueryMatches(left: InternalQueryMatch, right: InternalQueryMatch) {
  return (
    queryMatchFrom(left) - queryMatchFrom(right) ||
    queryMatchTo(right) - queryMatchTo(left) ||
    left.patternIndex - right.patternIndex ||
    left.order - right.order
  );
}

function queryMatchFrom(match: InternalQueryMatch) {
  return match.captures.reduce(
    (from, capture) => Math.min(from, capture.node.from),
    Number.POSITIVE_INFINITY,
  );
}

function queryMatchTo(match: InternalQueryMatch) {
  return match.captures.reduce((to, capture) => Math.max(to, capture.node.to), 0);
}

export function __testCreateNestedTreeMatcher(nested: readonly NestedTree[]) {
  return new NestedTreeMatcher(nested);
}

function addTags(result: Tag[], tags: readonly Tag[]) {
  for (let tag of tags) if (!result.includes(tag)) result.push(tag);
}

function pointAt(doc: Text, pos: number): Point {
  let line = doc.lineAt(pos);
  return { row: line.number - 1, column: pos - line.from };
}

function docEndsWithLineBreak(doc: Text) {
  let last = doc.sliceString(doc.length - 1, doc.length);
  return last == "\n" || last == "\r";
}

function toTSRange(doc: Text, range: DocRange): TSRange {
  return {
    startIndex: range.from,
    endIndex: range.to,
    startPosition: pointAt(doc, range.from),
    endPosition: pointAt(doc, range.to),
  };
}

function normalizeRanges(ranges: readonly DocRange[]): DocRange[] {
  let sorted = ranges
    .filter((range) => range.from < range.to)
    .map((range) => ({ from: range.from, to: range.to }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  let result: DocRange[] = [];
  for (let range of sorted) {
    let last = result[result.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else result.push(range);
  }
  return result;
}

function* normalizeRangeGroups(ranges: NestedParserRanges): Generator<DocRange[]> {
  if (Array.isArray(ranges)) {
    if (!ranges.length) return;
    if (!Array.isArray(ranges[0])) {
      let group = normalizeRanges(ranges as readonly DocRange[]);
      if (group.length) yield group;
      return;
    }
  }
  for (let rangesInGroup of ranges as Iterable<readonly DocRange[]>) {
    let group = normalizeRanges(rangesInGroup);
    if (group.length) yield group;
  }
}

function resolveNestedParser(
  parser: NestedParser,
  tree: Tree,
  ranges: readonly DocRange[],
): TreeSitterParser | null {
  return typeof parser == "function" ? parser(tree, ranges) : parser;
}

interface NestedBuildTask {
  readonly parser: TreeSitterParser;
  readonly ranges: readonly DocRange[];
  readonly oldNested: NestedTree | null;
}

interface NestedBuildFrame {
  readonly parser: TreeSitterParser;
  readonly nativeTree: TSTree;
  readonly outer: Tree;
  readonly oldMatcher: NestedTreeMatcher;
  readonly nested: NestedTree[];
  sourceIndex: number;
  source: NestedParserSource | null;
  groups: Generator<DocRange[]> | null;
  task: NestedBuildTask | null;
}

function cloneWrappedTree(root: Tree) {
  type CloneFrame = { nested: NestedTree[]; next: number; source: Tree };
  let frames: CloneFrame[] = [{ nested: [], next: 0, source: root }];
  for (;;) {
    let frame = frames[frames.length - 1]!;
    if (frame.next < frame.source.nested.length) {
      let child = frame.source.nested[frame.next++]!;
      frames.push({ nested: [], next: 0, source: child.tree });
      continue;
    }

    let cloned = new Tree(
      frame.source.tree,
      frame.source.config,
      frame.source.length,
      frame.nested,
    );
    let sourceDoc = treeDocs.get(frame.source);
    if (sourceDoc) rememberTreeDoc(cloned, sourceDoc);
    frames.pop();
    let parent = frames[frames.length - 1];
    if (!parent) return cloned;
    let sourceChild = parent.source.nested[parent.next - 1]!;
    parent.nested.push({ ...sourceChild, tree: cloned });
  }
}

class NestedTreeBuild {
  private readonly frames: NestedBuildFrame[];
  private readonly nativeParsers: Map<TreeSitterParser, TSParser>;
  private readonly ownsNativeParsers: boolean;
  private readonly ownedTrees = new Set<TSTree>();
  private readonly ownedWrappedTrees = new Set<Tree>();
  private result: Tree | null = null;
  private cancelled = false;

  constructor(
    parser: TreeSitterParser,
    nativeTree: TSTree,
    private readonly doc: Text,
    oldTree: Tree | null,
    nativeParsers?: Map<TreeSitterParser, TSParser>,
    private readonly changedRanges: ChangedRangeIndex | null = null,
  ) {
    this.ownsNativeParsers = !nativeParsers;
    this.nativeParsers = nativeParsers ?? new Map();
    this.frames = [this.createFrame(parser, nativeTree, oldTree)];
  }

  work(shouldStop?: () => boolean): Tree | null {
    if (this.result || this.cancelled) return this.result;
    try {
      while (this.frames.length) {
        let frame = this.frames[this.frames.length - 1]!;

        if (frame.parser.nestedParsers.length && !frame.oldMatcher.work(shouldStop)) return null;

        if (
          !frame.task &&
          !frame.groups &&
          frame.sourceIndex >= frame.parser.nestedParsers.length
        ) {
          let completed = rememberTreeDoc(
            new Tree(frame.nativeTree, frame.parser, this.doc.length, frame.nested),
            this.doc,
          );
          disposeTree(frame.outer);
          this.frames.pop();
          let parent = this.frames[this.frames.length - 1];
          if (!parent) {
            this.result = completed;
            this.ownedTrees.clear();
            this.ownedWrappedTrees.clear();
            if (this.ownsNativeParsers) disposeParsers(this.nativeParsers);
            return completed;
          }
          let task = parent.task!;
          parent.nested.push({ parser: task.parser, tree: completed, ranges: task.ranges });
          parent.task = null;
          continue;
        }

        if (shouldStop?.()) return null;

        if (frame.task) {
          let task = frame.task;
          let nativeParser = this.nativeParsers.get(task.parser);
          if (!nativeParser) {
            nativeParser = task.parser.createParser();
            this.nativeParsers.set(task.parser, nativeParser);
          }
          let parsed = task.parser.parseWith(
            nativeParser,
            this.doc,
            task.oldNested?.tree.tree ?? null,
            shouldStop,
            task.ranges,
          );
          if (!parsed) return null;
          this.ownedTrees.add(parsed);
          this.frames.push(this.createFrame(task.parser, parsed, task.oldNested?.tree ?? null));
          continue;
        }

        if (frame.groups) {
          let next = frame.groups.next();
          if (next.done) {
            frame.groups = null;
            frame.source = null;
            continue;
          }
          let ranges = next.value;
          let parser = resolveNestedParser(frame.source!.parser, frame.outer, ranges);
          if (!parser) continue;
          if (parser.isSkippingParser) {
            parser.skipNestedRanges(ranges);
            continue;
          }
          let oldMatch = frame.oldMatcher.match(parser, ranges);
          if (
            oldMatch?.exact &&
            oldMatch.tree.tree.tree &&
            this.changedRanges &&
            !this.changedRanges.touches(ranges)
          ) {
            let cloned = cloneWrappedTree(oldMatch.tree.tree);
            this.ownedWrappedTrees.add(cloned);
            frame.nested.push({ ...oldMatch.tree, tree: cloned });
            continue;
          }
          frame.task = {
            parser,
            ranges,
            oldNested: oldMatch?.tree ?? null,
          };
          continue;
        }

        if (frame.sourceIndex < frame.parser.nestedParsers.length) {
          let source = frame.parser.nestedParsers[frame.sourceIndex++]!;
          frame.source = source;
          frame.groups = normalizeRangeGroups(source.ranges(frame.outer));
          continue;
        }
      }
    } catch (error) {
      try {
        this.cancel();
      } catch {
        // Keep the parse/source failure as the primary error.
      }
      throw error;
    }
    return this.result;
  }

  cancel() {
    if (this.cancelled || this.result) return;
    this.cancelled = true;
    let failures: unknown[] = [];
    let attempt = (callback: () => void) => {
      try {
        callback();
      } catch (error) {
        failures.push(error);
      }
    };
    for (let frame of this.frames) {
      attempt(() => frame.groups?.return(undefined));
      attempt(() => disposeTree(frame.outer));
    }
    let active = this.frames[this.frames.length - 1]?.task;
    if (active) {
      let parser = this.nativeParsers.get(active.parser) as
        | (TSParser & { reset?: () => void })
        | undefined;
      attempt(() => parser?.reset?.());
    }
    this.frames.length = 0;
    for (let tree of this.ownedWrappedTrees) attempt(() => tree.delete());
    this.ownedWrappedTrees.clear();
    attempt(() => disposeTrees(this.ownedTrees));
    if (this.ownsNativeParsers) attempt(() => disposeParsers(this.nativeParsers));
    if (failures.length) throw failures[0];
  }

  private createFrame(
    parser: TreeSitterParser,
    nativeTree: TSTree,
    oldTree: Tree | null,
  ): NestedBuildFrame {
    return {
      parser,
      nativeTree,
      outer: rememberTreeDoc(new Tree(nativeTree, parser, this.doc.length), this.doc),
      oldMatcher: new NestedTreeMatcher(oldTree?.nested ?? [], undefined, true),
      nested: [],
      sourceIndex: 0,
      source: null,
      groups: null,
      task: null,
    };
  }
}

function disposeParsers(parsers: Map<TreeSitterParser, TSParser>) {
  for (let parser of parsers.values()) parser.delete();
  parsers.clear();
}

function disposeTrees(trees: Set<TSTree>) {
  for (let tree of trees) disposeNativeTree(tree);
  trees.clear();
}

function disposeWrappedTree(tree: Tree, retained: Tree | null = null) {
  let retainedTrees = new Set<Tree>();
  if (retained) {
    let pending = [retained];
    while (pending.length) {
      let current = pending.pop()!;
      if (retainedTrees.has(current)) continue;
      retainedTrees.add(current);
      for (let nest of current.nested) pending.push(nest.tree);
    }
  }

  let ownedTrees = editedTreeOwnership.get(tree);
  if (ownedTrees) {
    for (let owned of ownedTrees) if (!retainedTrees.has(owned)) disposeTree(owned);
    return;
  }

  let pending = [tree];
  let visited = new Set<Tree>();
  while (pending.length) {
    let current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (let nest of current.nested) pending.push(nest.tree);
    if (!retainedTrees.has(current)) disposeTree(current);
  }
}

export function __testDisposeWrappedTree(tree: Tree) {
  disposeWrappedTree(tree);
}

class ChangedRangeIndex {
  static readonly empty = new ChangedRangeIndex([]);

  private constructor(private readonly ranges: readonly DocRange[]) {}

  static fromChanges(changes: ChangeDesc) {
    let ranges: DocRange[] = [];
    changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      ranges.push({ from: fromB, to: toB });
    });
    return ranges.length ? new ChangedRangeIndex(ranges) : ChangedRangeIndex.empty;
  }

  touches(ranges: readonly DocRange[]) {
    return ranges.some((range) => this.touchesRange(range));
  }

  private touchesRange(range: DocRange) {
    let low = 0;
    let high = this.ranges.length;
    while (low < high) {
      let middle = (low + high) >> 1;
      if (this.ranges[middle]!.to < range.from) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < this.ranges.length; index++) {
      let changed = this.ranges[index]!;
      if (changed.from > range.to) break;
      if (changed.from == changed.to) {
        if (changed.from >= range.from && changed.from <= range.to) return true;
      } else if (changed.from < range.to && changed.to > range.from) {
        return true;
      }
    }
    return false;
  }
}

export function __testChangedRangesTouch(changes: ChangeDesc, ranges: readonly DocRange[]) {
  return ChangedRangeIndex.fromChanges(changes).touches(ranges);
}

function editRange(changes: ChangeDesc, range: DocRange): DocRange {
  return {
    from: changes.mapPos(range.from, 1),
    to: changes.mapPos(range.to, -1),
  };
}

export class Language {
  readonly extension: Extension;
  parser: TreeSitterParser;

  constructor(
    readonly data: Facet<{ [name: string]: unknown }>,
    parser: TreeSitterParser,
    extraExtensions: Extension[] = [],
    readonly name = "",
  ) {
    if (!Object.prototype.hasOwnProperty.call(EditorState.prototype, "tree")) {
      Object.defineProperty(EditorState.prototype, "tree", {
        get() {
          return syntaxTree(this);
        },
      });
    }

    this.parser = parser;
    this.extension = [
      language.of(this),
      EditorState.languageData.of((state, pos, side) => {
        let top = topNodeAt(state, pos, side);
        let data = top.type.prop(languageDataProp);
        if (!data) return [];
        let base = state.facet(data);
        let sub = top.type.prop(sublanguageProp);
        if (sub) {
          let innerNode = top.resolve(pos, side);
          for (let sublang of sub) {
            if (sublang.test(innerNode, state)) {
              let data = state.facet(sublang.facet);
              return sublang.type == "replace" ? data : data.concat(base);
            }
          }
        }
        return base;
      }),
      ...extraExtensions,
    ];
  }

  isActiveAt(state: EditorState, pos: number, side: -1 | 0 | 1 = -1) {
    return topNodeAt(state, pos, side).type.prop(languageDataProp) == this.data;
  }

  findRegions(state: EditorState) {
    let lang = state.facet(language);
    if (lang?.data == this.data) return [{ from: 0, to: state.doc.length }];
    if (!lang || !lang.allowsNesting) return [];
    let result: { from: number; to: number }[] = [];
    let explore = (tree: Tree) => {
      for (let nest of tree.nested) {
        if (nest.tree.topNode.type.prop(languageDataProp) == this.data) {
          result.push(...nest.ranges);
        } else {
          explore(nest.tree);
        }
      }
    };
    explore(syntaxTree(state));
    return result;
  }

  get allowsNesting() {
    return true;
  }

  static state: StateField<LanguageState>;
  static setState = StateEffect.define<LanguageState>();
}

function topNodeAt(state: EditorState, pos: number, side: -1 | 0 | 1) {
  let topLang = state.facet(language);
  let tree = syntaxTree(state);
  return (
    (topLang && topLang.allowsNesting ? tree.nestedAt(pos, side) : null)?.topNode ?? tree.topNode
  );
}

export class TreeSitterLanguage extends Language {
  private constructor(
    data: Facet<{ [name: string]: unknown }>,
    readonly parser: TreeSitterParser,
    name?: string,
  ) {
    super(data, parser, [], name);
  }

  static define(spec: {
    name?: string;
    parser: TreeSitterParser;
    languageData?: { [name: string]: unknown };
    props?: readonly NodePropSource[];
    styleTags?: Record<string, Tag | readonly Tag[]>;
    highlightQuery?: string;
    nested?: readonly NestedParserSource[];
  }) {
    let data = defineLanguageFacet(spec.languageData);
    return new TreeSitterLanguage(
      data,
      spec.parser.configure({
        props: [
          languageDataProp.add((type) => (type.isTop ? data : undefined)),
          ...(spec.props ?? []),
        ],
        styleTags: spec.styleTags,
        highlightQuery: spec.highlightQuery,
        nested: spec.nested,
      }),
      spec.name,
    );
  }

  configure(options: TreeSitterParserConfig, name?: string): TreeSitterLanguage {
    return new TreeSitterLanguage(this.data, this.parser.configure(options), name || this.name);
  }

  get allowsNesting() {
    return this.parser.hasNestedParsers;
  }
}

export const LRLanguage = TreeSitterLanguage;

const Work = {
  Apply: 20,
  MinSlice: 25,
  Slice: 100,
  MinPause: 100,
  MaxPause: 500,
  ChunkBudget: 3000,
  ChunkTime: 30000,
  ChangeBonus: 50,
  InitViewport: 3000,
  MaxParseAhead: 1e5,
} as const;

let currentContext: ParseContext | null = null;
const syntaxTreeChangedRangeCache = new WeakMap<Transaction, readonly DocRange[]>();
const syntaxTreeApplyTraceCache = new WeakMap<Transaction, SyntaxTreeApplyTrace>();

export type SyntaxTreeApplyTrace = {
  applyMs: number;
  workIterations: number;
};

export function syntaxTree(state: EditorState): Tree {
  return state.field(Language.state, false)?.tree ?? Tree.empty;
}

export function ensureSyntaxTree(state: EditorState, upto: number, timeout = 50): Tree | null {
  let parse = state.field(Language.state, false)?.context;
  if (!parse) return null;
  let oldViewport = parse.viewport;
  parse.updateViewport({ from: 0, to: upto });
  parse.work(timeout);
  let result = parse.isDone(upto) ? parse.tree : null;
  parse.updateViewport(oldViewport);
  return result;
}

export function syntaxTreeAvailable(state: EditorState, upto = state.doc.length) {
  return state.field(Language.state, false)?.context.isDone(upto) || false;
}

export function syntaxTreeChangedRanges(transaction: Transaction): readonly DocRange[] {
  let cached = syntaxTreeChangedRangeCache.get(transaction);
  if (cached) return cached;
  let ranges = computeSyntaxTreeChangedRanges(transaction);
  syntaxTreeChangedRangeCache.set(transaction, ranges);
  return ranges;
}

export function syntaxTreeApplyTrace(transaction: Transaction): SyntaxTreeApplyTrace {
  return syntaxTreeApplyTraceCache.get(transaction) ?? { applyMs: 0, workIterations: 0 };
}

function computeSyntaxTreeChangedRanges(transaction: Transaction): readonly DocRange[] {
  let startLanguage = transaction.startState.facet(language);
  let nextLanguage = transaction.state.facet(language);
  if (startLanguage != nextLanguage) return [{ from: 0, to: transaction.state.doc.length }];
  if (!nextLanguage) return [];

  let oldTree = syntaxTree(transaction.startState);
  let newTree = syntaxTree(transaction.state);
  if (!oldTree.tree || !newTree.tree) return [{ from: 0, to: transaction.state.doc.length }];

  // Fast path: the parse context already edited the old tree for this
  // transaction (and possibly diffed it against the committed tree).
  let known = transaction.state
    .field(Language.state, false)
    ?.context.changedRangesSince(oldTree, newTree, transaction.docChanged);
  if (known) return known;
  if (!canDiffTrees(oldTree, newTree)) return [{ from: 0, to: transaction.state.doc.length }];

  if (!transaction.docChanged) {
    return oldTree != newTree ? normalizeRanges(collectChangedRanges(oldTree, newTree)) : [];
  }

  let editedOldTree = nextLanguage.parser.editWrappedTree(
    oldTree,
    transaction.changes,
    transaction.startState.doc,
    transaction.state.doc,
  );
  try {
    return normalizeRanges(collectChangedRanges(editedOldTree, newTree));
  } finally {
    if (editedOldTree != oldTree) disposeWrappedTree(editedOldTree);
  }
}

function canDiffTrees(oldTree: Tree, newTree: Tree) {
  return (
    !!oldTree.tree &&
    !!newTree.tree &&
    typeof (oldTree.tree as Partial<TSTree>).getChangedRanges == "function"
  );
}

export function forceParsing(view: EditorView, upto = view.viewport.to, timeout = 100): boolean {
  let tree = ensureSyntaxTree(view.state, upto, timeout);
  if (tree && tree != syntaxTree(view.state)) view.dispatch({});
  return !!tree;
}

export function syntaxParserRunning(view: EditorView) {
  return view.plugin(parseWorker)?.isWorking() || false;
}

export class DocInput {
  private cursor: TextIterator;
  private cursorPos = 0;
  private string = "";

  constructor(readonly doc: Text) {
    this.cursor = doc.iter();
  }

  get length() {
    return this.doc.length;
  }

  private syncTo(pos: number) {
    this.string = this.cursor.next(pos - this.cursorPos).value;
    this.cursorPos = pos + this.string.length;
    return this.cursorPos - this.string.length;
  }

  chunk(pos: number) {
    this.syncTo(pos);
    return this.string;
  }

  get lineChunks() {
    return true;
  }

  read(from: number, to: number) {
    let stringStart = this.cursorPos - this.string.length;
    if (from < stringStart || to >= this.cursorPos) return this.doc.sliceString(from, to);
    return this.string.slice(from - stringStart, to - stringStart);
  }
}

type NativeParserResource = {
  deleted: boolean;
  parser: TSParser;
};

const parserLineageFinalizer =
  typeof FinalizationRegistry == "undefined"
    ? null
    : new FinalizationRegistry<NativeParserResource>((resource) => deleteParserResource(resource));

function deleteParserResource(resource: NativeParserResource) {
  if (resource.deleted) return;
  resource.deleted = true;
  let parser = resource.parser as Partial<TSParser>;
  if (typeof parser.delete == "function") parser.delete();
}

function resetNativeParser(parser: TSParser) {
  let resettable = parser as Partial<TSParser>;
  if (typeof resettable.reset == "function") resettable.reset();
}

/**
 * One native root parser shared by every ParseContext derived (through
 * `changes`) from the same `ParseContext.create` call. A halted Tree-sitter
 * parse resumes on the next `parse` call regardless of its arguments, so the
 * lineage tracks which context left partial state in the parser and resets
 * it before another context parses with it.
 */
class ParserLineage {
  private resource: NativeParserResource | null;
  private owner: ParseContext | null = null;

  constructor(private readonly config: TreeSitterParser) {
    this.resource = this.createResource();
  }

  private createResource(): NativeParserResource {
    let resource = { deleted: false, parser: this.config.createParser() };
    parserLineageFinalizer?.register(this, resource, this);
    return resource;
  }

  acquire(context: ParseContext): TSParser {
    if (!this.resource) this.resource = this.createResource();
    if (this.owner && this.owner !== context) resetNativeParser(this.resource.parser);
    this.owner = context;
    return this.resource.parser;
  }

  /** Drop the partial parse that `context` may have left in the parser. */
  release(context: ParseContext) {
    if (this.owner !== context) return;
    this.owner = null;
    if (this.resource) resetNativeParser(this.resource.parser);
  }

  /** Delete the native parser now. A later `acquire` creates a fresh one. */
  destroy() {
    this.owner = null;
    let resource = this.resource;
    if (!resource) return;
    this.resource = null;
    parserLineageFinalizer?.unregister(this);
    deleteParserResource(resource);
  }
}

type CommitBase = {
  /** Incremental base of the last commit (null for a from-scratch parse). */
  readonly tree: Tree | null;
  /** The committed tree that base was diffed against. */
  readonly committed: Tree;
  /** Whether this context may delete `tree` once the ranges are known. */
  owned: boolean;
  ranges: readonly DocRange[] | null;
  released: boolean;
};

class ParseContext {
  private readonly lineage: ParserLineage;
  private readonly nestedTSParsers = new Map<TreeSitterParser, TSParser>();
  /**
   * Incremental base for the next parse: the previous tree edited to match
   * `state.doc`. Tree-sitter cannot yield partial trees, so while a parse is
   * in flight this is also the tree published through `syntaxTree`.
   */
  private oldTree: Tree | null = null;
  private oldTreeOwned = false;
  /** Set once `oldTree` was handed to a LanguageState; it then follows GC lifetime. */
  private oldTreeExposed = false;
  /** Whether `oldTree` is a navigable tree for `state.doc` that may be published. */
  private oldTreePublishable = false;
  /** The published tree that `oldTree` was edited from. */
  private editedFrom: Tree | null = null;
  private commitBase: CommitBase | null = null;
  private pendingTree: TSTree | null = null;
  private pendingTreeOwned = false;
  private treeBuild: NestedTreeBuild | null = null;
  private changedRanges: ChangedRangeIndex | null = null;
  private skipped: { from: number; to: number }[] = [];
  private destroyed = false;
  scheduleOn: Promise<unknown> | null = null;

  private constructor(
    private parser: TreeSitterParser,
    readonly state: EditorState,
    public tree: Tree,
    public viewport: { from: number; to: number },
    lineage?: ParserLineage,
  ) {
    this.lineage = lineage ?? new ParserLineage(parser);
  }

  static create(parser: TreeSitterParser, state: EditorState) {
    return new ParseContext(parser, state, Tree.empty, {
      from: 0,
      to: Math.min(Work.InitViewport, state.doc.length),
    });
  }

  work(timeout?: number | (() => boolean)) {
    if (this.destroyed) throw new RangeError("This parse context has been destroyed");
    if (this.isDone(this.state.doc.length) && this.tree != Tree.empty) return true;
    let endTime = typeof timeout == "number" ? Date.now() + timeout : 0;
    let shouldStop =
      typeof timeout == "function"
        ? timeout
        : timeout == null
          ? undefined
          : () => Date.now() >= endTime;
    try {
      return withParseContext(this, () => {
        if (!this.pendingTree && !this.treeBuild) this.skipped = [];
        let parsed =
          this.pendingTree ??
          this.parser.parseWith(
            this.lineage.acquire(this),
            this.state.doc,
            this.oldTree?.tree ?? null,
            shouldStop,
          );
        if (!parsed) return false;
        if (!this.pendingTree) this.pendingTreeOwned = true;
        this.pendingTree = parsed;
        let tree: Tree | null;
        if (this.parser instanceof TreeSitterParser) {
          this.treeBuild ??= new NestedTreeBuild(
            this.parser,
            parsed,
            this.state.doc,
            this.oldTree,
            this.nestedTSParsers,
            this.changedRanges,
          );
          tree = this.treeBuild.work(shouldStop);
        } else {
          tree = (
            this.parser as unknown as {
              wrapTree(tree: TSTree, doc: Text): Tree | null;
            }
          ).wrapTree(parsed, this.state.doc);
        }
        if (!tree) return false;
        this.commit(tree);
        return true;
      });
    } catch (error) {
      try {
        this.cancelPendingWork();
      } catch {
        // Preserve the parse failure after attempting every cleanup path.
      }
      throw error;
    }
  }

  private commit(tree: Tree) {
    this.tree = tree;
    this.pendingTree = null;
    this.pendingTreeOwned = false;
    this.treeBuild = null;
    // Keep the incremental base until the changed ranges against it are
    // read (or the context is superseded), then delete it if it was never
    // published.
    this.releaseCommitBase();
    this.commitBase = {
      tree: this.oldTree,
      committed: tree,
      owned: this.oldTreeOwned && !this.oldTreeExposed,
      ranges: null,
      released: false,
    };
    this.oldTree = null;
    this.oldTreeOwned = false;
    this.oldTreeExposed = false;
    this.oldTreePublishable = false;
    disposeParsers(this.nestedTSParsers);
  }

  /**
   * The tree to publish through `syntaxTree`: the committed tree, or, while a
   * reparse is in flight, the previous tree edited to the current document.
   */
  publishedTree(): Tree {
    if (this.tree.tree || !this.oldTreePublishable || !this.oldTree?.tree) return this.tree;
    return this.oldTree;
  }

  /** @internal Record that `tree` (from `publishedTree`) is now visible to consumers. */
  markPublished(tree: Tree) {
    if (tree === this.oldTree) this.oldTreeExposed = true;
  }

  /**
   * @internal Changed syntax ranges between `startTree` and `newTree` when this
   * context produced `newTree` from `startTree`, or null when unknown.
   */
  changedRangesSince(
    startTree: Tree,
    newTree: Tree,
    docChanged: boolean,
  ): readonly DocRange[] | null {
    if (newTree === this.oldTree && this.oldTreePublishable) {
      // Only edited so far; the syntax is unchanged beyond the text edit.
      return (docChanged ? startTree === this.editedFrom : startTree === newTree) ? [] : null;
    }
    let base = this.commitBase;
    if (!base || base.committed !== newTree || newTree !== this.tree) return null;
    if (docChanged ? startTree !== this.editedFrom : startTree !== base.tree) return null;
    if (!base.ranges) {
      if (base.released) return null;
      base.ranges =
        base.tree && canDiffTrees(base.tree, newTree)
          ? normalizeRanges(collectChangedRanges(base.tree, newTree))
          : [{ from: 0, to: newTree.length }];
      this.releaseCommitBase();
    }
    return base.ranges;
  }

  private releaseCommitBase() {
    let base = this.commitBase;
    if (!base || base.released) return;
    base.released = true;
    if (base.owned && base.tree) disposeWrappedTree(base.tree, base.committed);
  }

  changes(changes: ChangeDesc, startState: EditorState, newState: EditorState) {
    // While a parse is in flight `tree` is empty; continue from the old tree
    // that was already edited for the previous change instead of dropping it.
    let base = this.tree.tree ? this.tree : this.oldTree?.tree ? this.oldTree : null;
    let edited =
      base && !changes.empty
        ? this.parser.editWrappedTree(base, changes, startState.doc, newState.doc)
        : (base ?? Tree.empty);
    let handedOver = !!base && edited === this.oldTree;
    let viewport = {
      from: changes.mapPos(this.viewport.from, -1),
      to: changes.mapPos(this.viewport.to, 1),
    };
    let skipped = this.skipped
      .map((range) => ({
        from: changes.mapPos(range.from, 1),
        to: changes.mapPos(range.to, -1),
      }))
      .filter((range) => range.from < range.to);
    let scheduleOn = this.scheduleOn;
    this.cancelPendingWork();
    this.releaseCommitBase();
    let cx = new ParseContext(
      this.parser,
      newState,
      Tree.empty,
      { from: viewport.from, to: viewport.to },
      this.lineage,
    );
    cx.oldTree = edited;
    cx.oldTreeOwned = handedOver ? this.oldTreeOwned : editedTreeOwnership.has(edited);
    cx.oldTreeExposed = handedOver && this.oldTreeExposed;
    cx.oldTreePublishable = this.parser instanceof TreeSitterParser && edited !== base;
    cx.editedFrom = syntaxTree(startState);
    cx.changedRanges = ChangedRangeIndex.fromChanges(changes);
    cx.scheduleOn = scheduleOn;
    cx.skipped = skipped;
    if (handedOver) {
      this.oldTree = null;
      this.oldTreeOwned = false;
      this.oldTreeExposed = false;
      this.oldTreePublishable = false;
    } else {
      this.disposeOldTree();
    }
    return cx;
  }

  updateViewport(viewport: { from: number; to: number }) {
    if (this.viewport.from == viewport.from && this.viewport.to == viewport.to) return false;
    this.viewport = viewport;
    let startSkipped = this.skipped.length;
    this.skipped = this.skipped.filter((range) => {
      let visible = range.from < viewport.to && range.to > viewport.from;
      return !visible;
    });
    if (this.skipped.length == startSkipped) return false;
    this.reset();
    return true;
  }

  reset() {
    let failure: unknown;
    try {
      this.cancelPendingWork();
    } catch (error) {
      failure = error;
    }
    this.skipped = [];
    this.changedRanges = null;
    if (this.tree.tree) {
      this.oldTree = this.tree;
      this.oldTreeOwned = false;
      this.oldTreeExposed = true;
      this.oldTreePublishable = true;
      this.pendingTree = this.tree.tree;
      this.pendingTreeOwned = false;
      this.tree = Tree.empty;
    }
    if (failure !== undefined) throw failure;
  }

  /** @internal */
  cancelPendingWork() {
    let build = this.treeBuild;
    this.treeBuild = null;
    let failures: unknown[] = [];
    let attempt = (callback: () => void) => {
      try {
        callback();
      } catch (error) {
        failures.push(error);
      }
    };
    attempt(() => build?.cancel());
    attempt(() => disposeParsers(this.nestedTSParsers));
    attempt(() => this.lineage.release(this));
    if (this.pendingTreeOwned && this.pendingTree) {
      attempt(() => disposeNativeTree(this.pendingTree!));
    }
    this.pendingTree = null;
    this.pendingTreeOwned = false;
    if (failures.length) throw failures[0];
  }

  /**
   * @internal Cancel pending work and delete the lineage's native parser now
   * (used on language switch and view destroy). The context stays usable; a
   * later parse lazily creates a new native parser.
   */
  releaseParser() {
    try {
      this.cancelPendingWork();
    } finally {
      this.lineage.destroy();
    }
  }

  destroy() {
    if (this.destroyed) return;
    let failures: unknown[] = [];
    let attempt = (callback: () => void) => {
      try {
        callback();
      } catch (error) {
        failures.push(error);
      }
    };
    attempt(() => this.cancelPendingWork());
    attempt(() => this.disposeOldTree());
    attempt(() => this.releaseCommitBase());
    this.destroyed = true;
    attempt(() => this.lineage.destroy());
    if (failures.length) throw failures[0];
  }

  private disposeOldTree() {
    if (this.oldTreeOwned && this.oldTree && !this.oldTreeExposed) {
      disposeWrappedTree(this.oldTree);
    }
    this.oldTree = null;
    this.oldTreeOwned = false;
    this.oldTreeExposed = false;
    this.oldTreePublishable = false;
  }

  skipUntilInView(from: number, to: number) {
    if (from < to) this.skipped.push({ from, to });
  }

  isDone(upto: number) {
    let parsedTo = Math.min(upto, this.state.doc.length);
    return (
      this.tree.length >= parsedTo &&
      !this.skipped.some((range) => range.from < parsedTo && range.to > 0)
    );
  }

  static get() {
    return currentContext;
  }

  static getSkippingParser(until?: Promise<unknown>) {
    return TreeSitterParser.getSkippingParser(until);
  }
}

function withParseContext<T>(context: ParseContext, callback: () => T): T {
  let previous = currentContext;
  currentContext = context;
  try {
    return callback();
  } finally {
    currentContext = previous;
  }
}

function now() {
  return typeof performance == "undefined" ? Date.now() : performance.now();
}

class LanguageState {
  readonly tree: Tree;

  constructor(readonly context: ParseContext) {
    this.tree = context.publishedTree();
    context.markPublished(this.tree);
  }

  apply(tr: Transaction) {
    if (!tr.docChanged)
      return this.tree == this.context.publishedTree() ? this : new LanguageState(this.context);
    let context = this.context.changes(tr.changes, tr.startState, tr.state);
    let start = now();
    context.work(Work.Apply);
    syntaxTreeApplyTraceCache.set(tr, {
      applyMs: now() - start,
      workIterations: 1,
    });
    return new LanguageState(context);
  }

  static init(state: EditorState) {
    let context = ParseContext.create(state.facet(language)!.parser, state);
    context.work(Work.Apply);
    return new LanguageState(context);
  }
}

Language.state = StateField.define<LanguageState>({
  create: (state) => LanguageState.init(state),
  update(value, tr) {
    for (let effect of tr.effects) {
      if (effect.is(Language.setState)) return effect.value;
    }
    if (tr.startState.facet(language) != tr.state.facet(language)) {
      value.context.releaseParser();
      return LanguageState.init(tr.state);
    }
    return value.apply(tr);
  },
});

let requestIdle = (callback: (deadline?: IdleDeadline) => void) => {
  let timeout = setTimeout(() => callback(), Work.MaxPause);
  return () => clearTimeout(timeout);
};

if (typeof requestIdleCallback != "undefined") {
  requestIdle = (callback: (deadline?: IdleDeadline) => void) => {
    let idle = -1;
    let timeout = setTimeout(() => {
      idle = requestIdleCallback(callback, { timeout: Work.MaxPause - Work.MinPause });
    }, Work.MinPause);
    return () => (idle < 0 ? clearTimeout(timeout) : cancelIdleCallback(idle));
  };
}

const isInputPending =
  typeof navigator != "undefined" &&
  (
    navigator as Navigator & {
      scheduling?: { isInputPending?: () => boolean };
    }
  ).scheduling?.isInputPending
    ? () =>
        (
          navigator as Navigator & {
            scheduling: { isInputPending: () => boolean };
          }
        ).scheduling.isInputPending()
    : null;

const parseWorker = ViewPlugin.fromClass(
  class ParseWorker {
    private working: (() => void) | null = null;
    private scheduled = 0;
    private chunkEnd = -1;
    private chunkBudget = -1;

    constructor(readonly view: EditorView) {
      this.scheduleWork();
    }

    update(update: ViewUpdate) {
      let field = this.view.state.field(Language.state, false);
      if (field?.context.updateViewport(update.view.viewport)) this.scheduleWork();
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        if (update.docChanged && this.view.hasFocus) this.chunkBudget += Work.ChangeBonus;
        this.scheduleWork();
      }
      if (field) this.checkAsyncSchedule(field.context);
    }

    scheduleWork() {
      if (this.working) return;
      let field = this.view.state.field(Language.state, false);
      if (!field) return;
      if (
        field.tree != field.context.publishedTree() ||
        !field.context.isDone(this.view.viewport.to + Work.MaxParseAhead)
      ) {
        this.working = requestIdle((deadline) => this.work(deadline));
      }
    }

    work(deadline?: IdleDeadline) {
      this.working = null;
      try {
        let now = Date.now();
        if (this.chunkEnd < now && (this.chunkEnd < 0 || this.view.hasFocus)) {
          this.chunkEnd = now + Work.ChunkTime;
          this.chunkBudget = Work.ChunkBudget;
        }
        if (this.chunkBudget <= 0) return;

        let field = this.view.state.field(Language.state, false);
        if (!field) return;
        if (
          field.tree == field.context.publishedTree() &&
          field.context.isDone(this.view.viewport.to + Work.MaxParseAhead)
        ) {
          return;
        }

        let endTime = Date.now() + Math.min(this.chunkBudget, Work.Slice, idleTime(deadline));
        let done = field.context.work(() => {
          return (isInputPending?.() ?? false) || Date.now() > endTime;
        });
        this.chunkBudget -= Date.now() - now;

        if (field.tree != field.context.publishedTree()) {
          this.view.dispatch({ effects: Language.setState.of(new LanguageState(field.context)) });
        }
        this.checkAsyncSchedule(field.context);
        if (!done && this.chunkBudget > 0) this.scheduleWork();
      } catch (error) {
        logException(this.view.state, error);
      }
    }

    destroy() {
      if (this.working) this.working();
      try {
        this.view.state.field(Language.state, false)?.context.releaseParser();
      } catch (error) {
        logException(this.view.state, error);
      }
    }

    isWorking() {
      return !!this.working || this.scheduled > 0;
    }

    checkAsyncSchedule(cx: ParseContext) {
      if (!cx.scheduleOn) return;
      let scheduleOn = cx.scheduleOn;
      cx.scheduleOn = null;
      this.scheduled++;
      scheduleOn
        .then(() => {
          cx.reset();
          this.scheduleWork();
        })
        .catch((error) => logException(this.view.state, error))
        .finally(() => this.scheduled--);
    }
  },
  {
    eventHandlers: {
      focus() {
        this.scheduleWork();
      },
    },
  },
);

function idleTime(deadline?: IdleDeadline) {
  return deadline && !isInputPending ? Math.max(Work.MinSlice, deadline.timeRemaining() - 5) : 1e9;
}

function collectChangedRanges(
  oldTree: Tree,
  newTree: Tree,
  matcherStats?: NestedTreeMatcherStats,
): DocRange[] {
  let ranges: DocRange[] = canDiffTrees(oldTree, newTree)
    ? oldTree
        .tree!.getChangedRanges(newTree.tree!)
        .map((range) => ({ from: range.startIndex, to: range.endIndex }))
    : [{ from: 0, to: newTree.length }];

  let matcher = new NestedTreeMatcher(oldTree.nested, matcherStats);
  for (let newNested of newTree.nested) {
    let oldNested = matcher.takeExact(newNested.parser, newNested.ranges);
    if (oldNested) {
      ranges.push(...collectChangedRanges(oldNested.tree, newNested.tree, matcherStats));
    } else {
      ranges.push(...newNested.ranges);
    }
  }

  for (let oldNested of matcher.remaining()) ranges.push(...oldNested.ranges);
  return ranges;
}

export function __testCollectChangedRanges(
  oldTree: Tree,
  newTree: Tree,
  matcherStats?: NestedTreeMatcherStats,
) {
  return collectChangedRanges(oldTree, newTree, matcherStats);
}

export const language = Facet.define<Language, Language | null>({
  combine(languages) {
    return languages.length ? languages[0]! : null;
  },
  enables: (language) => [
    Language.state,
    parseWorker,
    EditorView.contentAttributes.compute([language], (state): Record<string, string> => {
      let lang = state.facet(language);
      return lang && lang.name ? { "data-language": lang.name } : {};
    }),
  ],
});

export class LanguageSupport {
  extension: Extension;

  constructor(
    readonly language: Language,
    readonly support: Extension = [],
  ) {
    this.extension = [language.extension, support];
  }
}

export class LanguageDescription {
  private loading: Promise<LanguageSupport> | null = null;

  private constructor(
    readonly name: string,
    readonly alias: readonly string[],
    readonly extensions: readonly string[],
    readonly filename: RegExp | undefined,
    private loadFunc: () => Promise<LanguageSupport>,
    public support?: LanguageSupport,
  ) {}

  load(): Promise<LanguageSupport> {
    return (
      this.loading ||
      (this.loading = this.loadFunc().then(
        (support) => (this.support = support),
        (error) => {
          this.loading = null;
          throw error;
        },
      ))
    );
  }

  static of(spec: {
    name: string;
    alias?: readonly string[];
    extensions?: readonly string[];
    filename?: RegExp;
    load?: () => Promise<LanguageSupport>;
    support?: LanguageSupport;
  }) {
    let { load, support } = spec;
    if (!load) {
      if (!support)
        throw new RangeError("Must pass either 'load' or 'support' to LanguageDescription.of");
      load = () => Promise.resolve(support);
    }
    return new LanguageDescription(
      spec.name,
      (spec.alias || []).concat(spec.name).map((name) => name.toLowerCase()),
      spec.extensions || [],
      spec.filename,
      load,
      support,
    );
  }

  static matchFilename(descs: readonly LanguageDescription[], filename: string) {
    for (let desc of descs) if (desc.filename && desc.filename.test(filename)) return desc;
    let ext = /\.([^.]+)$/.exec(filename);
    if (ext) for (let desc of descs) if (desc.extensions.includes(ext[1]!)) return desc;
    return null;
  }

  static matchLanguageName(descs: readonly LanguageDescription[], name: string, fuzzy = true) {
    name = name.toLowerCase();
    for (let desc of descs) if (desc.alias.some((alias) => alias == name)) return desc;
    if (fuzzy) {
      for (let desc of descs)
        for (let alias of desc.alias) {
          let found = name.indexOf(alias);
          if (
            found > -1 &&
            (alias.length > 2 ||
              (!/\w/.test(name[found - 1] || "") && !/\w/.test(name[found + alias.length] || "")))
          )
            return desc;
        }
    }
    return null;
  }
}

export { ParseContext };
