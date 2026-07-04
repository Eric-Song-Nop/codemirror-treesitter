import type {
  Node as TSNode,
  Point,
  Tree as TSTree,
  TreeCursor as TSTreeCursor,
} from "@codemirror-treesitter/web-tree-sitter";
import type { Tag } from "./tags.js";

type PropMatcher<T> = (type: NodeType) => T | undefined;

export interface NodePropSource<T = any> {
  prop: NodeProp<T>;
  match: PropMatcher<T>;
}

export interface NodePropConfig<T> {
  deserialize?: (str: string) => T;
  combine?: (a: T, b: T) => T;
  perNode?: boolean;
}

export class NodeProp<T> {
  static openedBy = new NodeProp<readonly string[]>();
  static closedBy = new NodeProp<readonly string[]>();
  static group = new NodeProp<readonly string[]>();
  static isolate = new NodeProp<"rtl" | "ltr" | "auto">();
  static contextHash = new NodeProp<number>({ perNode: true });
  static lookAhead = new NodeProp<number>({ perNode: true });
  static mounted = new NodeProp<unknown>({ perNode: true });

  readonly perNode: boolean;
  readonly deserialize: (str: string) => T;
  readonly combine?: (a: T, b: T) => T;

  constructor(config: NodePropConfig<T> = {}) {
    this.perNode = !!config.perNode;
    this.deserialize =
      config.deserialize ??
      (() => {
        throw new RangeError("This node prop does not define a deserialize function");
      });
    this.combine = config.combine;
  }

  add(match: Record<string, T> | PropMatcher<T>): NodePropSource<T> {
    if (typeof match == "function") return { prop: this, match };
    let values = Object.create(null) as Record<string, T>;
    for (let selector of Object.keys(match)) {
      for (let name of selector.split(/\s+/)) if (name) values[name] = match[selector]!;
    }
    return { prop: this, match: (type) => values[type.name] };
  }
}

const openToClose: Record<string, readonly string[]> = {
  "(": [")"],
  "[": ["]"],
  "{": ["}"],
  "<": [">"],
};

const closeToOpen: Record<string, readonly string[]> = {
  ")": ["("],
  "]": ["["],
  "}": ["{"],
  ">": ["<"],
};

export interface TreeConfig {
  nodeType(type: string, id: number, named: boolean, top?: boolean, error?: boolean): NodeType;
  prop<T>(type: NodeType, prop: NodeProp<T>): T | undefined;
  highlightTags?(tree: Tree, from: number, to: number): Map<number, readonly Tag[]> | null;
}

export class NodeType {
  static none = new NodeType("", 0, false, false, false, null);

  constructor(
    readonly name: string,
    readonly id: number,
    readonly isTop: boolean,
    readonly isError: boolean,
    readonly isSkipped: boolean,
    private readonly config: TreeConfig | null,
    private readonly props: readonly [NodeProp<any>, any][] = [],
  ) {}

  static define(spec: {
    id: number;
    name?: string;
    props?: readonly ([NodeProp<any>, any] | NodePropSource<any>)[];
    top?: boolean;
    error?: boolean;
    skipped?: boolean;
  }) {
    let node = new NodeType(
      spec.name ?? "",
      spec.id,
      !!spec.top,
      !!spec.error,
      !!spec.skipped,
      null,
    );
    let props: [NodeProp<any>, any][] = [];
    for (let source of spec.props ?? []) {
      if (Array.isArray(source)) props.push(source);
      else {
        let value = source.match(node);
        if (value !== undefined) props.push([source.prop, value]);
      }
    }
    return props.length
      ? new NodeType(node.name, node.id, node.isTop, node.isError, node.isSkipped, null, props)
      : node;
  }

  static match<T>(map: Record<string, T>): (node: NodeType) => T | undefined {
    let entries: [string, T][] = [];
    for (let selector of Object.keys(map)) {
      for (let name of selector.split(/\s+/)) if (name) entries.push([name, map[selector]!]);
    }
    return (node) => entries.find(([name]) => node.is(name))?.[1];
  }

