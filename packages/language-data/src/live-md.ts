import {
  LanguageSupport,
  NodeProp,
  TreeSitterLanguage,
  TreeSitterParser,
  continuedIndent,
  delimitedIndent,
  foldInside,
  foldNodeProp,
  indentNodeProp,
  queryTreeCaptures,
  tags,
  type DocRange,
  type NestedParserSource,
  type NodePropSource,
  type Tag,
  type Tree,
  type TreeSitterQueryCapture,
} from "@codemirror-treesitter/language";
import { collectMarkdownInlineRangeGroups } from "./markdown-inline-ranges.js";
import rawTextQuerySource from "./queries/raw-text.scm?raw";

type AssetLoader = () => Promise<string>;
type AssetModule = { default: string };
type NodeRequire = { resolve: (specifier: string) => string };

type LanguageSpec = {
  name: string;
  wasm: AssetLoader;
  implicitFinalNewline?: boolean;
  languageData?: { [name: string]: unknown };
  props?: readonly NodePropSource[];
  styleTags?: Record<string, Tag | readonly Tag[]>;
  highlightQuery?: AssetLoader;
  nested?: () => Promise<readonly NestedParserSource[]>;
};

export type MarkdownParserService = {
  blockLanguage: LanguageSupport;
  blockParser: TreeSitterParser;
  inlineParser: TreeSitterParser;
  inlineRanges: (tree: Tree, within?: DocRange) => DocRange[][];
};

export type LoadedLiveMdCodeFenceLanguage = {
  aliases: readonly string[];
  parser: TreeSitterParser;
};

const packageUrlAsset =
  (specifier: string, load: () => Promise<AssetModule>): AssetLoader =>
  async () =>
    isBrowserLike() ? (await load()).default : resolveNodeAsset(specifier);

const packageRawAsset =
  (specifier: string, load: () => Promise<AssetModule>): AssetLoader =>
  async () =>
    isBrowserLike() ? (await load()).default : readNodeAsset(specifier);

const localAsset =
  (url: URL): AssetLoader =>
  async () => {
    if (url.protocol == "file:") return url.pathname;
    if (!isBrowserLike()) return viteFsPath(url) ?? url.href;
    return url.href;
  };

let nodeRequire: NodeRequire | null = null;

async function resolveNodeAsset(specifier: string) {
  if (!nodeRequire) {
    let { createRequire } = (await import(/* @vite-ignore */ nodeModuleSpecifier)) as {
      createRequire: (filename: string | URL) => NodeRequire;
    };
    nodeRequire = createRequire(import.meta.url);
  }
  return nodeRequire.resolve(specifier);
}

async function readNodeAsset(specifier: string) {
  let { readFile } = (await import(/* @vite-ignore */ nodeFsSpecifier)) as {
    readFile: (path: string, encoding: "utf8") => Promise<string>;
  };
  return readFile(await resolveNodeAsset(specifier), "utf8");
}

function isBrowserLike() {
  return (
    typeof globalThis.location == "object" &&
    typeof (globalThis as typeof globalThis & { document?: unknown }).document == "object"
  );
}

function viteFsPath(url: URL) {
  if (url.pathname.startsWith("/@fs/")) return decodeURIComponent(url.pathname.slice(4));
  let cwd = (
    globalThis as typeof globalThis & { process?: { cwd?: () => string } }
  ).process?.cwd?.();
  if (cwd && isViteLocalhost(url) && url.pathname.startsWith("/")) {
    return `${cwd}${decodeURIComponent(url.pathname)}`;
  }
  return null;
}

function isViteLocalhost(url: URL) {
  return (
    (url.protocol == "http:" || url.protocol == "https:") &&
    (url.hostname == "localhost" || url.hostname == "127.0.0.1" || url.hostname == "[::1]")
  );
}

const nodeModuleSpecifier = "node:module";
const nodeFsSpecifier = "node:fs/promises";

