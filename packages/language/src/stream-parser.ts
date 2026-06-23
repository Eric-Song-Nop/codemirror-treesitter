import { Text } from "@codemirror/state";
import {
  Language,
  LanguageSupport,
  ParseContext,
  Tree,
  defineLanguageFacet,
  languageDataProp,
  type TreeSitterParser,
} from "./language.js";
import {
  getIndentUnit,
  indentNodeProp,
  type IndentContext,
  type TreeIndentContext,
} from "./indent.js";
import { StringStream } from "./stringstream.js";
import { Tag, tags } from "./tags.js";
import { NodeType, type NodeProp, type TreeConfig } from "./tree.js";

export { StringStream };

export interface StreamParser<State> {
  name?: string;
  startState?(indentUnit: number): State;
  token(stream: StringStream, state: State): string | null;
  blankLine?(state: State, indentUnit: number): void;
  copyState?(state: State): State;
  indent?(state: State, textAfter: string, context: IndentContext): number | null;
  languageData?: { [name: string]: unknown };
  tokenTable?: { [name: string]: Tag | readonly Tag[] };
  mergeTokens?: boolean;
}

type FullStreamParser<State> = Required<Omit<StreamParser<State>, "name">> & {
  name?: string;
};

type Point = { row: number; column: number };

class StreamParserAdapter<State> implements TreeConfig {
  readonly styleTags = new Map<string, readonly Tag[]>();
  private readonly typeCache = new Map<string, NodeType>();
  private readonly tokenIds = new Map<string, number>();
  private readonly tokenNames = new Map<string, string>();

  constructor(
    readonly streamParser: FullStreamParser<State>,
    private readonly data: ReturnType<typeof defineLanguageFacet>,
  ) {}

  createParser() {
    return {};
  }

  parse(doc: Text) {
    return this.wrapTree(this.parseWith({}, doc), doc) ?? Tree.empty;
  }

  parseWith(_parser: unknown, doc: Text, _oldTree: unknown = null, shouldStop?: () => boolean) {
    let context = ParseContext.get();
    let unit = context ? getIndentUnit(context.state) : 2;
    let tabSize = context?.state.tabSize ?? 4;
    let state = this.streamParser.startState(unit);
    let children: SimpleNode[] = [];
    let id = 1;

    for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
      if (shouldStop?.()) return null;
      let line = doc.line(lineNumber);
      let stream = new StringStream(line.text, tabSize, unit);
      if (stream.eol()) {
        this.streamParser.blankLine(state, stream.indentUnit);
      } else {
        while (!stream.eol()) {
          let token = readToken(this.streamParser.token, stream, state);
          if (token && stream.pos > stream.start) {
            children.push(
              new SimpleNode(
                this.nodeNameForToken(token),
                this.nodeIdForToken(token),
                line.from + stream.start,
                line.from + stream.pos,
                id++,
                true,
              ),
            );
          }
        }
      }
    }

    return { rootNode: new SimpleNode("Document", 0, 0, doc.length, 0, true, children) };
  }

  wrapTree(tree: { rootNode: SimpleNode } | null, doc: Text) {
    return tree ? new Tree(tree as never, this, doc.length) : null;
  }

  editWrappedTree(tree: Tree) {
    return tree;
  }

  nodeType(type: string, id: number, named: boolean, top = false, error = false) {
    let key = `${id}:${type}:${top}:${error}`;
    let found = this.typeCache.get(key);
    if (!found) {
      found = new NodeType(type, id, top, error, !named, this);
      this.typeCache.set(key, found);
    }
    return found;
  }

  prop<T>(type: NodeType, prop: NodeProp<T>): T | undefined {
    let anyProp = prop as NodeProp<unknown>;
    if (type.isTop && anyProp == languageDataProp) return this.data as T;
    if (type.isTop && anyProp == indentNodeProp) {
      return ((cx: TreeIndentContext) => this.indent(cx)) as T;
    }
    return undefined;
  }

  private indent(cx: TreeIndentContext) {
    let state = this.streamParser.startState(cx.unit);
    let upto = cx.state.doc.lineAt(cx.pos).from;
    for (let pos = 0; pos < upto; ) {
      let line = cx.state.doc.lineAt(pos);
      if (line.length) {
        let stream = new StringStream(line.text, cx.state.tabSize, cx.unit);
        while (!stream.eol()) readToken(this.streamParser.token, stream, state);
      } else {
        this.streamParser.blankLine(state, cx.unit);
      }
      pos = line.to + 1;
    }
    let line = cx.lineAt(cx.pos);
    return this.streamParser.indent(state, /^\s*(.*)/.exec(line.text)![1]!, cx);
  }

  private nodeNameForToken(token: string) {
    let found = this.tokenNames.get(token);
    if (!found) {
      found = token.replace(/\s+/g, "_");
      this.tokenNames.set(token, found);
      this.styleTags.set(found, tagsForToken(token, this.streamParser.tokenTable));
    }
    return found;
  }

  private nodeIdForToken(token: string) {
    let found = this.tokenIds.get(token);
    if (found == null) {
      found = this.tokenIds.size + 1;
      this.tokenIds.set(token, found);
    }
    return found;
  }
}

