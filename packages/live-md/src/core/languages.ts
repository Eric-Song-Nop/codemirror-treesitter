import { Facet, StateEffect, StateField, Text, type Extension } from "@codemirror/state";
import {
  HighlightStyle,
  Tree,
  queryTreeMatches,
  tags as t,
  type Highlighter,
  type TreeSitterParser,
} from "@codemirror-treesitter/language";
import {
  liveMdCodeFenceLanguageNames,
  loadLiveMdCodeFenceLanguage,
  loadMarkdownParserService,
  type MarkdownParserService,
} from "@codemirror-treesitter/language-data/live-md";
import { EditorView } from "@codemirror/view";
import liveMdMarkdownInlineQuerySource from "./queries/decorations-markdown-inline.scm?raw";
import liveMdMarkdownQuerySource from "./queries/decorations-markdown.scm?raw";

export type CodeFenceLanguageMap = ReadonlyMap<string, TreeSitterParser>;
export type LiveMdMarkdownParserService = MarkdownParserService;

export const emptyCodeFenceLanguages: CodeFenceLanguageMap = new Map();
export const setCodeFenceLanguages = StateEffect.define<CodeFenceLanguageMap>();

const neutralCodeFenceHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#9b392b" },
  { tag: [t.name, t.definition(t.name), t.separator], color: "#2f3437" },
  { tag: [t.function(t.variableName), t.labelName], color: "#0f6a85" },
  { tag: [t.propertyName, t.attributeName], color: "#0f6a85" },
  { tag: [t.number, t.constant(t.name), t.standard(t.name)], color: "#8b4a35" },
  { tag: [t.typeName, t.className, t.annotation, t.modifier], color: "#8d3525" },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link], color: "#0f766e" },
  { tag: [t.meta, t.comment], color: "#66706c" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.heading, fontWeight: "bold", color: "#13231f" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#6d4b8f" },
  { tag: [t.processingInstruction, t.string, t.inserted, t.special(t.string)], color: "#0f766e" },
  { tag: [t.deleted, t.invalid], color: "#9b392b" },
]);

export const codeFenceHighlighterFacet = Facet.define<
  Highlighter | readonly Highlighter[],
  readonly Highlighter[] | null
>({
  combine(values) {
    let value = values.at(-1);
    if (!value) return null;
    return Array.isArray(value) ? value : [value];
  },
});

export const liveMdMarkdownParserServiceFacet = Facet.define<
  LiveMdMarkdownParserService,
  LiveMdMarkdownParserService | null
>({
  combine(values) {
    return values.at(-1) ?? null;
  },
});

export const codeFenceLanguagesField = StateField.define<CodeFenceLanguageMap>({
  create() {
    return emptyCodeFenceLanguages;
  },
  update(value, transaction) {
    for (let effect of transaction.effects) {
      if (effect.is(setCodeFenceLanguages)) return effect.value;
    }
    return value;
  },
});

export function liveMdCodeFenceHighlighting(highlighter: Highlighter): Extension {
  let extensions: Extension[] = [codeFenceHighlighterFacet.of(highlighter)];
  if (highlighter instanceof HighlightStyle && highlighter.module) {
    extensions.push(EditorView.styleModule.of(highlighter.module));
  }
  return extensions;
}

export const liveMdDefaultCodeFenceHighlighter = neutralCodeFenceHighlightStyle;

export const liveMdDefaultCodeFenceHighlighting: Extension = neutralCodeFenceHighlightStyle.module
  ? [EditorView.styleModule.of(neutralCodeFenceHighlightStyle.module)]
  : [];

let markdownExtensionPromise: Promise<Extension> | null = null;
const loadedCodeFenceLanguages = new Map<string, TreeSitterParser>();

export type PrepareLiveMdOptions = {
  codeFences?: boolean;
};

export async function prepareLiveMd(options: PrepareLiveMdOptions = {}) {
  await Promise.all([
    loadMarkdownExtension(),
    ...(options.codeFences ? [loadCodeFenceLanguages()] : []),
  ]);
}

export function loadMarkdownExtension() {
  if (!markdownExtensionPromise) {
    let current = loadMarkdownExtensionOnce();
    markdownExtensionPromise = current;
    void current.catch(() => {
      if (markdownExtensionPromise === current) markdownExtensionPromise = null;
    });
  }
  return markdownExtensionPromise;
}