  prop<T>(prop: NodeProp<T>): T | undefined {
    if (this.config) {
      let configured = this.config.prop(this, prop);
      if (configured !== undefined) return configured;
    }
    for (let [storedProp, value] of this.props) {
      if (storedProp == prop) return value as T;
    }
    let genericProp = prop as NodeProp<any>;
    if (genericProp == NodeProp.closedBy) return openToClose[this.name] as T | undefined;
    if (genericProp == NodeProp.openedBy) return closeToOpen[this.name] as T | undefined;
    return undefined;
  }

  get isAnonymous() {
    return this.isSkipped;
  }

  is(type: string | number | NodeType): boolean {
    return typeof type == "number"
      ? this.id == type
      : typeof type == "string"
        ? type
            .split(/\s+/)
            .some((name) => name == this.name || !!this.prop(NodeProp.group)?.includes(name))
        : this.id == type.id && this.name == type.name;
  }
}

const emptyType = new NodeType("Document", 0, true, false, false, null);
type NodeSelector = string | number | NodeType;

export interface NodeIterator {
  node: SyntaxNode;
  next: NodeIterator | null;
}

export interface DocRange {
  from: number;
  to: number;
}

export interface NestedTree {
  parser: TreeConfig;
  tree: Tree;
  ranges: readonly DocRange[];
}

export interface IterateSpec {
  from?: number;
  to?: number;
  enter?: (node: SyntaxNode) => false | void;
  leave?: (node: SyntaxNode) => void;
}

type NativeTreeResource = {
  deleted: boolean;
  references: number;
  tree: TSTree;
};

const nativeTreeResources = new WeakMap<TSTree, NativeTreeResource>();
const wrappedTreeResources = new WeakMap<Tree, NativeTreeResource>();
const disposedWrappedTrees = new WeakSet<Tree>();
const nativeTreeFinalizer =
  typeof FinalizationRegistry == "undefined"
    ? null
    : new FinalizationRegistry<NativeTreeResource>((resource) => releaseNativeTree(resource));

function retainNativeTree(owner: Tree, tree: TSTree) {
  if (typeof tree.delete != "function") return;
  let resource = nativeTreeResources.get(tree);
  if (!resource) {
    resource = { deleted: false, references: 0, tree };
    nativeTreeResources.set(tree, resource);
  }
  resource.references++;
  wrappedTreeResources.set(owner, resource);
  nativeTreeFinalizer?.register(owner, resource, owner);
}

function releaseNativeTree(resource: NativeTreeResource) {
  resource.references--;
  if (!resource.references && !resource.deleted) {
    resource.deleted = true;
    resource.tree.delete();
  }
}

/** @internal Release one wrapped-tree reference. */
export function disposeTree(tree: Tree) {
  if (disposedWrappedTrees.has(tree)) return;
  disposedWrappedTrees.add(tree);
  nativeTreeFinalizer?.unregister(tree);
  let resource = wrappedTreeResources.get(tree);
  if (resource) releaseNativeTree(resource);
}

function disposeTreeGraph(tree: Tree) {
  let pending = [tree];
  let visited = new Set<Tree>();
  while (pending.length) {
    let current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (let nested of current.nested) pending.push(nested.tree);
    disposeTree(current);
  }
}

/** @internal Force-release an unpublished native tree. */
export function disposeNativeTree(tree: TSTree) {
  if (typeof tree.delete != "function") return;
  let resource = nativeTreeResources.get(tree);
  if (resource) {
    if (!resource.deleted) {
      resource.deleted = true;
      tree.delete();
    }
  } else {
    tree.delete();
  }
}

export class Tree {
  static empty = new Tree(null, null, 0);
  readonly rootNodeId: number | null;

  constructor(
    readonly tree: TSTree | null,
    readonly config: TreeConfig | null,
    readonly length: number,
    readonly nested: readonly NestedTree[] = [],
  ) {
    if (tree) retainNativeTree(this, tree);
    this.rootNodeId = tree?.rootNode?.id ?? null;
  }

  get type() {
    return this.topNode.type;
  }

  get topNode() {
    return this.tree ? new SyntaxNode(this, this.tree.rootNode) : SyntaxNode.empty(this);
  }

  get rootNode() {
    return this.topNode;
  }

  cursor() {
    return this.topNode.cursor();
  }

