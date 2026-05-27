import {
  EditorState,
  Facet,
  Prec,
  RangeSetBuilder,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { StyleModule, type StyleSpec } from "style-mod";
import { clipToRanges, changedLineRanges, patchRangeSet } from "./incremental.js";
import { Language, languageDataProp, syntaxTree } from "./language.js";
import {
  type DocRange,
  type NestedTree,
  type NodeType,
  type SyntaxNode,
  type Tree,
} from "./tree.js";
import { getStyleTags, tagHighlighter, tags, type Highlighter, type Tag } from "./tags.js";

export class HighlightStyle implements Highlighter {
  readonly module: StyleModule | null;
  readonly themeType: "dark" | "light" | undefined;
  readonly style: (tags: readonly Tag[]) => string | null;
  readonly scope?: (type: NodeType) => boolean;

  private constructor(
    readonly specs: readonly TagStyle[],
    options: {
      scope?: NodeType | Language;
      all?: string | StyleSpec;
      themeType?: "dark" | "light";
    },
  ) {
    let modSpec: Record<string, StyleSpec> | undefined;
    let def = (spec: StyleSpec) => {
      let cls = StyleModule.newName();
      (modSpec || (modSpec = Object.create(null)))[`.${cls}`] = spec;
      return cls;
    };

    let all =
      typeof options.all == "string" ? options.all : options.all ? def(options.all) : undefined;
    let scopeOpt = options.scope;
    this.scope =
      scopeOpt instanceof Language
        ? (type: NodeType) => type.prop(languageDataProp) == scopeOpt.data
        : scopeOpt
          ? (type: NodeType) => type == scopeOpt
          : undefined;

    let highlighter = tagHighlighter(
      specs.map((style) => ({
        tag: style.tag,
        class: style.class || def(Object.assign({}, style, { tag: null })),
      })),
      { all },
    );
    this.style = (tags) => highlighter.style(tags);
    this.module = modSpec ? new StyleModule(modSpec) : null;
    this.themeType = options.themeType;
  }

  static define(
    specs: readonly TagStyle[],
    options: {
      scope?: Language | NodeType;
      all?: string | StyleSpec;
      themeType?: "dark" | "light";
    } = {},
  ) {
    return new HighlightStyle(specs, options);
  }
}

const highlighterFacet = Facet.define<Highlighter>();

const fallbackHighlighter = Facet.define<Highlighter, readonly Highlighter[] | null>({
  combine(values) {
    return values.length ? [values[0]!] : null;
  },
});

function getHighlighters(state: EditorState): readonly Highlighter[] | null {
  let main = state.facet(highlighterFacet);
  return main.length ? main : state.facet(fallbackHighlighter);
}

export function syntaxHighlighting(
  highlighter: Highlighter,
  options?: { fallback: boolean },
): Extension {
  let ext: Extension[] = [treeHighlighter];
  let themeType: string | undefined;
  if (highlighter instanceof HighlightStyle) {
    if (highlighter.module) ext.push(EditorView.styleModule.of(highlighter.module));
    themeType = highlighter.themeType;
  }
  if (options?.fallback) {
    ext.push(fallbackHighlighter.of(highlighter));
  } else if (themeType) {
    ext.push(
      highlighterFacet.computeN([EditorView.darkTheme], (state) => {
        return state.facet(EditorView.darkTheme) == (themeType == "dark") ? [highlighter] : [];
      }),
    );
  } else {
    ext.push(highlighterFacet.of(highlighter));
  }
  return ext;
}

export function highlightingFor(
  state: EditorState,
  tags: readonly Tag[],
  scope?: NodeType,
): string | null {
  let highlighters = getHighlighters(state);
  let result = null;
  if (highlighters) {
    for (let highlighter of highlighters) {
      if (!highlighter.scope || (scope && highlighter.scope(scope))) {
        let cls = highlighter.style(tags);
        if (cls) result = result ? `${result} ${cls}` : cls;
      }
    }
  }
  return result;
}

export interface TagStyle {
  tag: Tag | readonly Tag[];
  class?: string;
  [styleProperty: string]: unknown;
}

class TreeHighlighter {
  decorations: DecorationSet;
  decoratedTo: number;
  tree: ReturnType<typeof syntaxTree>;
  markCache: Record<string, Decoration> = Object.create(null);

  constructor(readonly view: EditorView) {
    this.tree = syntaxTree(view.state);
    this.decorations = this.buildDeco(view, getHighlighters(view.state));
    this.decoratedTo = view.viewport.to;
  }

  update(update: ViewUpdate) {
    let tree = syntaxTree(update.state);
    let highlighters = getHighlighters(update.state);
    let styleChange = highlighters != getHighlighters(update.startState);
    let { viewport } = update.view;
    let decoratedToMapped = update.changes.mapPos(this.decoratedTo, 1);
    if (
      tree.length < viewport.to &&
      !styleChange &&
      tree.type == this.tree.type &&
      decoratedToMapped >= viewport.to
    ) {
      this.decorations = this.decorations.map(update.changes);
      this.decoratedTo = decoratedToMapped;
    } else if (
      update.viewportChanged ||
      styleChange ||
      tree.type != this.tree.type ||
      !canPatchHighlight(update)
    ) {
      this.tree = tree;
      this.decorations = this.buildDeco(update.view, highlighters);
      this.decoratedTo = viewport.to;
    } else if (tree != this.tree || update.docChanged) {
      let dirtyRanges = changedLineRanges(update);
      this.tree = tree;
      this.decorations = patchRangeSet(
        this.decorations.map(update.changes),
        dirtyRanges,
        this.buildDecoRanges(update.view, highlighters, dirtyRanges),
      );
      this.decoratedTo = viewport.to;
    }
  }

  buildDeco(view: EditorView, highlighters: readonly Highlighter[] | null) {
    let ranges = this.buildDecoRanges(view, highlighters, view.visibleRanges);
    let builder = new RangeSetBuilder<Decoration>();
    for (let range of ranges) builder.add(range.from, range.to, range.value);
    return builder.finish();
  }

  buildDecoRanges(
    view: EditorView,
    highlighters: readonly Highlighter[] | null,
    ranges: readonly DocRange[],
  ): readonly Range<Decoration>[] {
    if (!highlighters || !this.tree.length) return [];
    let decorations: Range<Decoration>[] = [];
    for (let { from, to } of clipToRanges(ranges, view.visibleRanges)) {
      highlightTree(
        this.tree,
        highlighters,
        (from, to, style) => {
          decorations.push(
            (
              this.markCache[style] || (this.markCache[style] = Decoration.mark({ class: style }))
            ).range(from, to),
          );
        },
        from,
        to,
      );
    }
    return decorations;
  }
}

function canPatchHighlight(update: ViewUpdate) {
  return update.transactions.length == 1;
}

const treeHighlighter = Prec.high(
  ViewPlugin.fromClass(TreeHighlighter, {
    decorations: (value) => value.decorations,
  }),
);

export function highlightTree(
  tree: Tree,
  highlighter: Highlighter | readonly Highlighter[],
  putStyle: (from: number, to: number, style: string) => void,
  from = 0,
  to = tree.length,
) {
  let highlighters = Array.isArray(highlighter) ? highlighter : [highlighter];
  let queryTags = collectQueryTags(tree, from, to);
  let builder = new HighlightBuilder(from, highlighters, putStyle, queryTags);
  builder.highlightNode(tree.topNode, from, to, "", highlighters);
  builder.flush(to);
}

export function highlightCode(
  code: string,
  tree: Tree,
  highlighter: Highlighter | readonly Highlighter[],
  putText: (code: string, classes: string) => void,
  putBreak: () => void,
  from = 0,
  to = code.length,
) {
  let pos = from;
  let writeTo = (target: number, classes: string) => {
    if (target <= pos) return;
    let text = code.slice(pos, target);
    for (let i = 0; ; ) {
      let nextBreak = text.indexOf("\n", i);
      let upto = nextBreak < 0 ? text.length : nextBreak;
      if (upto > i) putText(text.slice(i, upto), classes);
      if (nextBreak < 0) break;
      putBreak();
      i = nextBreak + 1;
    }
    pos = target;
  };

  highlightTree(
    tree,
    highlighter,
    (from, to, classes) => {
      writeTo(from, "");
      writeTo(to, classes);
    },
    from,
    to,
  );
  writeTo(to, "");
}

function collectQueryTags(
  tree: Tree,
  from: number,
  to: number,
): WeakMap<Tree, Map<number, readonly Tag[]>> {
  let result = new WeakMap<Tree, Map<number, readonly Tag[]>>();
  let collect = (tree: Tree) => {
    let tags = tree.config?.highlightTags?.(tree, from, to);
    if (tags) result.set(tree, tags);
    for (let nest of tree.nested) collect(nest.tree);
  };
  collect(tree);
  return result;
}

class HighlightBuilder {
  private className = "";

  constructor(
    private at: number,
    private readonly highlighters: readonly Highlighter[],
    private readonly span: (from: number, to: number, cls: string) => void,
    private readonly queryTags: WeakMap<Tree, Map<number, readonly Tag[]>>,
  ) {}

  highlightNode(
    node: SyntaxNode,
    from: number,
    to: number,
    inheritedClass: string,
    activeHighlighters: readonly Highlighter[],
  ) {
    if (node.from >= to || node.to <= from) return;
    if (node.type.isTop) {
      activeHighlighters = this.highlighters.filter(
        (highlighter) => !highlighter.scope || highlighter.scope(node.type),
      );
    }

    let style = styleForNode(node, this.queryTags);
    let cls = inheritedClass;
    let childInherited = inheritedClass;
    if (style) {
      let tagCls = highlightTags(activeHighlighters, style.tags);
      if (tagCls) {
        cls = cls ? `${cls} ${tagCls}` : tagCls;
        if (style.inherit) childInherited = childInherited ? `${childInherited} ${tagCls}` : tagCls;
      }
    }

    this.startSpan(Math.max(from, node.from), cls);
    if (style?.opaque) return;

    let rangeFrom = Math.max(from, node.from);
    let rangeTo = Math.min(to, node.to);
    for (let child of sortedChildren(node, rangeFrom, rangeTo)) {
      if (child.to <= rangeFrom) continue;
      if (child.from >= rangeTo) break;
      let childStyle = styleForNode(child, this.queryTags);
      let childOwnClass = childStyle && highlightTags(activeHighlighters, childStyle.tags);
      let childClass =
        cls && (!childOwnClass || (child.from <= node.from && child.to >= node.to))
          ? cls
          : childInherited;
      this.highlightNode(child, rangeFrom, rangeTo, childClass, activeHighlighters);
      this.startSpan(Math.min(rangeTo, child.to), cls);
    }
  }

  startSpan(at: number, cls: string) {
    if (cls == this.className) return;
    this.flush(at);
    if (at > this.at) this.at = at;
    this.className = cls;
  }

  flush(to: number) {
    if (to > this.at && this.className) this.span(this.at, to, this.className);
  }
}

function highlightTags(highlighters: readonly Highlighter[], tags: readonly Tag[]) {
  let result = null;
  for (let highlighter of highlighters) {
    let cls = highlighter.style(tags);
    if (cls) result = result ? `${result} ${cls}` : cls;
  }
  return result;
}

function styleForNode(
  node: SyntaxNode,
  queryTags: WeakMap<Tree, Map<number, readonly Tag[]>>,
): { tags: readonly Tag[]; opaque: boolean; inherit: boolean } | null {
  let style = getStyleTags(node);
  if (style) return style;
  let configured =
    node.tree.config && "styleTags" in node.tree.config
      ? (node.tree.config.styleTags as ReadonlyMap<string, readonly Tag[]>).get(node.name)
      : undefined;
  let nodeTags = queryTags.get(node.tree)?.get(node.id) ?? configured ?? tagsForNode(node);
  return nodeTags.length ? { tags: nodeTags, opaque: false, inherit: false } : null;
}

function sortedChildren(node: SyntaxNode, from: number, to: number): SyntaxNode[] {
  let children: SyntaxNode[] = [];
  for (let child = firstHighlightChild(node, from); child && child.from < to; ) {
    children.push(child);
    child = child.nextSibling;
  }
  let nested = directNested(node, from, to);
  if (nested.length) children.push(...nested.map((nest) => nest.tree.topNode));
  return children.sort((a, b) => a.from - b.from || a.to - b.to);
}

function firstHighlightChild(node: SyntaxNode, from: number): SyntaxNode | null {
  let index = from > node.from ? from - 1 : from;
  let child = node.firstChildForIndex(index);
  while (child && child.to <= from) child = child.nextSibling;
  return child;
}

function directNested(node: SyntaxNode, from: number, to: number): NestedTree[] {
  let nested = node.tree.nested.filter(
    (nest) => nestedInsideNode(nest, node) && nestedOverlapsRange(nest, from, to),
  );
  if (!nested.length) return [];
  return nested.filter((nest) => !nestedInsideDirectChild(nest, node));
}

function nestedInsideDirectChild(nest: NestedTree, node: SyntaxNode) {
  for (let range of nest.ranges) {
    for (let child = firstHighlightChild(node, range.from); child && child.from < range.to; ) {
      if (range.from >= child.from && range.to <= child.to && child.to > child.from) return true;
      child = child.nextSibling;
    }
  }
  return false;
}

function nestedInsideNode(nest: NestedTree, node: SyntaxNode) {
  return nest.ranges.some((range) => range.from >= node.from && range.to <= node.to);
}

function nestedOverlapsRange(nest: NestedTree, from: number, to: number) {
  return nest.ranges.some((range) => range.from < to && range.to > from);
}

export function __testHighlightTree(
  tree: ReturnType<typeof syntaxTree>,
  highlighters: readonly Highlighter[],
  from = 0,
  to = tree.length,
) {
  let spans: { from: number; to: number; class: string }[] = [];
  highlightTree(
    tree,
    highlighters,
    (from, to, cls) => spans.push({ from, to, class: cls }),
    from,
    to,
  );
  return spans;
}

const keywordTypes = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "finally",
  "fn",
  "for",
  "from",
  "func",
  "function",
  "if",
  "import",
  "in",
  "interface",
  "let",
  "match",
  "new",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "struct",
  "switch",
  "throw",
  "try",
  "type",
  "var",
  "void",
  "while",
  "yield",
]);

