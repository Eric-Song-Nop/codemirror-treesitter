import { Text } from "@codemirror/state";
import {
  queryTreeMatches,
  type SyntaxNode,
  type Tree,
  type TreeSitterQueryCapture,
  type TreeSitterQueryMatch,
} from "@codemirror-treesitter/language";
import {
  loadMarkdownParserService,
  type MarkdownParserService,
} from "@codemirror-treesitter/language-data";
import { liveMdThemeVariableNames } from "@codemirror-treesitter/live-md-theme";
import { withLiveMdParserTree } from "./languages.js";
import {
  sortLiveMdMarkdownFeatures,
  type LiveMdFeatureHtmlRenderContext,
  type LiveMdMarkdownConfig,
  type LiveMdMarkdownFeature,
} from "./features.js";
import { renderStrictLatexFormula, type LatexFormula } from "./latex.js";
import { sanitizeLiveMdLinkDestination } from "./link-destination.js";
import { renderLiveMdMermaidResult } from "./mermaid.js";

export type MarkdownHtmlImage = {
  alt: string;
  source: string;
  title: string | null;
};

export type MarkdownHtmlImageSourceResolver = (
  image: MarkdownHtmlImage,
) => Promise<string | null | undefined> | string | null | undefined;

export type MarkdownHtmlRenderOptions = {
  markdown?: LiveMdMarkdownConfig | null;
  resolveImageSource?: MarkdownHtmlImageSourceResolver | null;
};

export type LiveMdMarkdownDocumentCssOptions = {
  katexCss?: string | null;
};

export const liveMdMarkdownDocumentClass = "live-md-document";

export const liveMdMarkdownDocumentCssVariables = liveMdThemeVariableNames;

type MarkdownHtmlParsers = {
  block: MarkdownHtmlBlockParser;
  inline: MarkdownHtmlInlineParser;
};

type MarkdownHtmlBlockParser = MarkdownParserService["blockParser"];

type MarkdownHtmlInlineParser = MarkdownParserService["inlineParser"];

type MarkdownHtmlRenderContext = {
  featureMatches: ReadonlyMap<string, readonly MarkdownHtmlFeatureMatch[]>;
  inlineParser: MarkdownHtmlInlineParser;
  nodeKeys: MarkdownHtmlNodeKeys;
  options: MarkdownHtmlRenderOptions;
  source: string;
  text: Text;
};

type InlineRenderContext = {
  options: MarkdownHtmlRenderOptions;
  source: string;
};

type TableAlignment = "center" | "default" | "left" | "right";

type MarkdownHtmlFeatureMatch = {
  feature: LiveMdMarkdownFeature;
  match: TreeSitterQueryMatch;
  order: number;
  target: SyntaxNode;
};

type MarkdownHtmlNodeKeys = {
  key: (node: SyntaxNode) => string;
};

const markdownHtmlFallbackKatexStyles = `.katex .katex-mathml {
  position: absolute;
  clip: rect(1px, 1px, 1px, 1px);
  padding: 0;
  border: 0;
  height: 1px;
  width: 1px;
  overflow: hidden;
}

.katex {
  font: normal 1.21em KaTeX_Main, "Times New Roman", serif;
  line-height: 1.2;
  text-indent: 0;
  text-rendering: auto;
}

.katex-display {
  display: block;
  margin: 1em 0;
  text-align: center;
}`;

let markdownHtmlParsersPromise: Promise<MarkdownHtmlParsers> | null = null;

export async function renderMarkdownToHtml(
  markdown: string,
  options: MarkdownHtmlRenderOptions = {},
): Promise<string> {
  let parsers = await loadMarkdownHtmlParsers();
  let source = normalizeMarkdownLineEndings(markdown);
  let text = Text.of(source.split("\n"));
  let features = sortLiveMdMarkdownFeatures(options.markdown?.features ?? []);
  return withLiveMdParserTree(parsers.block, text, (tree) => {
    let nodeKeys = createMarkdownHtmlNodeKeys();
    let context: MarkdownHtmlRenderContext = {
      featureMatches: collectMarkdownHtmlFeatureMatches(features, tree, nodeKeys),
      inlineParser: parsers.inline,
      nodeKeys,
      options,
      source,
      text,
    };
    return renderBlockChildren(context, tree.topNode);
  });
}