  cursorAt(pos: number, side: -1 | 0 | 1 = 0) {
    let cursor = this.cursor();
    if (cursor) {
      try {
        cursor.moveTo(pos, side);
      } catch (error) {
        cursor.delete();
        throw error;
      }
    }
    return cursor;
  }

  /** Release this tree graph's native references. Calling this twice is safe. */
  delete() {
    disposeTreeGraph(this);
  }

  resolve(pos: number, side: -1 | 0 | 1 = 0) {
    return this.topNode.resolve(pos, side);
  }

  resolveInner(pos: number, side: -1 | 0 | 1 = 0): SyntaxNode {
    let nested = this.nestedAt(pos, side);
    if (nested) return nested.resolveInner(pos, side);
    return this.topNode.resolve(pos, side);
  }

  nestedAt(pos: number, side: -1 | 0 | 1 = 0): Tree | null {
    let found = this.directNestedAt(pos, side);
    return found ? (found.nestedAt(pos, side) ?? found) : null;
  }

  private directNestedAt(pos: number, side: -1 | 0 | 1 = 0): Tree | null {
    let found: Tree | null = null;
    for (let nest of this.nested) {
      if (nest.ranges.some((range) => rangeContains(range, pos, side))) {
        found = nest.tree;
      }
    }
    return found;
  }

  resolveStack(pos: number, side: -1 | 0 | 1 = 0): NodeIterator {
    let outer = stackFor(this.topNode.resolve(pos, side));
    let nested = this.directNestedAt(pos, side);
    return nested ? appendStack(nested.resolveStack(pos, side), outer) : outer;
  }

  iterate(spec: IterateSpec) {
    let from = spec.from ?? 0;
    let to = spec.to ?? this.length;
    let nestedRanges = this.nested
      .flatMap((nest, nestIndex) =>
        nest.ranges.map((range, rangeIndex) => ({ nest, nestIndex, range, rangeIndex })),
      )
      .filter(({ range }) => range.to >= from && range.from <= to)
      .sort((a, b) => nestedStart(a) - nestedStart(b));
    let emitted = new Set<string>();
    let emitNested = (entry: (typeof nestedRanges)[number]) => {
      let key = `${entry.nestIndex}:${entry.rangeIndex}`;
      if (emitted.has(key)) return;
      emitted.add(key);
      let rangeFrom = Math.max(from, entry.range.from);
      let rangeTo = Math.min(to, entry.range.to);
      if (rangeFrom > rangeTo) return;
      entry.nest.tree.iterate({ ...spec, from: rangeFrom, to: rangeTo });
    };
    let emitNestedIn = (from: number, to: number, includeTo = true) => {
      for (let entry of nestedRanges) {
        let start = nestedStart(entry);
        if (start >= from && (includeTo ? start <= to : start < to)) emitNested(entry);
      }
    };
    let cursor = this.cursor();
    if (cursor) {
      try {
        iterateTreeCursor(cursor, from, to, spec, emitNestedIn);
      } finally {
        cursor.delete();
      }
    } else {
      let node = this.topNode;
      if (node.to >= from && node.from <= to && spec.enter?.(node) !== false) spec.leave?.(node);
    }
    for (let entry of nestedRanges) emitNested(entry);
  }

  prop<T>(prop: NodeProp<T>): T | undefined {
    return this.type.prop(prop);
  }

  toString() {
    return this.topNode.toString();
  }
}

function enterFirstIteratedCursorChild(cursor: TreeCursor, from: number, to: number): boolean {
  let index = cursorSearchIndex(cursor, from, -1);
  if (!cursor.firstChildForIndex(index)) return false;
  while (cursor.to < from) {
    if (!cursor.nextSibling()) {
      cursor.parent();
      return false;
    }
  }
  if (cursor.from > to) {
    cursor.parent();
    return false;
  }
  return true;
}

type TreeIterationFrame = {
  childrenStarted: boolean;
  node: SyntaxNode;
  pos: number;
};