export class StreamLanguage<State> extends Language {
  readonly streamParser: StreamParser<State>;

  private constructor(parser: StreamParser<State>) {
    let streamParser = fullParser(parser);
    let data = defineLanguageFacet(streamParser.languageData);
    let adapter = new StreamParserAdapter(streamParser, data);
    super(data, adapter as unknown as TreeSitterParser, [], parser.name);
    this.streamParser = streamParser;
  }

  get allowsNesting() {
    return false;
  }

  static define<State>(spec: StreamParser<State>) {
    return new StreamLanguage(spec);
  }
}

export function legacy(parser: StreamParser<unknown>): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser));
}

type SimpleCursor = {
  currentNode: SimpleNode;
  currentFieldName: string | null;
  currentFieldId: number;
  currentDepth: number;
  currentDescendantIndex: number;
  nodeType: string;
  nodeTypeId: number;
  nodeStateId: number;
  nodeId: number;
  nodeIsNamed: boolean;
  nodeIsMissing: boolean;
  nodeText: string;
  startIndex: number;
  endIndex: number;
  startPosition: Point;
  endPosition: Point;
  copy: () => SimpleCursor;
  delete: () => void;
  resetTo: (cursor: SimpleCursor) => void;
  gotoFirstChild: () => boolean;
  gotoLastChild: () => boolean;
  gotoParent: () => boolean;
  gotoNextSibling: () => boolean;
  gotoPreviousSibling: () => boolean;
  gotoDescendant: (index: number) => void;
  gotoFirstChildForIndex: (index: number) => boolean;
  gotoFirstChildForPosition: (position: Point) => boolean;
};

class SimpleNode {
  parent: SimpleNode | null = null;
  readonly isError = false;
  readonly isMissing = false;
  readonly isExtra = false;
  readonly parseState = 0;
  readonly nextParseState = 0;

  constructor(
    readonly type: string,
    readonly typeId: number,
    readonly startIndex: number,
    readonly endIndex: number,
    readonly id: number,
    readonly isNamed: boolean,
    readonly children: readonly SimpleNode[] = [],
  ) {
    for (let child of children) child.parent = this;
  }

  get childCount() {
    return this.children.length;
  }

  get namedChildCount() {
    return this.namedChildren.length;
  }

  get descendantCount(): number {
    return 1 + this.children.reduce((sum, child) => sum + child.descendantCount, 0);
  }

  get startPosition() {
    return { row: 0, column: this.startIndex };
  }

