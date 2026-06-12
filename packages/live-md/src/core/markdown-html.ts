import { Text } from "@codemirror/state";
import type { SyntaxNode, TreeSitterParser } from "@codemirror-treesitter/language";
import { languages } from "@codemirror-treesitter/language-data";

export type MarkdownHtmlImage = {
  alt: string;
  source: string;
  title: string | null;
};

export type MarkdownHtmlImageSourceResolver = (
  image: MarkdownHtmlImage,
) => Promise<string | null | undefined> | string | null | undefined;

export type MarkdownHtmlRenderOptions = {
  resolveImageSource?: MarkdownHtmlImageSourceResolver | null;
};

export const liveMdMarkdownDocumentClass = "live-md-document";

export const liveMdMarkdownDocumentCssVariables = [
  "--live-md-bg",
  "--live-md-text",
  "--live-md-muted",
  "--live-md-accent",
  "--live-md-accent-2",
  "--live-md-list-marker",
  "--live-md-border",
  "--live-md-code-bg",
  "--live-md-code-text",
  "--live-md-code-muted",
  "--live-md-code-border",
  "--live-md-cursor",
  "--live-md-selection",
  "--live-md-active-line",
  "--live-md-syntax",
  "--live-md-heading-1",
  "--live-md-heading-2",
  "--live-md-heading-3",
  "--live-md-heading-rest",
  "--live-md-inline-code-bg",
  "--live-md-inline-code-text",
  "--live-md-inline-code-border",
  "--live-md-link",
  "--live-md-link-underline",
  "--live-md-latex",
  "--live-md-error",
  "--live-md-error-border",
  "--live-md-surface",
  "--live-md-surface-error",
  "--live-md-surface-error-border",
  "--live-md-blockquote",
  "--live-md-blockquote-border",
  "--live-md-ordered-marker",
  "--live-md-task-border",
  "--live-md-task-bg",
  "--live-md-task-check",
  "--live-md-task-checked",
  "--live-md-task-checked-strong",
  "--live-md-rule",
  "--live-md-table-line-bg",
  "--live-md-table-divider",
  "--live-md-table-pipe",
  "--live-md-table-bg",
  "--live-md-table-border",
  "--live-md-table-header-bg",
  "--live-md-table-header-text",
  "--live-md-content-width",
  "--live-md-content-padding-block-start",
  "--live-md-content-padding-inline",
  "--live-md-content-padding-block-end",
  "--live-md-font-body",
  "--live-md-font-ui",
  "--live-md-font-code",
  "--live-md-mermaid-bg",
  "--live-md-mermaid-text",
  "--live-md-mermaid-muted",
  "--live-md-mermaid-line",
  "--live-md-mermaid-accent",
  "--live-md-mermaid-border",
  "--live-md-mermaid-surface",
  "--live-md-mermaid-font",
  "--live-md-mermaid-mono-font",
] as const;

type MarkdownHtmlParsers = {
  block: MarkdownHtmlBlockParser;
  inline: MarkdownHtmlInlineParser;
};

type MarkdownHtmlBlockParser = Pick<TreeSitterParser, "parse"> & {
  nestedParsers: readonly { parser: unknown }[];
};

type MarkdownHtmlInlineParser = Pick<TreeSitterParser, "parse">;

type MarkdownHtmlRenderContext = {
  inlineParser: MarkdownHtmlInlineParser;
  options: MarkdownHtmlRenderOptions;
  text: Text;
};

type InlineRenderContext = {
  options: MarkdownHtmlRenderOptions;
  source: string;
};

type TableAlignment = "center" | "default" | "left" | "right";

let markdownHtmlParsersPromise: Promise<MarkdownHtmlParsers> | null = null;

export async function renderMarkdownToHtml(
  markdown: string,
  options: MarkdownHtmlRenderOptions = {},
): Promise<string> {
  let parsers = await loadMarkdownHtmlParsers();
  let source = normalizeMarkdownLineEndings(markdown);
  let text = Text.of(source.split("\n"));
  let tree = parsers.block.parse(text);
  let context: MarkdownHtmlRenderContext = {
    inlineParser: parsers.inline,
    options,
    text,
  };
  return renderBlockChildren(context, tree.topNode);
}