function iterateTreeCursor(
  cursor: TreeCursor,
  from: number,
  to: number,
  spec: IterateSpec,
  emitNestedIn: (from: number, to: number, includeTo?: boolean) => void,
) {
  let frames: TreeIterationFrame[] = [];
  let enterCurrent = () => {
    let node = cursor.node;
    if (node.to < from || node.from > to || spec.enter?.(node) === false) return false;
    frames.push({ childrenStarted: false, node, pos: node.from });
    return true;
  };
  let advanceAfterChild = (parent: TreeIterationFrame) => {
    for (;;) {
      emitNestedIn(cursor.from, cursor.to, false);
      parent.pos = cursor.to;
      if (!cursor.nextSibling() || cursor.from > to) {
        cursor.parent();
        return false;
      }
      emitNestedIn(parent.pos, Math.min(cursor.from, parent.node.to), false);
      if (enterCurrent()) return true;
    }
  };

  if (!enterCurrent()) return;
  while (frames.length) {
    let frame = frames.at(-1)!;
    if (!frame.childrenStarted) {
      frame.childrenStarted = true;
      if (enterFirstIteratedCursorChild(cursor, from, to)) {
        emitNestedIn(frame.pos, Math.min(cursor.from, frame.node.to), false);
        if (enterCurrent() || advanceAfterChild(frame)) continue;
      }
    }

    emitNestedIn(frame.pos, frame.node.to, false);
    spec.leave?.(frame.node);
    frames.pop();
    let parent = frames.at(-1);
    if (parent && advanceAfterChild(parent)) continue;
  }
}

function nestedStart(nest: NestedTree | { range: DocRange }) {
  return "range" in nest ? nest.range.from : (nest.ranges[0]?.from ?? 0);
}

function rangeContains(range: DocRange, pos: number, side: -1 | 0 | 1) {
  return pos > range.from && pos < range.to
    ? true
    : pos == range.from
      ? side >= 0
      : pos == range.to && side <= 0;
}

function cursorSearchIndex(range: DocRange, pos: number, side: -1 | 0 | 1) {
  let index = side < 0 && pos > range.from ? pos - 1 : pos;
  if (index >= range.to && range.to > range.from) index = range.to - 1;
  if (index < range.from) index = range.from;
  return index;
}

function stackFor(node: SyntaxNode): NodeIterator {
  let nodes: SyntaxNode[] = [];
  for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) nodes.push(cur);
  return stackFromNodes(nodes);
}

function appendStack(first: NodeIterator, second: NodeIterator): NodeIterator {
  let nodes: SyntaxNode[] = [];
  for (let cur: NodeIterator | null = first; cur; cur = cur.next) nodes.push(cur.node);
  for (let cur: NodeIterator | null = second; cur; cur = cur.next) nodes.push(cur.node);
  return stackFromNodes(nodes);
}

function stackFromNodes(nodes: readonly SyntaxNode[]): NodeIterator {
  let result: NodeIterator | null = null;
  for (let i = nodes.length - 1; i >= 0; i--) result = { node: nodes[i]!, next: result };
  return result!;
}

export class SyntaxNode {
  static empty(tree: Tree) {
    return new SyntaxNode(tree, null);
  }

  constructor(
    readonly tree: Tree,
    readonly node: TSNode | null,
  ) {}

  get type(): NodeType {
    if (!this.node || !this.tree.config) return emptyType;
    return this.tree.config.nodeType(
      this.node.type,
      this.node.typeId,
      this.node.isNamed,
      this.tree.rootNodeId == null
        ? this.node.parent == null
        : this.node.id == this.tree.rootNodeId,
      this.node.isError || this.node.isMissing,
    );
  }

  get name() {
    return this.type.name;
  }

  get from() {
    return this.node?.startIndex ?? 0;
  }

  get to() {
    return this.node?.endIndex ?? 0;
  }

  get parent(): SyntaxNode | null {
    return this.node?.parent ? new SyntaxNode(this.tree, this.node.parent) : null;
  }

  get id() {
    return this.node?.id ?? 0;
  }

  get typeId() {
    return this.node?.typeId ?? 0;
  }

  get grammarId() {
    return this.node?.grammarId ?? 0;
  }

  get grammarType() {
    return this.node?.grammarType ?? this.name;
  }

  get isNamed() {
    return this.node?.isNamed ?? true;
  }

  get isExtra() {
    return this.node?.isExtra ?? false;
  }

  get isMissing() {
    return this.node?.isMissing ?? false;
  }

  get hasChanges() {
    return this.node?.hasChanges ?? false;
  }

  get hasError() {
    return this.node?.hasError ?? this.isError;
  }

