import { Text } from "@codemirror/state";
import { type SyntaxNode, type Tree } from "@codemirror-treesitter/language";
import { deleteLiveMdTree, type LiveMdMarkdownParserService } from "../languages.js";
import {
  type LiveMdInlineContent,
  type LiveMdInlineNode,
  type LiveMdTableCellModel,
} from "./descriptors.js";

export type MarkdownInlineRenderSession = {
  dispose(): void;
  renderCell(source: string): LiveMdTableCellModel;
};

type InlineRenderContext = {
  source: string;
};

export function createMarkdownInlineRenderSession(
  service: LiveMdMarkdownParserService,
): MarkdownInlineRenderSession {
  let parser = service.inlineParser.createParser();
  let disposed = false;

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      parser.delete();
    },
    renderCell(source) {
      if (disposed) throw new RangeError("Markdown inline render session has been disposed");
      return {
        inline: renderInlineContent(service, parser, source),
        text: source,
      };
    },
  };
}

function renderInlineContent(
  service: LiveMdMarkdownParserService,
  parser: ReturnType<LiveMdMarkdownParserService["inlineParser"]["createParser"]>,
  source: string,
): LiveMdInlineContent {
  if (!source) return [];

  let text = Text.of(source.split("\n"));
  let parsed = service.inlineParser.parseWith(parser, text);
  if (!parsed) return [{ kind: "text", text: source }];

  let tree: Tree | null = null;
  try {
    tree = service.inlineParser.wrapTree(parsed, text);
    if (!tree) return [{ kind: "text", text: source }];
    return renderInlineChildren({ source }, tree.topNode);
  } finally {
    if (tree) deleteLiveMdTree(tree);
    else parsed.delete();
  }
}

function renderInlineChildren(context: InlineRenderContext, node: SyntaxNode): LiveMdInlineContent {
  let parts: LiveMdInlineNode[] = [];
  let position = node.from;
  for (let child of node.children) {
    if (child.from > position) {
      appendText(parts, context.source.slice(position, child.from));
    }
    parts.push(...renderInlineNode(context, child));
    position = child.to;
  }
  if (position < node.to) appendText(parts, context.source.slice(position, node.to));
  return parts;
}

function renderInlineNode(context: InlineRenderContext, node: SyntaxNode): LiveMdInlineContent {
  switch (node.name) {
    case "inline":
    case "link_text":
    case "image_description":
      return renderInlineChildren(context, node);
    case "strong_emphasis":
      return [{ children: renderInlineChildren(context, node), kind: "strong" }];
    case "emphasis":
      return [{ children: renderInlineChildren(context, node), kind: "emphasis" }];
    case "strikethrough":
      return renderStrikethrough(context, node);
    case "code_span":
      return [{ kind: "inlineCode", text: codeSpanText(context, node) }];
    case "inline_link":
      return [renderInlineLink(context, node)];
    case "image":
      return [renderImage(context, node)];
    case "uri_autolink":
      return [renderAutolink(context, node, false)];
    case "email_autolink":
      return [renderAutolink(context, node, true)];
    case "hard_line_break":
      return [{ kind: "hardBreak" }];
    case "backslash_escape":
      return [{ kind: "text", text: context.source.slice(node.from + 1, node.to) }];
    case "entity_reference":
    case "numeric_character_reference":
      return [{ kind: "text", text: context.source.slice(node.from, node.to) }];
    case "html_tag":
      return [{ kind: "text", text: context.source.slice(node.from, node.to) }];
    case "latex_block":
      return renderLatex(context, node);
    case "block_continuation":
    case "code_span_delimiter":
    case "emphasis_delimiter":
    case "latex_span_delimiter":
      return [];
    default:
      if (node.childCount) return renderInlineChildren(context, node);
      return [{ kind: "text", text: context.source.slice(node.from, node.to) }];
  }
}

function renderStrikethrough(context: InlineRenderContext, node: SyntaxNode): LiveMdInlineContent {
  let nested = node.namedChildren.find((child) => child.name == "strikethrough");
  return [{ children: renderInlineChildren(context, nested ?? node), kind: "strike" }];
}

function codeSpanText(context: InlineRenderContext, node: SyntaxNode) {
  let delimiters = node.children.filter((child) => child.name == "code_span_delimiter");
  let from = delimiters[0]?.to ?? node.from;
  let to = delimiters.at(-1)?.from ?? node.to;
  return context.source.slice(from, to).replace(/\s+/g, " ");
}

function renderInlineLink(context: InlineRenderContext, node: SyntaxNode): LiveMdInlineNode {
  let text = firstNamedChild(node, "link_text");
  let destination = firstNamedChild(node, "link_destination");
  let title = firstNamedChild(node, "link_title");
  return {
    children: text ? renderInlineChildren(context, text) : [],
    destination: destination
      ? normalizeMarkdownDestination(context.source.slice(destination.from, destination.to))
      : null,
    kind: "link",
    title: title ? normalizeMarkdownTitle(context.source.slice(title.from, title.to)) : null,
  };
}

function renderImage(context: InlineRenderContext, node: SyntaxNode): LiveMdInlineNode {
  let description = firstNamedChild(node, "image_description");
  let destination = firstNamedChild(node, "link_destination");
  let title = firstNamedChild(node, "link_title");
  if (!destination) {
    return { kind: "text", text: context.source.slice(node.from, node.to) };
  }
  return {
    alt: description ? plainInlineChildren(context, description) : "",
    kind: "image",
    source: normalizeMarkdownDestination(context.source.slice(destination.from, destination.to)),
    title: title ? normalizeMarkdownTitle(context.source.slice(title.from, title.to)) : null,
  };
}

function renderAutolink(
  context: InlineRenderContext,
  node: SyntaxNode,
  email: boolean,
): LiveMdInlineNode {
  let value = context.source.slice(node.from + 1, node.to - 1);
  return {
    children: [{ kind: "text", text: value }],
    destination: email ? `mailto:${value}` : value,
    kind: "link",
    title: null,
  };
}

function renderLatex(context: InlineRenderContext, node: SyntaxNode): LiveMdInlineContent {
  let delimiters = node.children.filter((child) => child.name == "latex_span_delimiter");
  let opening = delimiters[0];
  let closing = delimiters.at(-1);
  if (!opening || !closing || opening == closing) {
    return [{ kind: "text", text: context.source.slice(node.from, node.to) }];
  }
  let tex = context.source.slice(opening.to, closing.from).trim();
  if (!tex) return [{ kind: "text", text: context.source.slice(node.from, node.to) }];
  let openingText = context.source.slice(opening.from, opening.to);
  let closingText = context.source.slice(closing.from, closing.to);
  return [
    {
      displayMode: openingText.length > 1 || closingText.length > 1 || tex.includes("\n"),
      kind: "latex",
      source: context.source.slice(node.from, node.to),
      tex,
    },
  ];
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

function appendText(parts: LiveMdInlineNode[], text: string) {
  if (!text) return;
  let previous = parts.at(-1);
  if (previous?.kind == "text") {
    previous.text += text;
  } else {
    parts.push({ kind: "text", text });
  }
}

function normalizeMarkdownDestination(source: string) {
  let destination = source.trim();
  if (destination.startsWith("<") && destination.endsWith(">")) {
    destination = destination.slice(1, -1).trim();
  }
  return unescapeMarkdownPunctuation(destination);
}

function normalizeMarkdownTitle(source: string) {
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
