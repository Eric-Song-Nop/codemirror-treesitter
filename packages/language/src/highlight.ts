import { EditorState, Facet, Prec, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { StyleModule, type StyleSpec } from "style-mod";
import { Language, languageDataProp, syntaxTree } from "./language.js";
import { NodeType, SyntaxNode } from "./tree.js";
import { Tag, tagHighlighter, tags, type Highlighter } from "./tags.js";

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
    } else if (tree != this.tree || update.viewportChanged || styleChange) {
      this.tree = tree;
      this.decorations = this.buildDeco(update.view, highlighters);
      this.decoratedTo = viewport.to;
    }
  }

  buildDeco(view: EditorView, highlighters: readonly Highlighter[] | null) {
    if (!highlighters || !this.tree.length) return Decoration.none;
    let builder = new RangeSetBuilder<Decoration>();
    for (let { from, to } of view.visibleRanges) {
      highlightTree(
        this.tree,
        highlighters,
        (from, to, style) => {
          builder.add(
            from,
            to,
            this.markCache[style] || (this.markCache[style] = Decoration.mark({ class: style })),
          );
        },
        from,
        to,
      );
    }
    return builder.finish();
  }
}

const treeHighlighter = Prec.high(
  ViewPlugin.fromClass(TreeHighlighter, {
    decorations: (value) => value.decorations,
  }),
);

function highlightTree(
  tree: ReturnType<typeof syntaxTree>,
  highlighters: readonly Highlighter[],
  putStyle: (from: number, to: number, style: string) => void,
  from: number,
  to: number,
) {
  let active = highlighters;
  let scopeStack: (readonly Highlighter[] | null)[] = [];
  let queryTags = collectQueryTags(tree, from, to);
  tree.iterate({
    from,
    to,
    enter(node) {
      let previous = null;
      if (node.type.isTop) {
        previous = active;
        active = highlighters.filter(
          (highlighter) => !highlighter.scope || highlighter.scope(node.type),
        );
      }
      scopeStack.push(previous);

      let nodeTags = queryTags.get(node.tree)?.get(node.id) ?? tagsForNode(node);
      if (!nodeTags.length || node.from == node.to) return;
      let classes: string[] = [];
      for (let highlighter of active) {
        let cls = highlighter.style(nodeTags);
        if (cls) classes.push(cls);
      }
      if (classes.length) putStyle(node.from, node.to, classes.join(" "));
    },
    leave() {
      let previous = scopeStack.pop();
      if (previous) active = previous;
    },
  });
}

function collectQueryTags(
  tree: ReturnType<typeof syntaxTree>,
  from: number,
  to: number,
): WeakMap<ReturnType<typeof syntaxTree>, Map<number, readonly Tag[]>> {
  let result = new WeakMap<ReturnType<typeof syntaxTree>, Map<number, readonly Tag[]>>();
  let collect = (tree: ReturnType<typeof syntaxTree>) => {
    let tags = tree.config?.highlightTags?.(tree, from, to);
    if (tags) result.set(tree, tags);
    for (let nest of tree.nested) collect(nest.tree);
  };
  collect(tree);
  return result;
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