  get childCount() {
    return this.node?.childCount ?? 0;
  }

  get namedChildCount() {
    return this.node?.namedChildCount ?? 0;
  }

  get descendantCount() {
    return this.node?.descendantCount ?? 0;
  }

  get startPosition() {
    return this.node?.startPosition ?? { row: 0, column: 0 };
  }

  get endPosition() {
    return this.node?.endPosition ?? { row: 0, column: 0 };
  }

  get fieldName(): string | null {
    if (!this.node?.parent) return null;
    let index = this.node.parent.children.findIndex((child) => child.id == this.node!.id);
    return index < 0 ? null : this.node.parent.fieldNameForChild(index);
  }

  get firstChild(): SyntaxNode | null {
    return this.node?.firstChild ? new SyntaxNode(this.tree, this.node.firstChild) : null;
  }

  get firstNamedChild(): SyntaxNode | null {
    return this.node?.firstNamedChild ? new SyntaxNode(this.tree, this.node.firstNamedChild) : null;
  }

  get lastChild(): SyntaxNode | null {
    return this.node?.lastChild ? new SyntaxNode(this.tree, this.node.lastChild) : null;
  }

  get lastNamedChild(): SyntaxNode | null {
    return this.node?.lastNamedChild ? new SyntaxNode(this.tree, this.node.lastNamedChild) : null;
  }

  get nextSibling(): SyntaxNode | null {
    return this.node?.nextSibling ? new SyntaxNode(this.tree, this.node.nextSibling) : null;
  }

  get nextNamedSibling(): SyntaxNode | null {
    return this.node?.nextNamedSibling
      ? new SyntaxNode(this.tree, this.node.nextNamedSibling)
      : null;
  }

  get previousSibling(): SyntaxNode | null {
    return this.node?.previousSibling ? new SyntaxNode(this.tree, this.node.previousSibling) : null;
  }

  get prevSibling(): SyntaxNode | null {
    return this.previousSibling;
  }

  get previousNamedSibling(): SyntaxNode | null {
    return this.node?.previousNamedSibling
      ? new SyntaxNode(this.tree, this.node.previousNamedSibling)
      : null;
  }

  get children(): SyntaxNode[] {
    return this.node ? this.node.children.map((child) => new SyntaxNode(this.tree, child)) : [];
  }

  get namedChildren(): SyntaxNode[] {
    return this.node
      ? this.node.namedChildren.map((child) => new SyntaxNode(this.tree, child))
      : [];
  }

  get text() {
    return this.node?.text ?? "";
  }

  get isError() {
    return this.node?.isError || this.node?.isMissing || false;
  }

  get parseState() {
    return this.node?.parseState ?? 0;
  }

  get nextParseState() {
    return this.node?.nextParseState ?? 0;
  }

  equals(other: SyntaxNode) {
    return !!this.node && !!other.node && this.node.equals(other.node);
  }

  prop<T>(prop: NodeProp<T>): T | undefined {
    return this.type.prop(prop);
  }

  resolve(pos: number, side: -1 | 0 | 1 = 0): SyntaxNode {
    if (!this.node) return this;
    let index = pos;
    if (side < 0 && index > this.from) index--;
    if (index >= this.to && this.to > this.from) index = this.to - 1;
    if (index < this.from) index = this.from;
    let found = this.node.descendantForIndex(index, index);
    return found ? new SyntaxNode(this.tree, found) : this;
  }

  resolveInner(pos: number, side: -1 | 0 | 1 = 0) {
    return this.resolve(pos, side);
  }

  matchContext(context: readonly string[]): boolean {
    let index = context.length - 1;
    for (let parent = this.parent; index >= 0; parent = parent.parent) {
      if (!parent) return false;
      if (!parent.type.isSkipped) {
        if (context[index] && context[index] != parent.name) return false;
        index--;
      }
    }
    return true;
  }

  enterUnfinishedNodesBefore(pos: number): SyntaxNode {
    let scan = this.childBefore(pos);
    let unfinished: SyntaxNode | null = null;
    while (scan) {
      let last = scan.lastChild;
      if (!last || last.to != scan.to) break;
      if (last.type.isError && last.from == last.to) {
        unfinished = scan;
        scan = last.prevSibling;
      } else {
        scan = last;
      }
    }
    return unfinished ?? this;
  }