export function liveMdMarkdownDocumentCss(options: LiveMdMarkdownDocumentCssOptions = {}) {
  return `${markdownHtmlKatexStyles(options.katexCss)}

.${liveMdMarkdownDocumentClass} {
  box-sizing: border-box;
  width: min(var(--live-md-content-width, 880px), 100%);
  min-height: 100vh;
  margin: 0 auto;
  padding-block-start: var(--live-md-content-padding-block-start, clamp(34px, 6vw, 72px));
  padding-block-end: var(--live-md-content-padding-block-end, 120px);
  padding-inline: var(--live-md-content-padding-inline, clamp(22px, 7vw, 78px));
  background: var(--live-md-bg, #fffdfa);
  color: var(--live-md-text, #202523);
  font-family: var(--live-md-font-body, "Iowan Old Style", "Palatino Linotype", Georgia, "Noto Serif", serif);
  font-size: 18px;
  line-height: 1.72;
  font-synthesis: weight style;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.${liveMdMarkdownDocumentClass},
.${liveMdMarkdownDocumentClass} * {
  box-sizing: border-box;
}

.${liveMdMarkdownDocumentClass} > :first-child {
  margin-top: 0;
}

.${liveMdMarkdownDocumentClass} > :last-child {
  margin-bottom: 0;
}

.${liveMdMarkdownDocumentClass} h1,
.${liveMdMarkdownDocumentClass} h2,
.${liveMdMarkdownDocumentClass} h3,
.${liveMdMarkdownDocumentClass} h4,
.${liveMdMarkdownDocumentClass} h5,
.${liveMdMarkdownDocumentClass} h6 {
  margin: 1.55em 0 0.58em;
  font-family: var(--live-md-font-ui, "Avenir Next", "Gill Sans", ui-sans-serif, system-ui, sans-serif);
  font-weight: 800;
  line-height: 1.18;
}

.${liveMdMarkdownDocumentClass} h1 {
  color: var(--live-md-heading-1, #13231f);
  font-size: 2.25em;
}

.${liveMdMarkdownDocumentClass} h2 {
  color: var(--live-md-heading-2, #183630);
  font-size: 1.62em;
}

.${liveMdMarkdownDocumentClass} h3 {
  color: var(--live-md-heading-3, #24433d);
  font-size: 1.28em;
}

.${liveMdMarkdownDocumentClass} h4,
.${liveMdMarkdownDocumentClass} h5,
.${liveMdMarkdownDocumentClass} h6 {
  color: var(--live-md-heading-rest, #355750);
  font-size: 1.08em;
}

.${liveMdMarkdownDocumentClass} p,
.${liveMdMarkdownDocumentClass} ul,
.${liveMdMarkdownDocumentClass} ol,
.${liveMdMarkdownDocumentClass} blockquote,
.${liveMdMarkdownDocumentClass} pre,
.${liveMdMarkdownDocumentClass} table,
.${liveMdMarkdownDocumentClass} figure,
.${liveMdMarkdownDocumentClass} .cm-md-table-preview,
.${liveMdMarkdownDocumentClass} .cm-md-mermaid {
  margin: 0 0 1.05em;
}

.${liveMdMarkdownDocumentClass} ul,
.${liveMdMarkdownDocumentClass} ol {
  padding-left: 1.45em;
}

.${liveMdMarkdownDocumentClass} li + li {
  margin-top: 0.18em;
}

.${liveMdMarkdownDocumentClass} ol > li::marker {
  color: var(--live-md-ordered-marker, #8b4a35);
  font-family: var(--live-md-font-ui, "Avenir Next", "Gill Sans", ui-sans-serif, system-ui, sans-serif);
  font-weight: 800;
}

.${liveMdMarkdownDocumentClass} ul > li::marker {
  color: var(--live-md-list-marker, #0f766e);
}

.${liveMdMarkdownDocumentClass} a {
  color: var(--live-md-link, #0f6a85);
  text-decoration: underline;
  text-decoration-color: var(--live-md-link-underline, rgba(15, 106, 133, 0.35));
  text-underline-offset: 0.18em;
}

.${liveMdMarkdownDocumentClass} strong {
  font-weight: 800;
}

.${liveMdMarkdownDocumentClass} del {
  color: var(--live-md-muted, #66706c);
}

.${liveMdMarkdownDocumentClass} blockquote {
  position: relative;
  color: var(--live-md-blockquote, #4d5f5a);
  font-style: italic;
  padding-left: 18px;
}

.${liveMdMarkdownDocumentClass} blockquote::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 0.22em;
  bottom: 0.22em;
  width: 3px;
  border-radius: 3px;
  background: var(--live-md-blockquote-border, #86aaa0);
}

.${liveMdMarkdownDocumentClass} code {
  border: 1px solid var(--live-md-inline-code-border, #d4c9bc);
  border-radius: 5px;
  background: var(--live-md-inline-code-bg, #f1ece4);
  color: var(--live-md-inline-code-text, #8d3525);
  font-family: var(--live-md-font-code, "SFMono-Regular", "Cascadia Code", ui-monospace, monospace);
  font-size: 0.86em;
  padding: 0.05em 0.28em;
}

.${liveMdMarkdownDocumentClass} pre {
  overflow-x: auto;
  border-radius: 7px;
  background: var(--live-md-code-bg, #f4f1ea);
  color: var(--live-md-code-text, #2f3437);
  padding: 1em 1.1em;
  box-shadow:
    inset 0 1px var(--live-md-code-border, #ddd6ca),
    inset 0 -1px var(--live-md-code-border, #ddd6ca),
    inset 1px 0 var(--live-md-code-border, #ddd6ca),
    inset -1px 0 var(--live-md-code-border, #ddd6ca);
}

.${liveMdMarkdownDocumentClass} pre code {
  display: block;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  padding: 0;
  font-size: 0.88em;
  line-height: 1.55;
}

.${liveMdMarkdownDocumentClass} img {
  display: block;
  width: auto;
  max-width: 100%;
  height: auto;
  object-fit: contain;
  border: 1px solid var(--live-md-border, #d5dcd8);
  border-radius: 8px;
}

.${liveMdMarkdownDocumentClass} .cm-md-latex {
  color: var(--live-md-latex, #142723);
}

.${liveMdMarkdownDocumentClass} .cm-md-latex-inline {
  display: inline-block;
  max-width: 100%;
  vertical-align: -0.05em;
}

.${liveMdMarkdownDocumentClass} .cm-md-latex-inline .katex {
  font-size: 1em;
}

.${liveMdMarkdownDocumentClass} .cm-md-latex-display {
  display: block;
  max-width: 100%;
  margin: 0.55em 0 1.05em;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.15em 0;
}

.${liveMdMarkdownDocumentClass} .cm-md-latex-display .katex-display {
  margin: 0;
}

.${liveMdMarkdownDocumentClass} .cm-md-latex.is-error {
  border-bottom: 1px dotted var(--live-md-error-border, #b64d3c);
  color: var(--live-md-error, #9b392b);
  font-family: var(--live-md-font-code, "SFMono-Regular", "Cascadia Code", ui-monospace, monospace);
  font-size: 0.86em;
}

.${liveMdMarkdownDocumentClass} .cm-md-mermaid {
  display: block;
  max-width: 100%;
  accent-color: var(--live-md-mermaid-accent, var(--live-md-accent, #0f766e));
  border: 1px solid var(--live-md-mermaid-border, var(--live-md-border, #d5dcd8));
  border-radius: 8px;
  background: var(--live-md-mermaid-surface, var(--live-md-surface, #fffaf0));
  color: var(--live-md-mermaid-text, var(--live-md-text, #202523));
  overflow: auto;
  padding: 0.9em;
}

.${liveMdMarkdownDocumentClass} .cm-md-mermaid-render {
  min-width: max-content;
}

.${liveMdMarkdownDocumentClass} .cm-md-mermaid svg {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}

.${liveMdMarkdownDocumentClass} .cm-md-mermaid-message {
  color: var(--live-md-mermaid-muted, var(--live-md-muted, #66706c));
  font-family: var(--live-md-mermaid-font, var(--live-md-font-ui, "Avenir Next", "Gill Sans", ui-sans-serif, system-ui, sans-serif));
  font-size: 0.82em;
}

.${liveMdMarkdownDocumentClass} .cm-md-mermaid.is-error {
  border-color: var(--live-md-surface-error-border, #d9aaa0);
  background: var(--live-md-surface-error, #fff7f4);
  color: var(--live-md-error, #9b392b);
}

.${liveMdMarkdownDocumentClass} .cm-md-mermaid.is-error .cm-md-mermaid-message {
  color: var(--live-md-error, #9b392b);
}

.${liveMdMarkdownDocumentClass} .cm-md-table-preview {
  overflow-x: auto;
  border: 1px solid var(--live-md-table-border, #d9e0dc);
  border-radius: 8px;
  background: var(--live-md-table-bg, #fbfcfa);
}

.${liveMdMarkdownDocumentClass} table {
  width: 100%;
  min-width: min(520px, 100%);
  border-collapse: collapse;
  overflow: hidden;
  border: 1px solid var(--live-md-table-border, #d9e0dc);
  border-radius: 8px;
  background: var(--live-md-table-bg, #fbfcfa);
  font-family: var(--live-md-font-ui, "Avenir Next", "Gill Sans", ui-sans-serif, system-ui, sans-serif);
  font-size: 0.86em;
  line-height: 1.45;
}

.${liveMdMarkdownDocumentClass} .cm-md-table-preview table {
  min-width: 520px;
  margin: 0;
  border: 0;
  border-radius: 0;
}

.${liveMdMarkdownDocumentClass} th,
.${liveMdMarkdownDocumentClass} td {
  border-right: 1px solid var(--live-md-table-border, #d9e0dc);
  border-bottom: 1px solid var(--live-md-table-border, #d9e0dc);
  padding: 10px 12px;
  text-align: left;
  vertical-align: top;
}

.${liveMdMarkdownDocumentClass} th:last-child,
.${liveMdMarkdownDocumentClass} td:last-child {
  border-right: 0;
}

.${liveMdMarkdownDocumentClass} tr:last-child td {
  border-bottom: 0;
}

.${liveMdMarkdownDocumentClass} th {
  background: var(--live-md-table-header-bg, #edf3ef);
  color: var(--live-md-table-header-text, #213d37);
  font-weight: 800;
}

.${liveMdMarkdownDocumentClass} td {
  background: color-mix(in srgb, var(--live-md-bg, #fffdfa) 90%, transparent);
}

.${liveMdMarkdownDocumentClass} hr {
  border: 0;
  border-top: 1px solid var(--live-md-rule, #ccd6d1);
  margin: 2em 0;
}

.${liveMdMarkdownDocumentClass} input[type="checkbox"] {
  appearance: none;
  display: inline-block;
  width: 1.05em;
  height: 1.05em;
  margin: 0 0.42em 0 0;
  border: 1.6px solid var(--live-md-task-border, #87958f);
  border-radius: 4px;
  background: var(--live-md-task-bg, #fffefa);
  opacity: 1;
  vertical-align: -0.12em;
}

.${liveMdMarkdownDocumentClass} input[type="checkbox"]:checked {
  border-color: var(--live-md-accent, #0f766e);
  background:
    linear-gradient(135deg, transparent 45%, var(--live-md-task-check, #fff) 45% 55%, transparent 55%),
    linear-gradient(45deg, transparent 37%, var(--live-md-task-check, #fff) 37% 48%, transparent 48%),
    var(--live-md-accent, #0f766e);
}

.${liveMdMarkdownDocumentClass} .live-md-task-item.is-checked {
  color: var(--live-md-task-checked, #7c8581);
}

.${liveMdMarkdownDocumentClass} .live-md-task-item.is-checked strong,
.${liveMdMarkdownDocumentClass} .live-md-task-item.is-checked em {
  color: var(--live-md-task-checked-strong, #6f7874);
}

@media (max-width: 560px) {
  .${liveMdMarkdownDocumentClass} {
    font-size: 16px;
  }
}

@media print {
  .${liveMdMarkdownDocumentClass} {
    width: auto;
    min-height: 0;
    padding: 0;
  }

  .${liveMdMarkdownDocumentClass} pre,
  .${liveMdMarkdownDocumentClass} img,
  .${liveMdMarkdownDocumentClass} table,
  .${liveMdMarkdownDocumentClass} .cm-md-table-preview,
  .${liveMdMarkdownDocumentClass} .cm-md-mermaid,
  .${liveMdMarkdownDocumentClass} .cm-md-latex-display {
    break-inside: avoid;
  }
}`;
}

