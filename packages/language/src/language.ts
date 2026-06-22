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
  pointAfterText,
} from "./tree.js";
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

type NestedParserRanges = readonly DocRange[] | readonly (readonly DocRange[])[];

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

let parserInit: Promise<void> | null = null;
let queryCache = new WeakMap<TreeSitterParser, Map<string, TSQuery>>();

export class TreeSitterParser implements TreeConfig {
  private readonly typeCache = new Map<string, NodeType>();
  readonly styleTags: ReadonlyMap<string, readonly Tag[]>;
  readonly highlightQuery: TSQuery | null;

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
    this.highlightQuery =
      language && highlightQuerySource ? new TSQuery(language, highlightQuerySource) : null;
  }

  createParser() {
    if (!this.language) throw new RangeError("Skipping parsers can not parse directly");
    let parser = new TSParser();
    parser.setLanguage(this.language);
    return parser;
  }

  static async init(options?: Parameters<typeof TSParser.init>[0]) {
    return (parserInit ??= TSParser.init(options));
  }

  static async load(wasm: string | Uint8Array, config: TreeSitterParserConfig = {}) {
    await TreeSitterParser.init();
    return new TreeSitterParser(
      await TSLanguage.load(__testResolveWasmPath(wasm)),
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
    return new TreeSitterParser(
      this.language,
      config.props ? this.props.concat(config.props) : this.props,
      Object.fromEntries(this.styleTags.entries()) as Record<string, readonly Tag[]>,
      config.highlightQuery ?? this.highlightQuerySource,
      config.nested ? this.nestedParsers.concat(config.nested) : this.nestedParsers,
      this.skipUntil,
      config.implicitFinalNewline ?? this.implicitFinalNewline,
    ).withStyleTags(config.styleTags);
  }

  private withStyleTags(styleTags?: Record<string, Tag | readonly Tag[]>) {
    if (!styleTags) return this;
    let merged: Record<string, readonly Tag[]> = Object.fromEntries(this.styleTags.entries());
    for (let [name, value] of Object.entries(styleTags)) {
      merged[name] = value instanceof Tag ? [value] : Array.from(value);
    }
    return new TreeSitterParser(
      this.language,
      this.props,
      merged,
      this.highlightQuerySource,
      this.nestedParsers,
      this.skipUntil,
      this.implicitFinalNewline,
    );
  }

  highlightTags(tree: Tree, from: number, to: number): Map<number, readonly Tag[]> | null {
    if (!this.highlightQuery || !tree.tree) return null;
    let result = new Map<number, Tag[]>();
    let root = tree.tree.rootNode;
    let captures = this.highlightQuery
      .captures(root)
      .filter((capture) => capture.node.endIndex >= from && capture.node.startIndex <= to);
    for (let capture of captures) {
      let tags = tagsForCapture(capture.name);
      if (!tags.length) continue;
      let found = result.get(capture.node.id);
      if (found) addTags(found, tags);
      else result.set(capture.node.id, Array.from(tags));
    }
    return result;
  }

  get hasNestedParsers() {
    return this.nestedParsers.length > 0;
  }

  private get isSkippingParser() {
    return this.language == null;
  }

  private skipNestedRanges(ranges: readonly DocRange[]) {
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
    let parsed = this.parseWith(this.createParser(), doc, oldParsedTree);
    return parsed ? (this.wrapTree(parsed, doc, wrappedOldTree) ?? Tree.empty) : Tree.empty;
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
    let outer = new Tree(tree, this, doc.length);
    if (!this.nestedParsers.length) return outer;
    let nested: NestedTree[] = [];
    for (let source of this.nestedParsers) {
      for (let ranges of normalizeRangeGroups(source.ranges(outer))) {
        let parser = resolveNestedParser(source.parser, outer, ranges);
        if (!parser) continue;
        if (parser.isSkippingParser) {
          parser.skipNestedRanges(ranges);
          continue;
        }
        let oldNested =
          oldTree?.nested.find(
            (tree) =>
              tree.parser == parser &&
              tree.ranges.some((oldRange) =>
                ranges.some((range) => oldRange.from <= range.to && oldRange.to >= range.from),
              ),
          ) ?? null;
        let tsParser = nestedParsers?.get(parser);
        if (!tsParser) {
          tsParser = parser.createParser();
          nestedParsers?.set(parser, tsParser);
        }
        let parsed = parser.parseWith(
          tsParser,
          doc,
          oldNested?.tree.tree ?? null,
          shouldStop,
          ranges,
        );
        if (!parsed) return null;
        let tree = parser.wrapTree(parsed, doc, oldNested?.tree ?? null, shouldStop, nestedParsers);
        if (!tree) return null;
        nested.push({ parser, tree, ranges });
      }
    }
    return new Tree(tree, this, doc.length, nested);
  }

  editTree(tree: TSTree, changes: ChangeDesc, oldDoc: Text, newDoc: Text): TSTree {
    let edited = tree.copy();
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
  }

  editWrappedTree(tree: Tree, changes: ChangeDesc, oldDoc: Text, newDoc: Text): Tree {
    if (!tree.tree || changes.empty) return tree;
    if (this.shouldAppendFinalNewline(oldDoc) != this.shouldAppendFinalNewline(newDoc)) {
      return Tree.empty;
    }
    let nested = tree.nested
      .map((nest): NestedTree | null => {
        if (!nest.tree.tree) return null;
        let edited = (nest.parser as TreeSitterParser).editWrappedTree(
          nest.tree,
          changes,
          oldDoc,
          newDoc,
        );
        let ranges = normalizeRanges(nest.ranges.map((range) => editRange(changes, range)));
        return ranges.length ? { parser: nest.parser, tree: edited, ranges } : null;
      })
      .filter((value): value is NestedTree => value != null);
    return new Tree(this.editTree(tree.tree, changes, oldDoc, newDoc), this, newDoc.length, nested);
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
  if (!query) {
    query = new TSQuery(parser.language, source);
    parserCache.set(source, query);
  }
  return query;
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
  return query.captures(root.node, queryOptions(root, options)).map((capture, order) => ({
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
  return query.matches(root.node, queryOptions(root, options)).map((match, order) => ({
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
  let queryOptions: TSQueryOptions = {};
  if (options.from != null && options.from > root.from) queryOptions.startIndex = options.from;
  if (options.to != null && options.to < queryNodeEnd(root)) queryOptions.endIndex = options.to;
  return queryOptions;
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

export function __testResolveWasmPath(wasm: string | Uint8Array) {
  if (typeof wasm != "string") return wasm;
  if (isBrowserLike()) return wasm;
  if (wasm.startsWith("/@fs/")) return wasm.slice(4);
  let processLike = globalThis as typeof globalThis & { process?: { cwd?: () => string } };
  let cwd = processLike.process?.cwd?.();
  if (!cwd) return wasm;
  if (wasm.startsWith("/node_modules/") || wasm.startsWith("/src/")) return cwd + wasm;
  if (wasm.startsWith("/packages/") || wasm.startsWith("/apps/")) return workspaceRoot(cwd) + wasm;
  return wasm;
}

function isBrowserLike() {
  return (
    typeof globalThis.location == "object" &&
    typeof (globalThis as typeof globalThis & { document?: unknown }).document == "object"
  );
}

function workspaceRoot(cwd: string) {
  return cwd.replace(/\/(?:packages|apps)\/[^/]+$/, "");
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

function normalizeRangeGroups(ranges: NestedParserRanges): DocRange[][] {
  if (!ranges.length) return [];
  if (Array.isArray(ranges[0])) {
    return (ranges as readonly (readonly DocRange[])[])
      .map((group) => normalizeRanges(group))
      .filter((group) => group.length);
  }
  let group = normalizeRanges(ranges as readonly DocRange[]);
  return group.length ? [group] : [];
}

function resolveNestedParser(
  parser: NestedParser,
  tree: Tree,
  ranges: readonly DocRange[],
): TreeSitterParser | null {
  return typeof parser == "function" ? parser(tree, ranges) : parser;
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

  if (!transaction.docChanged) {
    return oldTree != newTree ? normalizeRanges(collectChangedRanges(oldTree, newTree)) : [];
  }

  let editedOldTree = nextLanguage.parser.editWrappedTree(
    oldTree,
    transaction.changes,
    transaction.startState.doc,
    transaction.state.doc,
  );
  return normalizeRanges(collectChangedRanges(editedOldTree, newTree));
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

class ParseContext {
  private readonly tsParser: TSParser;
  private readonly nestedTSParsers = new Map<TreeSitterParser, TSParser>();
  private oldTree: Tree | null = null;
  private pendingTree: TSTree | null = null;
  private skipped: { from: number; to: number }[] = [];
  scheduleOn: Promise<unknown> | null = null;

  private constructor(
    private parser: TreeSitterParser,
    readonly state: EditorState,
    public tree: Tree,
    public viewport: { from: number; to: number },
  ) {
    this.tsParser = parser.createParser();
  }

  static create(parser: TreeSitterParser, state: EditorState) {
    return new ParseContext(parser, state, Tree.empty, {
      from: 0,
      to: Math.min(Work.InitViewport, state.doc.length),
    });
  }

  work(timeout?: number | (() => boolean)) {
    if (this.isDone(this.state.doc.length) && this.tree != Tree.empty) return true;
    let endTime = typeof timeout == "number" ? Date.now() + timeout : 0;
    let shouldStop =
      typeof timeout == "function"
        ? timeout
        : timeout == null
          ? undefined
          : () => Date.now() >= endTime;
    return withParseContext(this, () => {
      this.skipped = [];
      let parsed =
        this.pendingTree ??
        this.parser.parseWith(
          this.tsParser,
          this.state.doc,
          this.oldTree?.tree ?? null,
          shouldStop,
        );
      if (!parsed) return false;
      this.pendingTree = parsed;
      let tree = this.parser.wrapTree(
        parsed,
        this.state.doc,
        this.oldTree,
        shouldStop,
        this.nestedTSParsers,
      );
      if (!tree) return false;
      this.tree = tree;
      this.pendingTree = null;
      this.oldTree = null;
      this.nestedTSParsers.clear();
      return true;
    });
  }

  takeTree() {
    return this.work();
  }

  changes(changes: ChangeDesc, startState: EditorState, newState: EditorState) {
    let oldTree =
      this.tree.tree && !changes.empty
        ? this.parser.editWrappedTree(this.tree, changes, startState.doc, newState.doc)
        : this.tree;
    let cx = new ParseContext(this.parser, newState, Tree.empty, {
      from: changes.mapPos(this.viewport.from, -1),
      to: changes.mapPos(this.viewport.to, 1),
    });
    cx.oldTree = oldTree;
    cx.scheduleOn = this.scheduleOn;
    cx.skipped = this.skipped
      .map((range) => ({
        from: changes.mapPos(range.from, 1),
        to: changes.mapPos(range.to, -1),
      }))
      .filter((range) => range.from < range.to);
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
    if (this.tree.tree) {
      this.oldTree = this.tree;
      this.pendingTree = this.tree.tree;
      this.tree = Tree.empty;
    }
    this.nestedTSParsers.clear();
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
    this.tree = context.tree;
  }

  apply(tr: Transaction) {
    if (!tr.docChanged)
      return this.tree == this.context.tree ? this : new LanguageState(this.context);
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
    for (let effect of tr.effects) if (effect.is(Language.setState)) return effect.value;
    if (tr.startState.facet(language) != tr.state.facet(language))
      return LanguageState.init(tr.state);
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
        field.tree != field.context.tree ||
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
          field.tree == field.context.tree &&
          field.context.isDone(this.view.viewport.to + Work.MaxParseAhead)
        ) {
          return;
        }

        let endTime = Date.now() + Math.min(this.chunkBudget, Work.Slice, idleTime(deadline));
        let done = field.context.work(() => {
          return (isInputPending?.() ?? false) || Date.now() > endTime;
        });
        this.chunkBudget -= Date.now() - now;

        if (field.tree != field.context.tree) {
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

function collectChangedRanges(oldTree: Tree, newTree: Tree): DocRange[] {
  let ranges: DocRange[] = oldTree.tree
    ? oldTree.tree
        .getChangedRanges(newTree.tree!)
        .map((range) => ({ from: range.startIndex, to: range.endIndex }))
    : [{ from: 0, to: newTree.length }];

  let matchedOldNested = new Set<NestedTree>();
  for (let newNested of newTree.nested) {
    let oldNested = oldTree.nested.find(
      (candidate) =>
        candidate.parser == newNested.parser &&
        candidate.ranges.some((oldRange) =>
          newNested.ranges.some((range) => oldRange.from <= range.to && oldRange.to >= range.from),
        ),
    );
    if (oldNested) {
      matchedOldNested.add(oldNested);
      ranges.push(...collectChangedRanges(oldNested.tree, newNested.tree));
    } else {
      ranges.push(...newNested.ranges);
    }
  }

  for (let oldNested of oldTree.nested) {
    if (!matchedOldNested.has(oldNested)) ranges.push(...oldNested.ranges);
  }
  return ranges;
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