  enter(pos: number, side: -1 | 0 | 1 = 0): SyntaxNode | null {
    if (!this.node) return null;
    let found = this.resolve(pos, side);
    return found.node && found.node.id != this.node.id ? found : null;
  }

  childAfter(pos: number): SyntaxNode | null {
    if (!this.node) return null;
    let child = this.node.firstChildForIndex(pos);
    while (child && child.endIndex <= pos) child = child.nextSibling;
    return child ? new SyntaxNode(this.tree, child) : null;
  }

  childBefore(pos: number): SyntaxNode | null {
    if (!this.node) return null;
    let children = this.node.children;
    for (let i = children.length - 1; i >= 0; i--) {
      let child = children[i]!;
      if (child.startIndex < pos) return new SyntaxNode(this.tree, child);
    }
    return null;
  }

  firstChildForIndex(index: number): SyntaxNode | null {
    let child = this.node?.firstChildForIndex(index);
    return child ? new SyntaxNode(this.tree, child) : null;
  }

  firstNamedChildForIndex(index: number): SyntaxNode | null {
    let child = this.node?.firstNamedChildForIndex(index);
    return child ? new SyntaxNode(this.tree, child) : null;
  }

  child(index: number): SyntaxNode | null {
    let child = this.node?.child(index);
    return child ? new SyntaxNode(this.tree, child) : null;
  }

  namedChild(index: number): SyntaxNode | null {
    let child = this.node?.namedChild(index);
    return child ? new SyntaxNode(this.tree, child) : null;
  }

  childForFieldName(fieldName: string): SyntaxNode | null {
    let child = this.node?.childForFieldName(fieldName);
    return child ? new SyntaxNode(this.tree, child) : null;
  }

  childrenForFieldName(fieldName: string): SyntaxNode[] {
    return this.node
      ? this.node.childrenForFieldName(fieldName).map((child) => new SyntaxNode(this.tree, child))
      : [];
  }

  childForFieldId(fieldId: number): SyntaxNode | null {
    let child = this.node?.childForFieldId(fieldId);
    return child ? new SyntaxNode(this.tree, child) : null;
  }

  childrenForFieldId(fieldId: number): SyntaxNode[] {
    return this.node
      ? this.node.childrenForFieldId(fieldId).map((child) => new SyntaxNode(this.tree, child))
      : [];
  }

  getChild(
    type: NodeSelector,
    before: NodeSelector | null = null,
    after: NodeSelector | null = null,
  ): SyntaxNode | null {
    let children = this.getChildren(type, before, after);
    return children.length ? children[0]! : null;
  }

  getChildren(
    type: NodeSelector,
    before: NodeSelector | null = null,
    after: NodeSelector | null = null,
  ): SyntaxNode[] {
    if (typeof type == "string" && before == null && after == null) {
      let byField = this.childrenForFieldName(type);
      if (byField.length) return byField;
    }

    let cursor = this.cursor();
    let result: SyntaxNode[] = [];
    if (!cursor) return result;

    try {
      if (!cursor.firstChild()) return result;
      if (before != null) {
        for (;;) {
          if (cursor.type.is(before)) break;
          if (!cursor.nextSibling()) return result;
        }
        if (!cursor.nextSibling()) return result;
      }

      for (;;) {
        if (after != null && cursor.type.is(after)) return result;
        if (cursor.type.is(type)) result.push(cursor.node);
        if (!cursor.nextSibling()) return after == null ? result : [];
      }
    } finally {
      cursor.delete();
    }
  }

  fieldNameForChild(index: number): string | null {
    return this.node?.fieldNameForChild(index) ?? null;
  }

  fieldNameForNamedChild(index: number): string | null {
    return this.node?.fieldNameForNamedChild(index) ?? null;
  }

  childWithDescendant(descendant: SyntaxNode): SyntaxNode | null {
    if (!this.node || !descendant.node) return null;
    let child = this.node.childWithDescendant(descendant.node);
    return child ? new SyntaxNode(this.tree, child) : null;
  }