const cssWasm = packageUrlAsset(
  "tree-sitter-css/tree-sitter-css.wasm",
  () => import("tree-sitter-css/tree-sitter-css.wasm?url"),
);
const cssHighlights = packageRawAsset(
  "tree-sitter-css/queries/highlights.scm",
  () => import("tree-sitter-css/queries/highlights.scm?raw"),
);
const htmlWasm = packageUrlAsset(
  "tree-sitter-html/tree-sitter-html.wasm",
  () => import("tree-sitter-html/tree-sitter-html.wasm?url"),
);
const htmlHighlights = packageRawAsset(
  "tree-sitter-html/queries/highlights.scm",
  () => import("tree-sitter-html/queries/highlights.scm?raw"),
);
const javascriptWasm = packageUrlAsset(
  "tree-sitter-javascript/tree-sitter-javascript.wasm",
  () => import("tree-sitter-javascript/tree-sitter-javascript.wasm?url"),
);
const javascriptHighlights = packageRawAsset(
  "tree-sitter-javascript/queries/highlights.scm",
  () => import("tree-sitter-javascript/queries/highlights.scm?raw"),
);
const jsonWasm = packageUrlAsset(
  "tree-sitter-json/tree-sitter-json.wasm",
  () => import("tree-sitter-json/tree-sitter-json.wasm?url"),
);
const jsonHighlights = packageRawAsset(
  "tree-sitter-json/queries/highlights.scm",
  () => import("tree-sitter-json/queries/highlights.scm?raw"),
);
const markdownWasm = localAsset(new URL("./wasm/tree-sitter-markdown.wasm", import.meta.url));
const markdownHighlights = packageRawAsset(
  "@tree-sitter-grammars/tree-sitter-markdown/tree-sitter-markdown/queries/highlights.scm",
  () =>
    import("@tree-sitter-grammars/tree-sitter-markdown/tree-sitter-markdown/queries/highlights.scm?raw"),
);
const markdownInlineWasm = localAsset(
  new URL("./wasm/tree-sitter-markdown-inline.wasm", import.meta.url),
);
const markdownInlineHighlights = packageRawAsset(
  "@tree-sitter-grammars/tree-sitter-markdown/tree-sitter-markdown-inline/queries/highlights.scm",
  () =>
    import("@tree-sitter-grammars/tree-sitter-markdown/tree-sitter-markdown-inline/queries/highlights.scm?raw"),
);
const pythonWasm = packageUrlAsset(
  "tree-sitter-python/tree-sitter-python.wasm",
  () => import("tree-sitter-python/tree-sitter-python.wasm?url"),
);
const pythonHighlights = packageRawAsset(
  "tree-sitter-python/queries/highlights.scm",
  () => import("tree-sitter-python/queries/highlights.scm?raw"),
);
const shellWasm = packageUrlAsset(
  "tree-sitter-bash/tree-sitter-bash.wasm",
  () => import("tree-sitter-bash/tree-sitter-bash.wasm?url"),
);
const shellHighlights = packageRawAsset(
  "tree-sitter-bash/queries/highlights.scm",
  () => import("tree-sitter-bash/queries/highlights.scm?raw"),
);
const typescriptHighlights = packageRawAsset(
  "tree-sitter-typescript/queries/highlights.scm",
  () => import("tree-sitter-typescript/queries/highlights.scm?raw"),
);
const tsxWasm = packageUrlAsset(
  "tree-sitter-typescript/tree-sitter-tsx.wasm",
  () => import("tree-sitter-typescript/tree-sitter-tsx.wasm?url"),
);
const typescriptWasm = packageUrlAsset(
  "tree-sitter-typescript/tree-sitter-typescript.wasm",
  () => import("tree-sitter-typescript/tree-sitter-typescript.wasm?url"),
);

const bracketed = delimitedIndent({ closing: "}" });
const continued = continuedIndent();
const commonProps: readonly NodePropSource[] = [
  indentNodeProp.add({
    array: delimitedIndent({ closing: "]" }),
    array_pattern: delimitedIndent({ closing: "]" }),
    arguments: delimitedIndent({ closing: ")" }),
    formal_parameters: delimitedIndent({ closing: ")" }),
    parameters: delimitedIndent({ closing: ")" }),
    parenthesized_expression: delimitedIndent({ closing: ")" }),
    object: bracketed,
    object_pattern: bracketed,
    statement_block: bracketed,
    class_body: bracketed,
    declaration_list: bracketed,
    compound_statement: bracketed,
    block: bracketed,
    import_statement: continued,
    call_expression: continued,
  }),
  foldNodeProp.add({
    array: foldInside,
    arguments: foldInside,
    formal_parameters: foldInside,
    parameters: foldInside,
    object: foldInside,
    statement_block: foldInside,
    class_body: foldInside,
    declaration_list: foldInside,
    compound_statement: foldInside,
    block: foldInside,
    element: foldInside,
    document: foldInside,
  }),
];

const tagIsolateProps = NodeProp.isolate.add({
  start_tag: "ltr",
  end_tag: "ltr",
  self_closing_tag: "ltr",
});

const commonStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  line_comment: tags.comment,
  block_comment: tags.comment,
  string: tags.string,
  string_fragment: tags.string,
  template_string: tags.string,
  number: [tags.number, tags.literal],
  integer: [tags.number, tags.literal],
  float: [tags.number, tags.literal],
  true: [tags.bool, tags.atom],
  false: [tags.bool, tags.atom],
  null: tags.atom,
  identifier: tags.variableName,
  property_identifier: tags.propertyName,
  field_identifier: tags.propertyName,
  type_identifier: tags.typeName,
  primitive_type: tags.typeName,
  class: tags.keyword,
  function: tags.keyword,
  return: tags.keyword,
  if: tags.keyword,
  else: tags.keyword,
  for: tags.keyword,
  while: tags.keyword,
  import: tags.keyword,
  export: tags.keyword,
  from: tags.keyword,
};

const stylesheetStyleTags: Record<string, Tag | readonly Tag[]> = {
  tag_name: tags.tagName,
  element_name: tags.tagName,
  class_name: tags.className,
  id_name: tags.labelName,
  property_name: tags.propertyName,
  custom_property_name: tags.definition(tags.propertyName),
  attribute_name: tags.attributeName,
  function_name: tags.function(tags.variableName),
  string_value: tags.string,
  plain_value: tags.atom,
  color_value: tags.color,
  boolean_value: tags.bool,
  null_value: tags.null,
  integer_value: tags.integer,
  float_value: tags.float,
  unit: tags.unit,
  at_keyword: tags.keyword,
  important: tags.modifier,
};

function lineComment(token: string) {
  return {
    commentTokens: { line: token },
    closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
    indentOnInput: /^\s*[}\])]$/,
  };
}

function blockComment(line = "//", open = "/*", close = "*/") {
  return {
    commentTokens: { line, block: { open, close } },
    closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
    indentOnInput: /^\s*[}\])]$/,
  };
}

const markdownData = { closeBrackets: { brackets: ["(", "[", "{", "'", '"', "`"] } };
const htmlData = {
  commentTokens: { block: { open: "<!--", close: "-->" } },
  closeBrackets: { brackets: ["<", "'", '"'] },
  indentOnInput: /^\s*<\/[\w-]+>$/,
};
const jsonData = {
  closeBrackets: { brackets: ["[", "{", '"'] },
  indentOnInput: /^\s*[}\]]$/,
};

async function load(spec: LanguageSpec) {
  let [wasm, highlightQuery, nested] = await Promise.all([
    spec.wasm(),
    spec.highlightQuery?.(),
    spec.nested?.(),
  ]);
  let parser = await TreeSitterParser.load(wasm, {
    implicitFinalNewline: spec.implicitFinalNewline,
  });
  let language = TreeSitterLanguage.define({
    name: spec.name.toLowerCase(),
    parser,
    languageData: spec.languageData ?? blockComment(),
    props: [...commonProps, ...(spec.props ?? [])],
    styleTags: { ...commonStyleTags, ...spec.styleTags },
    highlightQuery,
    nested,
  });
  return new LanguageSupport(language);
}

async function nestedParser(spec: LanguageSpec) {
  let [wasm, highlightQuery] = await Promise.all([spec.wasm(), spec.highlightQuery?.()]);
  let parser = await TreeSitterParser.load(wasm, {
    implicitFinalNewline: spec.implicitFinalNewline,
  });
  return TreeSitterLanguage.define({
    name: spec.name.toLowerCase(),
    parser,
    languageData: spec.languageData ?? blockComment(),
    props: [...commonProps, ...(spec.props ?? [])],
    styleTags: { ...commonStyleTags, ...spec.styleTags },
    highlightQuery,
  }).parser;
}

const cssSpec: LanguageSpec = {
  name: "CSS",
  wasm: cssWasm,
  languageData: blockComment("", "/*", "*/"),
  highlightQuery: cssHighlights,
  styleTags: stylesheetStyleTags,
};
const javascriptSpec: LanguageSpec = {
  name: "JavaScript",
  wasm: javascriptWasm,
  highlightQuery: javascriptHighlights,
};
const markdownInlineSpec: LanguageSpec = {
  name: "Markdown Inline",
  wasm: markdownInlineWasm,
  languageData: markdownData,
  highlightQuery: markdownInlineHighlights,
};
const markdownBlockSpec: LanguageSpec = {
  name: "Markdown",
  wasm: markdownWasm,
  implicitFinalNewline: true,
  languageData: markdownData,
  highlightQuery: markdownHighlights,
};

function rawTextRanges(parentName: string) {
  return (tree: Tree): DocRange[] =>
    queryTreeCaptures(tree, rawTextQuerySource, { includeNested: false })
      .filter((capture) => capture.name == `${parentName}.raw`)
      .map(captureRange);
}