function markdownHtmlKatexStyles(katexCss: string | null | undefined) {
  return katexCss?.trim() ? katexCss : markdownHtmlFallbackKatexStyles;
}

function normalizeMarkdownLineEndings(markdown: string) {
  return markdown.replace(/\r\n?/g, "\n");
}

async function loadMarkdownHtmlParsers() {
  markdownHtmlParsersPromise ??= loadMarkdownHtmlParsersOnce();
  return markdownHtmlParsersPromise;
}

async function loadMarkdownHtmlParsersOnce(): Promise<MarkdownHtmlParsers> {
  let service = await loadMarkdownParserService();
  return {
    block: service.blockParser,
    inline: service.inlineParser,
  };
}

async function renderBlockChildren(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let parts: string[] = [];
  for (let child of node.namedChildren) {
    let html = await renderBlock(context, child);
    if (html) parts.push(html);
  }
  return parts.join("\n");
}

async function renderBlock(context: MarkdownHtmlRenderContext, node: SyntaxNode): Promise<string> {
  let featureHtml = await renderFeatureHtml(context, node);
  if (featureHtml != null) return featureHtml;
  return renderBlockDefault(context, node);
}

async function renderBlockDefault(
  context: MarkdownHtmlRenderContext,
  node: SyntaxNode,
): Promise<string> {
  switch (node.name) {
    case "document":
    case "section":
      return renderBlockChildren(context, node);
    case "atx_heading":
      return renderHeading(context, node, headingLevel(node));
    case "setext_heading":
      return renderHeading(context, node, headingLevel(node));
    case "paragraph":
      return renderParagraph(context, node);
    case "list":
      return renderList(context, node);
    case "block_quote":
      return renderBlockQuote(context, node);
    case "pipe_table":
      return renderTable(context, node);
    case "thematic_break":
      return "<hr>";
    case "fenced_code_block":
      return renderFencedCodeBlock(context, node);
    case "indented_code_block":
      return renderIndentedCodeBlock(context, node);
    case "html_block":
      return escapeHtml(sliceNode(context, node).trimEnd());
    case "link_reference_definition":
      return "";
    default:
      if (node.namedChildCount) return renderBlockChildren(context, node);
      return escapeHtml(sliceNode(context, node).trim());
  }
}