  descendantsOfType(
    types: string | readonly string[],
    from?: number | Point,
    to?: number | Point,
  ): SyntaxNode[] {
    if (!this.node) return [];
    let nativeTypes = typeof types == "string" ? types : Array.from(types);
    let nodes =
      typeof from == "object"
        ? this.node.descendantsOfType(nativeTypes, from, typeof to == "object" ? to : undefined)
        : this.node.descendantsOfType(nativeTypes);
    if (typeof from == "number" || typeof to == "number") {
      let fromIndex = typeof from == "number" ? from : -Infinity;
      let toIndex = typeof to == "number" ? to : Infinity;
      nodes = nodes.filter((node) => node.endIndex >= fromIndex && node.startIndex <= toIndex);
    }
    return nodes.map((node) => new SyntaxNode(this.tree, node));
  }

  descendantForIndex(start: number, end = start): SyntaxNode | null {
    let found = this.node?.descendantForIndex(start, end);
    return found ? new SyntaxNode(this.tree, found) : null;
  }

  namedDescendantForIndex(start: number, end = start): SyntaxNode | null {
    let found = this.node?.namedDescendantForIndex(start, end);
    return found ? new SyntaxNode(this.tree, found) : null;
  }

  descendantForPosition(start: Point, end = start): SyntaxNode | null {
    let found = this.node?.descendantForPosition(start, end);
    return found ? new SyntaxNode(this.tree, found) : null;
  }

  namedDescendantForPosition(start: Point, end = start): SyntaxNode | null {
    let found = this.node?.namedDescendantForPosition(start, end);
    return found ? new SyntaxNode(this.tree, found) : null;
  }

  cursor() {
    return this.node ? new TreeCursor(this.tree, this.node.walk()) : null;
  }

  iterate(enter: (node: SyntaxNode) => boolean | void, leave?: (node: SyntaxNode) => void) {
    let cursor = this.cursor();
    if (!cursor) return;
    try {
      iterateSyntaxCursor(cursor, enter, leave);
    } finally {
      cursor.delete();
    }
  }

  toString() {
    return this.node?.toString() ?? this.name;
  }
}

export type SyntaxNodeRef = SyntaxNode;

export class TreeCursor {
  private deleted = false;

  constructor(
    private readonly ownerTree: Tree,
    private readonly cursor: TSTreeCursor,
  ) {}

  get node() {
    return new SyntaxNode(this.ownerTree, this.cursor.currentNode);
  }

  get type() {
    return this.node.type;
  }

  get name() {
    return this.cursor.nodeType;
  }

  get from() {
    return this.cursor.startIndex;
  }

  get to() {
    return this.cursor.endIndex;
  }

  get fieldName() {
    return this.cursor.currentFieldName;
  }

  get fieldId() {
    return this.cursor.currentFieldId;
  }

  get depth() {
    return this.cursor.currentDepth;
  }

  get descendantIndex() {
    return this.cursor.currentDescendantIndex;
  }

  get nodeType() {
    return this.cursor.nodeType;
  }

  get nodeTypeId() {
    return this.cursor.nodeTypeId;
  }

  get nodeStateId() {
    return this.cursor.nodeStateId;
  }

  get nodeId() {
    return this.cursor.nodeId;
  }

  get nodeIsNamed() {
    return this.cursor.nodeIsNamed;
  }

  get nodeIsMissing() {
    return this.cursor.nodeIsMissing;
  }

  get nodeText() {
    return this.cursor.nodeText;
  }

  get startPosition() {
    return this.cursor.startPosition;
  }

  get endPosition() {
    return this.cursor.endPosition;
  }

  get tree() {
    return this.ownerTree;
  }

  private copyCursor() {
    // web-tree-sitter copies the cursor from its shared transfer buffer, so
    // force the current cursor into that buffer before calling copy().
    void this.cursor.nodeTypeId;
    return this.cursor.copy();
  }

  private resetToRoot() {
    let root = this.ownerTree.topNode.node;
    if (!root) return false;
    this.cursor.reset(root);
    return true;
  }

  copy() {
    return new TreeCursor(this.ownerTree, this.copyCursor());
  }

  delete() {
    if (!this.deleted) {
      this.deleted = true;
      this.cursor.delete();
    }
  }

  firstChild() {
    return this.cursor.gotoFirstChild();
  }

  lastChild() {
    return this.cursor.gotoLastChild();
  }