function tagsForNode(node: SyntaxNode): readonly Tag[] {
  let configured =
    node.tree.config && "styleTags" in node.tree.config
      ? (node.tree.config.styleTags as ReadonlyMap<string, readonly Tag[]>).get(node.name)
      : undefined;
  if (configured) return configured;

  let name = node.name;
  if (node.type.isError || name == "ERROR") return [tags.invalid];
  if (/comment/i.test(name)) return [tags.comment];
  if (/string|char|template/.test(name)) return [tags.string];
  if (/regex|regexp/.test(name)) return [tags.regexp];
  if (/number|integer|float/.test(name)) return [tags.number, tags.literal];
  if (/boolean|true|false/.test(name)) return [tags.bool, tags.atom];
  if (/null|undefined|nil|none/.test(name)) return [tags.atom];
  if (/property_identifier|field_identifier|member/.test(name)) return [tags.propertyName];
  if (/type_identifier|primitive_type|type_name/.test(name)) return [tags.typeName];
  if (/class_name/.test(name)) return [tags.className];
  if (name == "identifier") return [tags.variableName];
  if (keywordTypes.has(name)) return [tags.keyword];
  if (/^[()[\]{}.,;:]$/.test(name)) return [tags.punctuation];
  if (/^[+\-*/%=!<>|&~^]+$/.test(name)) return [tags.operator];
  return [];
}

export const defaultHighlightStyle = HighlightStyle.define([
  { tag: tags.meta, color: "#404740" },
  { tag: tags.link, textDecoration: "underline" },
  { tag: tags.heading, textDecoration: "underline", fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.keyword, color: "#708" },
  { tag: [tags.atom, tags.bool, tags.url, tags.contentSeparator, tags.labelName], color: "#219" },
  { tag: [tags.literal, tags.inserted, tags.number], color: "#164" },
  { tag: [tags.string, tags.deleted], color: "#a11" },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: "#e40" },
  { tag: tags.definition(tags.variableName), color: "#00f" },
  { tag: tags.local(tags.variableName), color: "#30a" },
  { tag: [tags.typeName, tags.namespace], color: "#085" },
  { tag: tags.className, color: "#167" },
  { tag: [tags.special(tags.variableName), tags.macroName], color: "#256" },
  { tag: tags.definition(tags.propertyName), color: "#00c" },
  { tag: tags.comment, color: "#940" },
  { tag: tags.invalid, color: "#f00" },
]);