async function renderFeatureHtml(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let entries = context.featureMatches.get(context.nodeKeys.key(node));
  if (!entries?.length) return null;

  for (let entry of entries) {
    let html = await entry.feature.renderHtml?.(createFeatureHtmlRenderContext(context, entry));
    if (html != null) return html;
  }
  return null;
}

function createFeatureHtmlRenderContext(
  context: MarkdownHtmlRenderContext,
  entry: MarkdownHtmlFeatureMatch,
): LiveMdFeatureHtmlRenderContext {
  return {
    capture: (name) => capture(entry.match, name),
    captures: (name) => captures(entry.match, name),
    match: entry.match,
    node: (name) => capture(entry.match, name)?.node ?? null,
    nodes: (name) => captures(entry.match, name).map((item) => item.node),
    renderChildren: (node = entry.target) => renderBlockChildren(context, node),
    renderDefault: () => renderBlockDefault(context, entry.target),
    renderInline: (sourceOrNode) =>
      typeof sourceOrNode == "string"
        ? renderInlineSource(context, sourceOrNode)
        : renderInlineSyntaxNode(context, sourceOrNode),
    slice: (node) => sliceNode(context, node),
    source: context.source,
    target: entry.target,
  };
}

function collectMarkdownHtmlFeatureMatches(
  features: readonly LiveMdMarkdownFeature[],
  tree: Tree,
  nodeKeys: MarkdownHtmlNodeKeys,
) {
  let matchesByTarget = new Map<string, MarkdownHtmlFeatureMatch[]>();
  let order = 0;

  for (let feature of features) {
    if (!feature.query || !feature.renderHtml) continue;

    let matches = queryTreeMatches(tree, feature.query, {
      includeNested: false,
    });
    for (let match of matches) {
      let target = featureHtmlTarget(match);
      if (!target) continue;
      let key = nodeKeys.key(target);
      let entries = matchesByTarget.get(key);
      if (!entries) {
        entries = [];
        matchesByTarget.set(key, entries);
      }
      entries.push({ feature, match, order, target });
      order++;
    }
  }

  for (let entries of matchesByTarget.values()) {
    entries.sort((left, right) => left.order - right.order);
  }
  return matchesByTarget;
}

function featureHtmlTarget(match: TreeSitterQueryMatch) {
  return (
    capture(match, "html")?.node ??
    capture(match, "feature")?.node ??
    match.captures[0]?.node ??
    null
  );
}

function createMarkdownHtmlNodeKeys(): MarkdownHtmlNodeKeys {
  let nextTreeId = 1;
  let treeIds = new WeakMap<Tree, number>();
  return {
    key(node) {
      let treeId = treeIds.get(node.tree);
      if (treeId == null) {
        treeId = nextTreeId;
        nextTreeId++;
        treeIds.set(node.tree, treeId);
      }
      return `${treeId}:${node.name}:${node.id}:${node.from}:${node.to}`;
    },
  };
}

async function renderHeading(context: MarkdownHtmlRenderContext, node: SyntaxNode, level: number) {
  let content = node.childForFieldName("heading_content");
  if (!content) {
    content = node.namedChildren.find((child) => child.name == "inline") ?? null;
  }
  let html = content ? await renderHeadingContent(context, content) : "";
  return `<h${level}>${html}</h${level}>`;
}

async function renderHeadingContent(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  if (node.name == "paragraph") return renderParagraphContents(context, node);
  if (node.name == "inline" || node.name == "pipe_table_cell") {
    return renderInlineSyntaxNode(context, node);
  }
  return renderBlockChildren(context, node);
}

function headingLevel(node: SyntaxNode) {
  for (let child of node.namedChildren) {
    let atx = /^atx_h([1-6])_marker$/.exec(child.name);
    if (atx) return Number(atx[1]);
    if (child.name == "setext_h1_underline") return 1;
    if (child.name == "setext_h2_underline") return 2;
  }
  return 1;
}

async function renderParagraph(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let latex = readParagraphBlockLatex(context, node);
  if (latex) return renderLatexHtml({ ...latex, block: true });

  let contents = await renderParagraphContents(context, node);
  return contents ? `<p>${contents}</p>` : "";
}

async function renderParagraphContents(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let inlineNodes = node.namedChildren.filter((child) => child.name == "inline");
  if (!inlineNodes.length) return escapeHtml(sliceNode(context, node).trim());

  let parts: string[] = [];
  for (let inline of inlineNodes) parts.push(await renderInlineSyntaxNode(context, inline));
  return parts.join("\n");
}

async function renderList(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let items = node.namedChildren.filter((child) => child.name == "list_item");
  let firstMarker = items.length ? listItemMarker(items[0]!) : null;
  let ordered = !!firstMarker && isOrderedListMarker(firstMarker);
  let tag = ordered ? "ol" : "ul";
  let start = ordered && firstMarker ? orderedListStart(context, firstMarker) : 1;
  let startAttribute = ordered && start != 1 ? ` start="${start}"` : "";
  let renderedItems: string[] = [];
  for (let item of items) renderedItems.push(await renderListItem(context, item));
  return `<${tag}${startAttribute}>\n${renderedItems.join("\n")}\n</${tag}>`;
}

async function renderListItem(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let children = node.namedChildren.filter(
    (child) =>
      !isListMarker(child) && !isTaskListMarker(child) && child.name != "block_continuation",
  );
  let taskMarker = node.namedChildren.find(isTaskListMarker);
  let taskChecked = taskMarker?.name == "task_list_marker_checked";
  let itemClassAttribute = taskMarker
    ? ` class="live-md-task-item${taskChecked ? " is-checked" : ""}"`
    : "";
  let taskPrefix = taskMarker ? renderTaskCheckbox(taskChecked) : "";

  if (children.length == 1 && children[0]!.name == "paragraph") {
    return `<li${itemClassAttribute}>${taskPrefix}${await renderParagraphContents(context, children[0]!)}</li>`;
  }

  let parts: string[] = [];
  let usedTaskPrefix = false;
  for (let child of children) {
    if (child.name == "paragraph") {
      let prefix = usedTaskPrefix ? "" : taskPrefix;
      usedTaskPrefix = true;
      parts.push(`<p>${prefix}${await renderParagraphContents(context, child)}</p>`);
    } else {
      if (taskPrefix && !usedTaskPrefix) {
        parts.push(taskPrefix.trimEnd());
        usedTaskPrefix = true;
      }
      parts.push(await renderBlock(context, child));
    }
  }
  if (taskPrefix && !usedTaskPrefix) parts.unshift(taskPrefix.trimEnd());
  return `<li${itemClassAttribute}>\n${parts.filter(Boolean).join("\n")}\n</li>`;
}

