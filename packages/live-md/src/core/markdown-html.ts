import { Text } from "@codemirror/state";
import {
  TreeSitterLanguage,
  TreeSitterParser,
  type SyntaxNode,
} from "@codemirror-treesitter/language";
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

type MarkdownHtmlParsers = {
  block: TreeSitterParser;
  inline: TreeSitterParser;
};

type MarkdownHtmlRenderContext = {
  inlineParser: TreeSitterParser;
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
  if (!(support.language instanceof TreeSitterLanguage)) {
    throw new Error("Markdown language support is not tree-sitter backed");
  }

  let inline = support.language.parser.nestedParsers
    .map((source) => source.parser)
    .find((parser): parser is TreeSitterParser => parser instanceof TreeSitterParser);
  if (!inline) throw new Error("Markdown inline parser is unavailable");

  return {
    block: support.language.parser,
    inline,
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
  let taskPrefix = taskMarker
    ? renderTaskCheckbox(taskMarker.name == "task_list_marker_checked")
    : "";

  if (children.length == 1 && children[0]!.name == "paragraph") {
    return `<li>${taskPrefix}${await renderParagraphContents(context, children[0]!)}</li>`;
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
  return `<li>\n${parts.filter(Boolean).join("\n")}\n</li>`;
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