export async function loadCodeFenceLanguages(
  names: Iterable<string> = liveMdCodeFenceLanguageNames,
): Promise<CodeFenceLanguageMap> {
  let uniqueNames = new Set(Array.from(names, (name) => name.trim().toLowerCase()).filter(Boolean));
  await Promise.all(
    Array.from(uniqueNames, async (name) => {
      if (loadedCodeFenceLanguages.has(name)) return;
      let loaded = await loadLiveMdCodeFenceLanguage(name).catch(() => null);
      if (!loaded) return;
      for (let alias of loaded.aliases) {
        loadedCodeFenceLanguages.set(alias.toLowerCase(), loaded.parser);
      }
    }),
  );
  let requested = new Map<string, TreeSitterParser>();
  for (let name of uniqueNames) {
    let parser = loadedCodeFenceLanguages.get(name);
    if (!parser) continue;
    for (let [alias, candidate] of loadedCodeFenceLanguages) {
      if (candidate === parser) requested.set(alias, parser);
    }
  }
  return requested;
}

export function codeFenceLanguageNames(doc: string): string[] {
  let names = new Set<string>();
  let openFence: { marker: "`" | "~"; length: number } | null = null;
  for (let line of doc.split(/\r?\n/u)) {
    let match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!match) continue;
    let marker = match[1]!;
    let rest = match[2]!;
    if (openFence) {
      if (marker[0] == openFence.marker && marker.length >= openFence.length && !rest.trim()) {
        openFence = null;
      }
      continue;
    }
    if (marker[0] == "`" && rest.includes("`")) continue;
    openFence = { marker: marker[0] as "`" | "~", length: marker.length };
    let token = rest.trim().split(/\s/u, 1)[0] ?? "";
    if (token.startsWith("{")) token = token.slice(1);
    if (token.startsWith(".")) token = token.slice(1);
    if (token.endsWith("}")) token = token.slice(0, -1);
    if (token) names.add(token.toLowerCase());
  }
  return Array.from(names);
}

async function loadMarkdownExtensionOnce() {
  let service = await loadMarkdownParserService();
  warmLiveMdMarkdownQueries(service);
  return [service.blockLanguage.extension, liveMdMarkdownParserServiceFacet.of(service)];
}

const liveMdMarkdownQueryWarmupDoc = Text.of([
  "# LiveMD query warmup",
  "",
  "Paragraph with **strong**, _emphasis_, ~~strike~~, `code`, [link](https://example.com), and ![image](image.png).",
]);

export function withLiveMdParserTree<T>(
  parser: TreeSitterParser,
  doc: Text,
  useTree: (tree: Tree) => T,
): T {
  let nativeParser = parser.createParser();
  let tree: Tree | null = null;
  let cleanup = () => {
    if (tree) {
      deleteLiveMdTree(tree);
      tree = null;
    }
    nativeParser.delete();
  };
  try {
    let parsed = parser.parseWith(nativeParser, doc);
    tree = parsed ? (parser.wrapTree(parsed, doc) ?? Tree.empty) : Tree.empty;
    let result = useTree(tree);
    if (isPromiseLike(result)) {
      return result.finally(cleanup) as T;
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function parseLiveMdMarkdownInlineTrees(
  service: LiveMdMarkdownParserService,
  doc: Text,
  blockTree: Tree,
): Tree[] {
  let parser = service.inlineParser.createParser();
  let trees: Tree[] = [];
  try {
    for (let ranges of service.inlineRanges(blockTree)) {
      let parsed = service.inlineParser.parseWith(parser, doc, null, undefined, ranges);
      if (!parsed) continue;
      let tree = service.inlineParser.wrapTree(parsed, doc);
      if (tree) trees.push(tree);
    }
    return trees;
  } catch (error) {
    for (let tree of trees) deleteLiveMdTree(tree);
    throw error;
  } finally {
    parser.delete();
  }
}

export function withLiveMdMarkdownInlineTrees<T>(
  service: LiveMdMarkdownParserService,
  doc: Text,
  blockTree: Tree,
  useTrees: (trees: readonly Tree[]) => T,
): T {
  let trees = parseLiveMdMarkdownInlineTrees(service, doc, blockTree);
  try {
    return useTrees(trees);
  } finally {
    for (let tree of trees) deleteLiveMdTree(tree);
  }
}

export function deleteLiveMdTree(tree: Tree) {
  for (let nested of tree.nested) deleteLiveMdTree(nested.tree);
  tree.tree?.delete();
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return !!value && typeof (value as Promise<T>).then == "function";
}

function warmLiveMdMarkdownQueries(service: LiveMdMarkdownParserService) {
  withLiveMdParserTree(service.blockParser, liveMdMarkdownQueryWarmupDoc, (tree) => {
    queryTreeMatches(tree, liveMdMarkdownQuerySource, { includeNested: false });
    withLiveMdMarkdownInlineTrees(service, liveMdMarkdownQueryWarmupDoc, tree, (inlineTrees) => {
      for (let inlineTree of inlineTrees) {
        queryTreeMatches(inlineTree, liveMdMarkdownInlineQuerySource, { includeNested: false });
      }
    });
  });
}