export function liveMdMarkdownDocumentCss() {
  return `.${liveMdMarkdownDocumentClass} {
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
.${liveMdMarkdownDocumentClass} figure {
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
  border: 1px solid var(--live-md-code-border, #ddd6ca);
  border-radius: 8px;
  background: var(--live-md-code-bg, #f4f1ea);
  color: var(--live-md-code-text, #2f3437);
  padding: 1em 1.1em;
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
  border: 1px solid var(--live-md-border, #d5dcd8);
  border-radius: 8px;
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
  .${liveMdMarkdownDocumentClass} table {
    break-inside: avoid;
  }
}`;
}

function normalizeMarkdownLineEndings(markdown: string) {
  return markdown.replace(/\r\n?/g, "\n");
}

async function loadMarkdownHtmlParsers() {
  markdownHtmlParsersPromise ??= loadMarkdownHtmlParsersOnce();
  return markdownHtmlParsersPromise;
}

async function loadMarkdownHtmlParsersOnce(): Promise<MarkdownHtmlParsers> {
  let description = languages.find((language) => language.name == "Markdown");
  if (!description) throw new Error("Markdown language support is unavailable");

  let support = await description.load();
  let block = (support.language as { parser?: unknown }).parser;
  if (!isMarkdownHtmlBlockParser(block)) {
    throw new Error("Markdown language support is not tree-sitter backed");
  }

  let inline = block.nestedParsers.map((source) => source.parser).find(isMarkdownHtmlInlineParser);
  if (!inline) throw new Error("Markdown inline parser is unavailable");

  return {
    block,
    inline,
  };
}

function isMarkdownHtmlBlockParser(value: unknown): value is MarkdownHtmlBlockParser {
  return (
    isMarkdownHtmlInlineParser(value) &&
    Array.isArray((value as { nestedParsers?: unknown }).nestedParsers)
  );
}

function isMarkdownHtmlInlineParser(value: unknown): value is MarkdownHtmlInlineParser {
  return (
    typeof value == "object" &&
    value != null &&
    typeof (value as { parse?: unknown }).parse == "function"
  );
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
  return `<table>\n<thead>\n${headerHtml}\n</thead>${body}\n</table>`;
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

function renderFencedCodeBlock(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let language = firstNamedChild(firstNamedChild(node, "info_string"), "language");
  let code = firstNamedChild(node, "code_fence_content");
  let classAttribute = language
    ? ` class="language-${escapeAttribute(sliceNode(context, language).trim())}"`
    : "";
  return `<pre><code${classAttribute}>${escapeHtml(code ? sliceNode(context, code) : "")}</code></pre>`;
}

function renderIndentedCodeBlock(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  let code = sliceNode(context, node).replace(/^(?: {1,4}|\t)/gm, "");
  return `<pre><code>${escapeHtml(code)}</code></pre>`;
}

async function renderInlineSyntaxNode(context: MarkdownHtmlRenderContext, node: SyntaxNode) {
  return renderInlineSource(context, inlineSyntaxNodeSource(context, node));
}

async function renderInlineSource(context: MarkdownHtmlRenderContext, source: string) {
  if (!source) return "";
  let tree = context.inlineParser.parse(Text.of(source.split("\n")));
  return renderInlineChildren({ options: context.options, source }, tree.topNode);
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
  let href = destination
    ? normalizeLinkDestination(context.source.slice(destination.from, destination.to))
    : "";
  let titleText = title ? normalizeLinkTitle(context.source.slice(title.from, title.to)) : null;
  let titleAttribute = titleText ? ` title="${escapeAttribute(titleText)}"` : "";
  return `<a href="${escapeAttribute(href)}"${titleAttribute}>${text ? await renderInlineChildren(context, text) : ""}</a>`;
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
  let href = email ? `mailto:${value}` : value;
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