function captureRange(capture: TreeSitterQueryCapture): DocRange {
  return { from: capture.node.from, to: capture.node.to };
}

const codeFenceSpecs = [
  {
    aliases: ["css"],
    spec: cssSpec,
  },
  {
    aliases: ["html", "xhtml", "htm", "handlebars", "hbs"],
    spec: {
      name: "HTML",
      wasm: htmlWasm,
      highlightQuery: htmlHighlights,
      languageData: htmlData,
      props: [tagIsolateProps],
      nested: async () => [
        { parser: await nestedParser(javascriptSpec), ranges: rawTextRanges("script") },
        { parser: await nestedParser(cssSpec), ranges: rawTextRanges("style") },
      ],
    },
  },
  {
    aliases: ["json", "json5", "map"],
    spec: {
      name: "JSON",
      wasm: jsonWasm,
      languageData: jsonData,
      highlightQuery: jsonHighlights,
    },
  },
  {
    aliases: ["javascript", "js", "jsx", "ecmascript", "node", "mjs", "cjs"],
    spec: javascriptSpec,
  },
  {
    aliases: ["markdown", "md", "mkd"],
    spec: markdownBlockSpec,
  },
  {
    aliases: ["python", "py", "pyw", "build", "bzl"],
    spec: {
      name: "Python",
      wasm: pythonWasm,
      languageData: lineComment("#"),
      highlightQuery: pythonHighlights,
    },
  },
  {
    aliases: ["shell", "sh", "bash", "zsh", "ksh"],
    spec: {
      name: "Shell",
      wasm: shellWasm,
      languageData: lineComment("#"),
      highlightQuery: shellHighlights,
    },
  },
  {
    aliases: ["tsx"],
    spec: { name: "TSX", wasm: tsxWasm, highlightQuery: typescriptHighlights },
  },
  {
    aliases: ["typescript", "ts", "mts", "cts"],
    spec: {
      name: "TypeScript",
      wasm: typescriptWasm,
      highlightQuery: typescriptHighlights,
    },
  },
] as const satisfies readonly { aliases: readonly string[]; spec: LanguageSpec }[];

const codeFenceSpecByAlias = new Map<string, (typeof codeFenceSpecs)[number]>(
  codeFenceSpecs.flatMap((entry) => entry.aliases.map((alias) => [alias, entry] as const)),
);
const codeFenceLanguagePromises = new Map<LanguageSpec, Promise<LoadedLiveMdCodeFenceLanguage>>();

export const liveMdCodeFenceLanguageNames = codeFenceSpecs.map((entry) => entry.spec.name);

export function loadLiveMdCodeFenceLanguage(
  name: string,
): Promise<LoadedLiveMdCodeFenceLanguage | null> {
  let entry = codeFenceSpecByAlias.get(name.trim().toLowerCase());
  if (!entry) return Promise.resolve(null);
  let current = codeFenceLanguagePromises.get(entry.spec);
  if (!current) {
    let attempt =
      entry.spec === markdownBlockSpec
        ? loadMarkdownParserService().then((service) => ({
            aliases: entry.aliases,
            parser: service.blockParser,
          }))
        : load(entry.spec).then((support) => {
            if (!(support.language instanceof TreeSitterLanguage)) {
              throw new Error(`${entry.spec.name} is not tree-sitter backed`);
            }
            return { aliases: entry.aliases, parser: support.language.parser };
          });
    current = attempt;
    codeFenceLanguagePromises.set(entry.spec, current);
    void attempt.catch(() => {
      if (codeFenceLanguagePromises.get(entry.spec) === attempt) {
        codeFenceLanguagePromises.delete(entry.spec);
      }
    });
  }
  return current;
}

let markdownParserServicePromise: Promise<MarkdownParserService> | null = null;

export function loadMarkdownParserService(): Promise<MarkdownParserService> {
  if (!markdownParserServicePromise) {
    let current = loadMarkdownParserServiceOnce();
    markdownParserServicePromise = current;
    void current.catch(() => {
      if (markdownParserServicePromise === current) markdownParserServicePromise = null;
    });
  }
  return markdownParserServicePromise;
}

async function loadMarkdownParserServiceOnce(): Promise<MarkdownParserService> {
  let [blockLanguage, inlineParser] = await Promise.all([
    load(markdownBlockSpec),
    nestedParser(markdownInlineSpec),
  ]);
  if (!(blockLanguage.language instanceof TreeSitterLanguage)) {
    throw new Error("Markdown block language is not tree-sitter backed");
  }
  return {
    blockLanguage,
    blockParser: blockLanguage.language.parser,
    inlineParser,
    inlineRanges: collectMarkdownInlineRangeGroups,
  };
}