  get endPosition() {
    return { row: 0, column: this.endIndex };
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  get firstNamedChild() {
    return this.namedChildren[0] ?? null;
  }

  get lastChild() {
    return this.children[this.children.length - 1] ?? null;
  }

  get lastNamedChild() {
    let children = this.namedChildren;
    return children[children.length - 1] ?? null;
  }

  get nextSibling() {
    let siblings = this.parent?.children;
    if (!siblings) return null;
    let index = siblings.indexOf(this);
    return index < 0 ? null : (siblings[index + 1] ?? null);
  }

  get nextNamedSibling() {
    for (let node = this.nextSibling; node; node = node.nextSibling) if (node.isNamed) return node;
    return null;
  }

  get previousSibling() {
    let siblings = this.parent?.children;
    if (!siblings) return null;
    let index = siblings.indexOf(this);
    return index <= 0 ? null : (siblings[index - 1] ?? null);
  }

  get previousNamedSibling() {
    for (let node = this.previousSibling; node; node = node.previousSibling) {
      if (node.isNamed) return node;
    }
    return null;
  }

  get namedChildren() {
    return this.children.filter((child) => child.isNamed);
  }

  get text() {
    return "";
  }

  get hasChanges() {
    return false;
  }

  get hasError() {
    return false;
  }

  get grammarId() {
    return 0;
  }

  get grammarType() {
    return this.type;
  }

  equals(other: SimpleNode) {
    return this == other;
  }

  child(index: number) {
    return this.children[index] ?? null;
  }

  namedChild(index: number) {
    return this.namedChildren[index] ?? null;
  }

  childForFieldName() {
    return null;
  }

  childrenForFieldName() {
    return [];
  }

  childForFieldId() {
    return null;
  }

  childrenForFieldId() {
    return [];
  }

  fieldNameForChild() {
    return null;
  }

  fieldNameForNamedChild() {
    return null;
  }

  childWithDescendant(descendant: SimpleNode) {
    return this.children.find((child) => containsNode(child, descendant)) ?? null;
  }

  firstChildForIndex(index: number) {
    return (
      this.children.find((child) => child.endIndex > index || child.startIndex >= index) ?? null
    );
  }

  firstNamedChildForIndex(index: number) {
    return (
      this.namedChildren.find((child) => child.endIndex > index || child.startIndex >= index) ??
      null
    );
  }

  descendantForIndex(start: number, end = start): SimpleNode | null {
    if (end < this.startIndex || start > this.endIndex) return null;
    for (let child of this.children) {
      let found = child.descendantForIndex(start, end);
      if (found) return found;
    }
    return this;
  }

  namedDescendantForIndex(start: number, end = start): SimpleNode | null {
    let found = this.descendantForIndex(start, end);
    for (let node = found; node; node = node.parent) if (node.isNamed) return node;
    return null;
  }

  descendantForPosition(position: Point, end = position) {
    return this.descendantForIndex(position.column, end.column);
  }

  namedDescendantForPosition(position: Point, end = position) {
    return this.namedDescendantForIndex(position.column, end.column);
  }

  descendantsOfType(types: readonly string[]) {
    let result: SimpleNode[] = [];
    this.visit((node) => {
      if (types.includes(node.type)) result.push(node);
    });
    return result;
  }

  walk(): SimpleCursor {
    return new SimpleTreeCursor(this);
  }

  toString(): string {
    if (!this.children.length) return this.type;
    return `(${this.type} ${this.children.map((child) => child.toString()).join(" ")})`;
  }

  private visit(callback: (node: SimpleNode) => void) {
    callback(this);
    for (let child of this.children) child.visit(callback);
  }
}

class SimpleTreeCursor implements SimpleCursor {
  private node: SimpleNode;

  constructor(node: SimpleNode) {
    this.node = node;
  }

  get currentNode() {
    return this.node;
  }

  get currentFieldName() {
    return null;
  }

  get currentFieldId() {
    return 0;
  }

  get currentDepth() {
    let depth = 0;
    for (let node = this.node.parent; node; node = node.parent) depth++;
    return depth;
  }

  get currentDescendantIndex() {
    let root = this.node;
    while (root.parent) root = root.parent;
    let index = 0;
    let found = 0;
    let visit = (node: SimpleNode) => {
      if (node == this.node) found = index;
      index++;
      for (let child of node.children) visit(child);
    };
    visit(root);
    return found;
  }

  get nodeType() {
    return this.node.type;
  }

  get nodeTypeId() {
    return this.node.typeId;
  }

  get nodeStateId() {
    return 0;
  }

  get nodeId() {
    return this.node.id;
  }

  get nodeIsNamed() {
    return this.node.isNamed;
  }

  get nodeIsMissing() {
    return false;
  }

  get nodeText() {
    return this.node.text;
  }

  get startIndex() {
    return this.node.startIndex;
  }

  get endIndex() {
    return this.node.endIndex;
  }

  get startPosition() {
    return this.node.startPosition;
  }

  get endPosition() {
    return this.node.endPosition;
  }

  copy() {
    return new SimpleTreeCursor(this.node);
  }

  delete() {}

  resetTo(cursor: SimpleCursor) {
    this.node = cursor.currentNode;
  }

  gotoFirstChild() {
    let child = this.node.firstChild;
    if (!child) return false;
    this.node = child;
    return true;
  }