function renderTaskCheckbox(checked: boolean) {
  return checked
    ? '<input checked="" disabled="" type="checkbox"> '
    : '<input disabled="" type="checkbox"> ';
}

async function renderBlockQuote(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let parts: string[] = [];
  for (let child of node.namedChildren) {
    if (child.name == "block_quote_marker") continue;
    let html = await renderBlock(context, child);
    if (html) parts.push(html);
  }
  return `<blockquote>\n${parts.join("\n")}\n</blockquote>`;
}

async function renderTable(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let header = firstNamedChild(node, "pipe_table_header");
  let delimiter = firstNamedChild(node, "pipe_table_delimiter_row");
  if (!header || !delimiter) return `<p>${escapeHtml(sliceNode(context, node).trim())}</p>`;

  let headerCells = tableCells(header);
  let alignments = tableDelimiterCells(delimiter).map(tableAlignment);
  let columnCount = Math.max(headerCells.length, alignments.length);
  let headerHtml = await renderTableRow(context, "th", headerCells, alignments, columnCount);
  let bodyRows: string[] = [];
  for (let row of node.namedChildren.filter((child) => child.name == "pipe_table_row")) {
    bodyRows.push(await renderTableRow(context, "td", tableCells(row), alignments, columnCount));
  }

  let body = bodyRows.length ? `\n<tbody>\n${bodyRows.join("\n")}\n</tbody>` : "";
  return `<div class="cm-md-table-preview">\n<table>\n<thead>\n${headerHtml}\n</thead>${body}\n</table>\n</div>`;
}

async function renderTableRow(
  context: MarkdownHtmlRenderContext,
  tag: "td" | "th",
  cells: readonly SyntaxNode[],
  alignments: readonly TableAlignment[],
  columnCount: number,
) {
  let rendered: string[] = [];
  for (let index = 0; index < columnCount; index++) {
    let alignment = alignments[index] ?? "default";
    let attribute = tableAlignmentAttribute(alignment);
    let content = cells[index] ? await renderTableCell(context, cells[index]!) : "";
    rendered.push(`<${tag}${attribute}>${content}</${tag}>`);
  }
  return `<tr>${rendered.join("")}</tr>`;
}

async function renderTableCell(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  return renderInlineSource(context, sliceNode(context, node).trim());
}

function tableCells(node: SyntaxNode) {
  return node.namedChildren.filter((child) => child.name == "pipe_table_cell");
}

function tableDelimiterCells(node: SyntaxNode) {
  return node.namedChildren.filter((child) => child.name == "pipe_table_delimiter_cell");
}

function tableAlignment(node: SyntaxNode): TableAlignment {
  let left = node.namedChildren.some((child) => child.name == "pipe_table_align_left");
  let right = node.namedChildren.some((child) => child.name == "pipe_table_align_right");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "default";
}

function tableAlignmentAttribute(alignment: TableAlignment) {
  return alignment == "default" ? "" : ` style="text-align: ${alignment}"`;
}

function readParagraphBlockLatex(
  context: MarkdownHtmlRenderContext,
  node: SyntaxNode,
): LatexFormula | null {
  let formula = readLatexFormulaFromSource(sliceNode(context, node).trim(), true);
  return formula?.displayMode ? formula : null;
}

async function renderFencedCodeBlock(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let language = readFenceLanguage(context, node);
  let code = firstNamedChild(node, "code_fence_content");
  let source = code ? sliceNode(context, code) : "";
  if (isMermaidFenceLanguage(language)) return renderMermaidFence(source);

  let classAttribute = language ? ` class="language-${escapeAttribute(language)}"` : "";
  return `<pre><code${classAttribute}>${escapeHtml(source)}</code></pre>`;
}

function renderIndentedCodeBlock(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let code = sliceNode(context, node).replace(/^(?: {1,4}|\t)/gm, "");
  return `<pre><code>${escapeHtml(code)}</code></pre>`;
}

async function renderMermaidFence(source: string) {
  let diagramSource = source.replace(/\s+$/u, "");
  if (!diagramSource.trim()) return renderMermaidErrorHtml(diagramSource, "Empty Mermaid diagram");

  let rendered = await renderLiveMdMermaidResult(diagramSource);
  if (!rendered.ok) return renderMermaidErrorHtml(diagramSource, rendered.message);
  let sanitized = sanitizeMermaidSvg(rendered.svg);
  if (!sanitized.ok) return renderMermaidErrorHtml(diagramSource, sanitized.message);

  return `<div class="cm-md-mermaid" data-source="${escapeAttribute(diagramSource)}">\n<div class="cm-md-mermaid-render">${sanitized.svg}</div>\n</div>`;
}

function renderMermaidErrorHtml(source: string, message: string | null) {
  let titleAttribute = message ? ` title="${escapeAttribute(message)}"` : "";
  return `<div class="cm-md-mermaid is-error" data-source="${escapeAttribute(source)}"${titleAttribute}><span class="cm-md-mermaid-message">Unable to render Mermaid diagram</span></div>`;
}

type SanitizedMermaidSvg =
  | {
      ok: true;
      svg: string;
    }
  | {
      message: string;
      ok: false;
    };

const svgNamespace = "http://www.w3.org/2000/svg";

const safeMermaidSvgElements = new Set([
  "a",
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "feblend",
  "fecolormatrix",
  "fecomposite",
  "fedropshadow",
  "feflood",
  "fegaussianblur",
  "femerge",
  "femergenode",
  "feoffset",
  "filter",
  "g",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "style",
  "svg",
  "symbol",
  "text",
  "textpath",
  "title",
  "tspan",
  "use",
]);

