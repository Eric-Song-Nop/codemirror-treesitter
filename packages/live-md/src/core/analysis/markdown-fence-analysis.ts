import { type Text } from "@codemirror/state";
import { type SyntaxNode } from "@codemirror-treesitter/language";
import { isWhitespace } from "../util.js";
import { type LiveMdDescriptor } from "./descriptors.js";

export function analyzeMarkdownFenceDescriptor(
  doc: Text,
  node: SyntaxNode,
): LiveMdDescriptor | null {
  let delimiters = node.children.filter((child) => child.name == "fenced_code_block_delimiter");
  let openingDelimiter = delimiters[0];
  if (!openingDelimiter) return null;

  let closingDelimiter = delimiters.length > 1 ? delimiters.at(-1)! : null;
  let content = node.children.find((child) => child.name == "code_fence_content") ?? null;
  let language = readFenceLanguage(doc, findFenceLanguageNode(node));
  let mermaidSource =
    closingDelimiter && content && content.from < content.to
      ? readMermaidSource(doc, content, language)
      : null;
  let replacementRange =
    mermaidSource && closingDelimiter
      ? {
          block: true,
          from: openingDelimiter.from,
          to: doc.lineAt(closingDelimiter.from).to,
        }
      : null;

  return {
    closingDelimiterRange: closingDelimiter ? nodeRange(closingDelimiter) : null,
    contentRange: content ? nodeRange(content) : null,
    kind: "codeFence",
    language,
    mermaidSource,
    openingDelimiterRange: nodeRange(openingDelimiter),
    range: nodeRange(node),
    replacementRange,
  };
}

function findFenceLanguageNode(node: SyntaxNode) {
  let info = node.children.find((child) => child.name == "info_string");
  return info?.children.find((child) => child.name == "language") ?? null;
}

function readFenceLanguage(doc: Text, languageNode: SyntaxNode | null) {
  if (!languageNode) return "";
  return normalizeFenceLanguage(doc.sliceString(languageNode.from, languageNode.to));
}

function normalizeFenceLanguage(language: string) {
  let token = firstToken(language.trim());
  if (token.startsWith("{")) token = token.slice(1);
  if (token.startsWith(".")) token = token.slice(1);
  if (token.endsWith("}")) token = token.slice(0, -1);
  return token.toLowerCase();
}

function readMermaidSource(doc: Text, content: SyntaxNode, language: string) {
  if (!isMermaidFenceLanguage(language)) return null;
  let source = doc.sliceString(content.from, content.to).replace(/\s+$/u, "");
  return source.trim() ? source : null;
}

function isMermaidFenceLanguage(language: string) {
  return language == "mermaid" || language == "mmd";
}

function firstToken(value: string) {
  for (let index = 0; index < value.length; index++) {
    if (isWhitespace(value.charCodeAt(index))) return value.slice(0, index);
  }
  return value;
}

function nodeRange(node: SyntaxNode) {
  return { from: node.from, to: node.to };
}