  parent() {
    return this.cursor.gotoParent();
  }

  childBefore(pos: number) {
    if (!this.cursor.gotoFirstChild()) return false;
    if (this.cursor.startIndex >= pos) {
      this.cursor.gotoParent();
      return false;
    }
    while (this.cursor.gotoNextSibling()) {
      if (this.cursor.startIndex >= pos) {
        this.cursor.gotoPreviousSibling();
        break;
      }
    }
    return true;
  }

  childAfter(pos: number) {
    if (!this.cursor.gotoFirstChild()) return false;
    do {
      if (this.cursor.endIndex > pos) return true;
    } while (this.cursor.gotoNextSibling());
    this.cursor.gotoParent();
    return false;
  }

  enter(pos: number, side: -1 | 0 | 1 = 0) {
    let start = this.copyCursor();
    try {
      let index = cursorSearchIndex(this, pos, side);
      if (this.cursor.gotoFirstChildForIndex(index) && rangeContains(this, pos, side)) return true;
      this.cursor.resetTo(start);
      return false;
    } finally {
      start.delete();
    }
  }

  nextSibling() {
    return this.cursor.gotoNextSibling();
  }

  prevSibling() {
    return this.cursor.gotoPreviousSibling();
  }

  gotoDescendant(index: number) {
    this.cursor.gotoDescendant(index);
  }

  firstChildForIndex(index: number) {
    return this.cursor.gotoFirstChildForIndex(index);
  }

  firstChildForPosition(position: Point) {
    return this.cursor.gotoFirstChildForPosition(position);
  }

  moveTo(pos: number, side: -1 | 0 | 1 = 0) {
    if (!this.resetToRoot()) return this;
    for (;;) {
      let start = this.copyCursor();
      try {
        let index = cursorSearchIndex(this, pos, side);
        if (!this.cursor.gotoFirstChildForIndex(index) || !rangeContains(this, pos, side)) {
          this.cursor.resetTo(start);
          return this;
        }
      } finally {
        start.delete();
      }
    }
  }

  reset(node: SyntaxNode) {
    if (node.node) this.cursor.reset(node.node);
  }

  resetTo(cursor: TreeCursor) {
    this.cursor.resetTo(cursor.cursor);
  }

  next(enter = true) {
    if (enter && this.firstChild()) return true;
    for (;;) {
      if (this.nextSibling()) return true;
      if (!this.parent()) return false;
    }
  }

  prev(enter = true) {
    if (enter && this.lastChild()) return true;
    for (;;) {
      if (this.prevSibling()) return true;
      if (!this.parent()) return false;
    }
  }

  iterate(enter: (node: SyntaxNodeRef) => boolean | void, leave?: (node: SyntaxNodeRef) => void) {
    let cursor = this.copy();
    try {
      iterateSyntaxCursor(cursor, enter, leave);
    } finally {
      cursor.delete();
    }
  }

  matchContext(context: readonly string[]) {
    return this.node.matchContext(context);
  }
}

function iterateSyntaxCursor(
  cursor: TreeCursor,
  enter: (node: SyntaxNodeRef) => boolean | void,
  leave?: (node: SyntaxNodeRef) => void,
) {
  let frames: Array<{ childrenStarted: boolean; node: SyntaxNode }> = [];
  let enterCurrent = () => {
    let node = cursor.node;
    if (enter(node) === false) return false;
    frames.push({ childrenStarted: false, node });
    return true;
  };
  let advanceAfterChild = () => {
    for (;;) {
      if (!cursor.nextSibling()) {
        cursor.parent();
        return false;
      }
      if (enterCurrent()) return true;
    }
  };

  if (!enterCurrent()) return;
  while (frames.length) {
    let frame = frames.at(-1)!;
    if (!frame.childrenStarted) {
      frame.childrenStarted = true;
      if (cursor.firstChild() && (enterCurrent() || advanceAfterChild())) continue;
    }

    leave?.(frame.node);
    frames.pop();
    if (frames.length && advanceAfterChild()) continue;
  }
}

export function pointAfterText(start: Point, text: string): Point {
  let row = start.row;
  let column = start.column;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) == 10) {
      row++;
      column = 0;
    } else {
      column++;
    }
  }
  return { row, column };
}