const safeMermaidSvgAttributes = new Set([
  "accent-height",
  "alignment-baseline",
  "baseline-shift",
  "clip-path",
  "clip-rule",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "cx",
  "cy",
  "d",
  "direction",
  "display",
  "dominant-baseline",
  "dx",
  "dy",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "flood-color",
  "flood-opacity",
  "font-family",
  "font-size",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "height",
  "href",
  "id",
  "letter-spacing",
  "marker-end",
  "marker-mid",
  "marker-start",
  "markerheight",
  "markerunits",
  "markerwidth",
  "mask",
  "offset",
  "opacity",
  "orient",
  "overflow",
  "paint-order",
  "pathlength",
  "patterncontentunits",
  "patternunits",
  "points",
  "preserveaspectratio",
  "r",
  "refx",
  "refy",
  "rx",
  "ry",
  "shape-rendering",
  "spreadmethod",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "style",
  "tabindex",
  "target",
  "text-anchor",
  "text-decoration",
  "text-rendering",
  "transform",
  "vector-effect",
  "viewbox",
  "visibility",
  "width",
  "x",
  "x1",
  "x2",
  "xlink:href",
  "xmlns",
  "xmlns:xlink",
  "y",
  "y1",
  "y2",
]);

const safeMermaidSvgStyleProperties = new Set([
  "alignment-baseline",
  "baseline-shift",
  "clip-path",
  "clip-rule",
  "color",
  "display",
  "dominant-baseline",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "flood-color",
  "flood-opacity",
  "font-family",
  "font-size",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "letter-spacing",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "opacity",
  "overflow",
  "paint-order",
  "shape-rendering",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "text-decoration",
  "text-rendering",
  "transform",
  "vector-effect",
  "visibility",
]);

function sanitizeMermaidSvg(svg: string): SanitizedMermaidSvg {
  if (typeof DOMParser == "undefined" || typeof XMLSerializer == "undefined") {
    return { message: "SVG sanitizer is unavailable", ok: false };
  }

  let parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror")) {
    return { message: "Unable to parse Mermaid SVG", ok: false };
  }
  if (parsed.documentElement.localName.toLowerCase() != "svg") {
    return { message: "Mermaid renderer returned non-SVG output", ok: false };
  }

  let sanitized = sanitizeSvgElement(parsed, parsed.documentElement);
  if (!sanitized) return { message: "Unable to sanitize Mermaid SVG", ok: false };
  return {
    ok: true,
    svg: new XMLSerializer().serializeToString(sanitized),
  };
}

function sanitizeSvgElement(owner: Document, element: Element): Element | null {
  let elementName = element.localName.toLowerCase();
  if (!safeMermaidSvgElements.has(elementName)) return null;

  let sanitized = owner.createElementNS(svgNamespace, element.localName);
  for (let attribute of Array.from(element.attributes)) {
    let safeAttribute = sanitizeSvgAttribute(attribute, elementName);
    if (!safeAttribute) continue;
    if (attribute.namespaceURI) {
      sanitized.setAttributeNS(attribute.namespaceURI, attribute.name, safeAttribute.value);
    } else {
      sanitized.setAttribute(attribute.name, safeAttribute.value);
    }
  }

  if (elementName == "style") {
    let styleText = sanitizeSvgStyleText(element.textContent ?? "");
    if (!styleText) return null;
    sanitized.textContent = styleText;
    return sanitized;
  }

  for (let child of Array.from(element.childNodes)) {
    let sanitizedChild = sanitizeSvgNode(owner, child);
    if (sanitizedChild) sanitized.append(sanitizedChild);
  }
  return sanitized;
}

function sanitizeSvgNode(owner: Document, node: ChildNode) {
  if (node.nodeType == 1 && node instanceof Element) return sanitizeSvgElement(owner, node);
  if (node.nodeType == 3 || node.nodeType == 4) {
    return owner.createTextNode(node.textContent ?? "");
  }
  return null;
}

function sanitizeSvgAttribute(attribute: Attr, elementName: string) {
  let name = attribute.name;
  let lowerName = name.toLowerCase();
  if (lowerName.startsWith("on")) return null;
  if (lowerName.startsWith("aria-") || lowerName.startsWith("data-")) {
    return isSafeSvgAttributeValue(attribute.value) ? { name, value: attribute.value } : null;
  }
  if (!safeMermaidSvgAttributes.has(lowerName)) return null;

  if (lowerName == "style") {
    let value = sanitizeSvgStyleAttribute(attribute.value);
    return value ? { name, value } : null;
  }
  if (lowerName == "href" || lowerName == "xlink:href") {
    return isSafeSvgHref(attribute.value, elementName) ? { name, value: attribute.value } : null;
  }
  return isSafeSvgAttributeValue(attribute.value) ? { name, value: attribute.value } : null;
}

function sanitizeSvgStyleAttribute(style: string) {
  let declarations: string[] = [];
  for (let declaration of style.split(";")) {
    let separator = declaration.indexOf(":");
    if (separator <= 0) continue;
    let property = declaration.slice(0, separator).trim();
    let value = declaration.slice(separator + 1).trim();
    if (!isSafeSvgStyleProperty(property) || !isSafeSvgCssValue(value)) continue;
    declarations.push(`${property}: ${value}`);
  }
  return declarations.join("; ");
}

function sanitizeSvgStyleText(css: string) {
  let sanitized = css.replace(/@import[^;]+;?/giu, "");
  if (containsUnsafeSvgCss(sanitized)) return null;
  return sanitized.trim();
}

function isSafeSvgStyleProperty(property: string) {
  let normalized = property.toLowerCase();
  return /^--[a-z0-9_-]+$/u.test(normalized) || safeMermaidSvgStyleProperties.has(normalized);
}

function isSafeSvgAttributeValue(value: string) {
  return !containsUnsafeSvgCss(value);
}

function isSafeSvgCssValue(value: string) {
  return value.length > 0 && !containsUnsafeSvgCss(value);
}

function containsUnsafeSvgCss(value: string) {
  let compact = compactSvgSecurityValue(value);
  if (
    compact.includes("javascript:") ||
    compact.includes("vbscript:") ||
    compact.includes("data:text/html") ||
    compact.includes("expression(") ||
    compact.includes("<")
  ) {
    return true;
  }
  if (/@(?!supports\b)[a-z-]+/iu.test(value)) return true;
  return !svgCssUrlsAreSafe(value);
}

function svgCssUrlsAreSafe(value: string) {
  for (let match of value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/giu)) {
    let url = match[2]?.trim() ?? "";
    if (!url.startsWith("#")) return false;
  }
  return true;
}