  gotoLastChild() {
    let child = this.node.lastChild;
    if (!child) return false;
    this.node = child;
    return true;
  }

  gotoParent() {
    if (!this.node.parent) return false;
    this.node = this.node.parent;
    return true;
  }

  gotoNextSibling() {
    let sibling = this.node.nextSibling;
    if (!sibling) return false;
    this.node = sibling;
    return true;
  }

  gotoPreviousSibling() {
    let sibling = this.node.previousSibling;
    if (!sibling) return false;
    this.node = sibling;
    return true;
  }

  gotoDescendant(index: number) {
    let root = this.node;
    while (root.parent) root = root.parent;
    let current = 0;
    let found: SimpleNode | null = null;
    let visit = (node: SimpleNode) => {
      if (current == index) found = node;
      current++;
      for (let child of node.children) if (!found) visit(child);
    };
    visit(root);
    if (found) this.node = found;
  }

  gotoFirstChildForIndex(index: number) {
    let child = this.node.firstChildForIndex(index);
    if (!child) return false;
    this.node = child;
    return true;
  }

  gotoFirstChildForPosition(position: Point) {
    let child = this.node.firstChildForIndex(position.column);
    if (!child) return false;
    this.node = child;
    return true;
  }
}

function fullParser<State>(spec: StreamParser<State>): FullStreamParser<State> {
  return {
    name: spec.name,
    startState: (indentUnit) => (spec.startState ? spec.startState(indentUnit) : (true as State)),
    token: (stream, state) => spec.token(stream, state),
    blankLine: (state, indentUnit) => spec.blankLine?.(state, indentUnit),
    copyState: (state) => (spec.copyState ? spec.copyState(state) : defaultCopyState(state)),
    indent: (state, textAfter, context) =>
      spec.indent ? spec.indent(state, textAfter, context) : null,
    languageData: spec.languageData ?? {},
    tokenTable: spec.tokenTable ?? {},
    mergeTokens: spec.mergeTokens !== false,
  };
}

function defaultCopyState<State>(state: State): State {
  if (!state || typeof state != "object") return state;
  if (Array.isArray(state)) return state.slice() as State;
  return Object.assign(Object.create(Object.getPrototypeOf(state)), state);
}

function readToken<State>(
  token: (stream: StringStream, state: State) => string | null,
  stream: StringStream,
  state: State,
) {
  stream.start = stream.pos;
  for (let i = 0; i < 10; i++) {
    let result = token(stream, state);
    if (stream.pos > stream.start) return result;
  }
  throw new Error("Stream parser failed to advance stream.");
}

function tagsForToken(
  token: string,
  tokenTable: { [name: string]: Tag | readonly Tag[] } = {},
): readonly Tag[] {
  let result: Tag[] = [];
  for (let name of token.split(/\s+/)) {
    let found = tagsForName(name, tokenTable);
    for (let tag of found) if (!result.includes(tag)) result.push(tag);
  }
  return result;
}

function tagsForName(
  name: string,
  tokenTable: { [name: string]: Tag | readonly Tag[] },
): readonly Tag[] {
  let current: readonly Tag[] = [];
  for (let part of name.split(".")) {
    let value =
      tokenTable[part] ?? defaultTokenTable[part] ?? (tags as Record<string, unknown>)[part];
    if (!value) continue;
    if (typeof value == "function") current = current.map(value as (tag: Tag) => Tag);
    else current = Array.isArray(value) ? value : [value as Tag];
  }
  return current;
}

function containsNode(parent: SimpleNode, child: SimpleNode): boolean {
  if (parent == child) return true;
  return parent.children.some((node) => containsNode(node, child));
}

const defaultTokenTable: Record<string, Tag | readonly Tag[]> = {
  atom: tags.atom,
  attribute: tags.attributeName,
  builtin: tags.standard(tags.variableName),
  comment: tags.comment,
  def: tags.definition(tags.variableName),
  error: tags.invalid,
  header: tags.heading,
  keyword: tags.keyword,
  link: tags.link,
  meta: tags.meta,
  number: tags.number,
  operator: tags.operator,
  property: tags.propertyName,
  qualifier: tags.modifier,
  string: tags.string,
  "string-2": tags.special(tags.string),
  tag: tags.tagName,
  type: tags.typeName,
  variable: tags.variableName,
  "variable-2": tags.special(tags.variableName),
  "variable-3": tags.definition(tags.variableName),
};