function isSafeSvgHref(value: string, elementName: string) {
  let trimmed = value.trim();
  let compact = compactSvgSecurityValue(trimmed);
  if (!compact) return true;
  if (compact.startsWith("#")) return true;
  return (
    elementName == "a" &&
    (compact.startsWith("https://") ||
      compact.startsWith("http://") ||
      compact.startsWith("mailto:") ||
      compact.startsWith("tel:"))
  );
}

function compactSvgSecurityValue(value: string) {
  let compact = "";
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index);
    if (code <= 0x20 || code == 0x7f) continue;
    compact += value[index]!.toLowerCase();
  }
  return compact;
}

function readFenceLanguage(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let language = firstNamedChild(firstNamedChild(node, "info_string"), "language");
  return language ? normalizeFenceLanguage(sliceNode(context, language)) : "";
}

function normalizeFenceLanguage(language: string) {
  let token = firstToken(language.trim());
  if (token.startsWith("{")) token = token.slice(1);
  if (token.startsWith(".")) token = token.slice(1);
  if (token.endsWith("}")) token = token.slice(0, -1);
  return token.toLowerCase();
}

function isMermaidFenceLanguage(language: string) {
  return language == "mermaid" || language == "mmd";
}

function firstToken(value: string) {
  return /^\S*/u.exec(value)?.[0] ?? "";
}

async function renderInlineSyntaxNode(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  return renderInlineSource(context, inlineSyntaxNodeSource(context, node));
}

async function renderInlineSource(context: MarkdownHtmlRenderContext, source: string) {
  if (!source) return "";
  return withLiveMdParserTree(context.inlineParser, Text.of(source.split("\n")), (tree) =>
    renderInlineChildren({ options: context.options, source }, tree.topNode),
  );
}

function inlineSyntaxNodeSource(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let parts: string[] = [];
  let position = node.from;
  for (let child of node.children) {
    if (child.name != "block_continuation") continue;
    parts.push(context.text.sliceString(position, child.from));
    position = child.to;
  }
  parts.push(context.text.sliceString(position, node.to));
  return parts.join("");
}

async function renderInlineChildren(context: InlineRenderContext, node: SyntaxNode) {
  let parts: string[] = [];
  let position = node.from;
  for (let child of node.children) {
    if (child.from > position) parts.push(escapeHtml(context.source.slice(position, child.from)));
    parts.push(await renderInlineNode(context, child));
    position = child.to;
  }
  if (position < node.to) parts.push(escapeHtml(context.source.slice(position, node.to)));
  return parts.join("");
}

async function renderInlineNode(context: InlineRenderContext, node: SyntaxNode): Promise<string> {
  switch (node.name) {
    case "inline":
    case "link_text":
    case "image_description":
      return renderInlineChildren(context, node);
    case "strong_emphasis":
      return `<strong>${await renderInlineChildren(context, node)}</strong>`;
    case "emphasis":
      return `<em>${await renderInlineChildren(context, node)}</em>`;
    case "strikethrough":
      return renderStrikethrough(context, node);
    case "code_span":
      return renderCodeSpan(context, node);
    case "inline_link":
      return renderInlineLink(context, node);
    case "image":
      return renderImage(context, node);
    case "uri_autolink":
      return renderAutolink(context, node, false);
    case "email_autolink":
      return renderAutolink(context, node, true);
    case "hard_line_break":
      return "<br>\n";
    case "backslash_escape":
      return escapeHtml(context.source.slice(node.from + 1, node.to));
    case "entity_reference":
    case "numeric_character_reference":
      return context.source.slice(node.from, node.to);
    case "html_tag":
      return escapeHtml(context.source.slice(node.from, node.to));
    case "latex_block":
      return renderInlineLatex(context, node);
    case "block_continuation":
    case "code_span_delimiter":
    case "emphasis_delimiter":
    case "latex_span_delimiter":
      return "";
    default:
      if (node.childCount) return renderInlineChildren(context, node);
      return escapeHtml(context.source.slice(node.from, node.to));
  }
}

function renderInlineLatex(context: InlineRenderContext, node: SyntaxNode) {
  let formula = readInlineLatexFormula(context, node);
  return formula ? renderLatexHtml(formula) : escapeHtml(context.source.slice(node.from, node.to));
}

function renderLatexHtml(formula: LatexFormula) {
  let tag = formula.block ? "div" : "span";
  let className = formula.displayMode
    ? "cm-md-latex cm-md-latex-display"
    : "cm-md-latex cm-md-latex-inline";
  let rendered = renderMarkdownHtmlLatexFormula(formula);
  if (rendered.ok) {
    return `<${tag} class="${className}" data-source="${escapeAttribute(formula.source)}">${rendered.html}</${tag}>`;
  }

  let titleAttribute = rendered.message ? ` title="${escapeAttribute(rendered.message)}"` : "";
  return `<${tag} class="${className} is-error" data-source="${escapeAttribute(formula.source)}"${titleAttribute}>${escapeHtml(formula.source)}</${tag}>`;
}

function renderMarkdownHtmlLatexFormula(formula: LatexFormula) {
  return renderStrictLatexFormula(formula);
}

function readInlineLatexFormula(
  context: InlineRenderContext,
  node: SyntaxNode,
): LatexFormula | null {
  let delimiters = node.children.filter((child) => child.name == "latex_span_delimiter");
  let opening = delimiters[0];
  let closing = delimiters.at(-1);
  if (!opening || !closing || opening == closing) return null;

  let source = context.source.slice(node.from, node.to);
  let openingText = context.source.slice(opening.from, opening.to);
  let closingText = context.source.slice(closing.from, closing.to);
  let tex = context.source.slice(opening.to, closing.from).trim();
  if (!tex) return null;

  return {
    block: false,
    displayMode: openingText.length > 1 || closingText.length > 1 || tex.includes("\n"),
    source,
    tex,
  };
}

function readLatexFormulaFromSource(source: string, block: boolean): LatexFormula | null {
  let delimiter = source.startsWith("$$") ? "$$" : source.startsWith("$") ? "$" : null;
  if (!delimiter || !source.endsWith(delimiter) || source.length <= delimiter.length * 2) {
    return null;
  }

  let tex = source.slice(delimiter.length, -delimiter.length).trim();
  if (!tex) return null;

  return {
    block,
    displayMode: delimiter.length > 1 || tex.includes("\n"),
    source,
    tex,
  };
}

async function renderStrikethrough(context: InlineRenderContext, node: SyntaxNode) {
  let nested = node.namedChildren.find((child) => child.name == "strikethrough");
  return `<del>${await renderInlineChildren(context, nested ?? node)}</del>`;
}

function renderCodeSpan(context: InlineRenderContext, node: SyntaxNode) {
  let delimiters = node.children.filter((child) => child.name == "code_span_delimiter");
  let from = delimiters[0]?.to ?? node.from;
  let to = delimiters.at(-1)?.from ?? node.to;
  return `<code>${escapeHtml(context.source.slice(from, to).replace(/\s+/g, " "))}</code>`;
}

async function renderInlineLink(context: InlineRenderContext, node: SyntaxNode) {
  let text = firstNamedChild(node, "link_text");
  let destination = firstNamedChild(node, "link_destination");
  let title = firstNamedChild(node, "link_title");
  let label = text ? await renderInlineChildren(context, text) : "";
  let href = sanitizeLiveMdLinkDestination(
    destination ? context.source.slice(destination.from, destination.to) : null,
  );
  if (!href) return label;

  let titleText = title ? normalizeLinkTitle(context.source.slice(title.from, title.to)) : null;
  let titleAttribute = titleText ? ` title="${escapeAttribute(titleText)}"` : "";
  return `<a href="${escapeAttribute(href)}"${titleAttribute}>${label}</a>`;
}

async function renderImage(context: InlineRenderContext, node: SyntaxNode) {
  let description = firstNamedChild(node, "image_description");
  let destination = firstNamedChild(node, "link_destination");
  if (!destination) return escapeHtml(context.source.slice(node.from, node.to));

  let alt = description ? plainInlineChildren(context, description) : "";
  let source = normalizeLinkDestination(context.source.slice(destination.from, destination.to));
  let title = firstNamedChild(node, "link_title");
  let titleText = title ? normalizeLinkTitle(context.source.slice(title.from, title.to)) : null;
  let resolved = await context.options.resolveImageSource?.({ alt, source, title: titleText });
  let titleAttribute = titleText ? ` title="${escapeAttribute(titleText)}"` : "";
  return `<img src="${escapeAttribute(resolved ?? source)}" alt="${escapeAttribute(alt)}"${titleAttribute}>`;
}

function renderAutolink(context: InlineRenderContext, node: SyntaxNode, email: boolean) {
  let value = context.source.slice(node.from + 1, node.to - 1);
  let href = sanitizeLiveMdLinkDestination(email ? `mailto:${value}` : value);
  if (!href) return escapeHtml(value);
  return `<a href="${escapeAttribute(href)}">${escapeHtml(value)}</a>`;
}

function plainInlineChildren(context: InlineRenderContext, node: SyntaxNode): string {
  let parts: string[] = [];
  let position = node.from;
  for (let child of node.children) {
    if (child.from > position) parts.push(context.source.slice(position, child.from));
    parts.push(plainInlineNode(context, child));
    position = child.to;
  }
  if (position < node.to) parts.push(context.source.slice(position, node.to));
  return parts.join("");
}

function plainInlineNode(context: InlineRenderContext, node: SyntaxNode): string {
  switch (node.name) {
    case "inline":
    case "link_text":
    case "image_description":
    case "strong_emphasis":
    case "emphasis":
    case "strikethrough":
      return plainInlineChildren(context, node);
    case "code_span":
      return context.source.slice(
        node.children[0]?.to ?? node.from,
        node.children.at(-1)?.from ?? node.to,
      );
    case "image":
      return plainInlineChildren(context, firstNamedChild(node, "image_description") ?? node);
    case "backslash_escape":
      return context.source.slice(node.from + 1, node.to);
    case "entity_reference":
    case "numeric_character_reference":
      return context.source.slice(node.from, node.to);
    case "latex_block": {
      let formula = readInlineLatexFormula(context, node);
      return formula?.tex ?? context.source.slice(node.from, node.to);
    }
    case "block_continuation":
    case "code_span_delimiter":
    case "emphasis_delimiter":
    case "latex_span_delimiter":
      return "";
    default:
      if (node.childCount) return plainInlineChildren(context, node);
      return context.source.slice(node.from, node.to);
  }
}

function normalizeLinkDestination(source: string) {
  let destination = source.trim();
  if (destination.startsWith("<") && destination.endsWith(">")) {
    destination = destination.slice(1, -1);
  }
  return unescapeMarkdownPunctuation(destination);
}

function normalizeLinkTitle(source: string) {
  let title = source.trim();
  let first = title[0];
  let last = title.at(-1);
  if (
    (first == '"' && last == '"') ||
    (first == "'" && last == "'") ||
    (first == "(" && last == ")")
  ) {
    title = title.slice(1, -1);
  }
  return unescapeMarkdownPunctuation(title);
}

function unescapeMarkdownPunctuation(value: string) {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

function firstNamedChild(node: SyntaxNode | null, name: string) {
  return node?.namedChildren.find((child) => child.name == name) ?? null;
}

function capture(match: TreeSitterQueryMatch, name: string): TreeSitterQueryCapture | null {
  return match.captures.find((item) => item.name == name) ?? null;
}

function captures(match: TreeSitterQueryMatch, name: string): TreeSitterQueryCapture[] {
  return match.captures.filter((item) => item.name == name);
}

function listItemMarker(node: SyntaxNode) {
  return node.namedChildren.find(isListMarker) ?? null;
}

function isListMarker(node: SyntaxNode) {
  return (
    node.name == "list_marker_dot" ||
    node.name == "list_marker_minus" ||
    node.name == "list_marker_parenthesis" ||
    node.name == "list_marker_plus" ||
    node.name == "list_marker_star"
  );
}

function isOrderedListMarker(node: SyntaxNode) {
  return node.name == "list_marker_dot" || node.name == "list_marker_parenthesis";
}

function isTaskListMarker(node: SyntaxNode) {
  return node.name == "task_list_marker_checked" || node.name == "task_list_marker_unchecked";
}

function orderedListStart(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let marker = sliceNode(context, node).match(/\d+/)?.[0];
  return marker ? Number(marker) : 1;
}

function sliceNode(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  return context.text.sliceString(node.from, node.to);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}
