import { Text, type EditorState } from "@codemirror/state";
import {
  highlightTree,
  type SyntaxNode,
  type TreeSitterQueryMatch,
} from "@codemirror-treesitter/language";
import { Decoration } from "@codemirror/view";
import { capture } from "../analysis/query.js";
import { type CodeFenceHighlightTree, type LiveMdBuild } from "../analysis/types.js";
import { forEachLineInRange, isWhitespace } from "../util.js";
import { MermaidWidget, type MermaidDiagram } from "../widgets.js";
import { addLineClass, addMark, addReplace, addSyntax, rangeTouchesActiveLine } from "./emit.js";

export function applyCodeFence(build: LiveMdBuild, match: TreeSitterQueryMatch): false {
  let node = capture(match, "codeFence")?.node;
  let openingDelimiter = capture(match, "codeFence.open")?.node;
  if (!node || !openingDelimiter) return false;

  let closingDelimiter = capture(match, "codeFence.close")?.node ?? null;
  let content = capture(match, "codeFence.content")?.node;
  let language = readFenceLanguage(build.state, capture(match, "codeFence.language")?.node);

  if (content && content.from < content.to) {
    let diagram = readMermaidDiagram(build.state, content, language);
    if (diagram && !rangeTouchesActiveLine(build, node.from, node.to)) {
      addReplace(build, node.from, node.to, new MermaidWidget(diagram), true);
      return false;
    }
  }

  let openingLineNumber = build.state.doc.lineAt(openingDelimiter.from).number;
  let blockEndLineNumber = openingLineNumber;

  addLineClass(build, openingLineNumber, "cm-md-code-fence-line");
  addLineClass(build, openingLineNumber, "cm-md-code-block-start");
  addSyntax(build, openingDelimiter.from, openingDelimiter.to);

  if (content && content.from < content.to) {
    forEachLineInRange(build.state, content.from, content.to, (line) => {
      addLineClass(build, line.number, "cm-md-code-line");
      blockEndLineNumber = line.number;
    });
    addCodeFenceHighlights(build, content.from, content.to, language);
  }

  if (closingDelimiter) {
    let closingLineNumber = build.state.doc.lineAt(closingDelimiter.from).number;
    blockEndLineNumber = closingLineNumber;
    addLineClass(build, closingLineNumber, "cm-md-code-fence-line");
    addSyntax(build, closingDelimiter.from, closingDelimiter.to);
  }

  addLineClass(build, blockEndLineNumber, "cm-md-code-block-end");
  return false;
}

function readFenceLanguage(state: EditorState, languageNode?: SyntaxNode) {
  if (!languageNode) return "";
  return normalizeFenceLanguage(state.sliceDoc(languageNode.from, languageNode.to));
}

function normalizeFenceLanguage(language: string) {
  let token = firstToken(language.trim());
  if (token.startsWith("{")) token = token.slice(1);
  if (token.startsWith(".")) token = token.slice(1);
  if (token.endsWith("}")) token = token.slice(0, -1);
  return token.toLowerCase();
}

function readMermaidDiagram(
  state: EditorState,
  content: SyntaxNode,
  language: string,
): MermaidDiagram | null {
  if (!isMermaidFenceLanguage(language)) return null;
  let source = state.sliceDoc(content.from, content.to).replace(/\s+$/u, "");
  return source.trim() ? { source } : null;
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

function addCodeFenceHighlights(
  build: LiveMdBuild,
  contentFrom: number,
  contentTo: number,
  language: string,
) {
  let highlight = getCodeFenceHighlight(build, contentFrom, contentTo, language);
  if (!highlight) return;

  let { sourceText, tree } = highlight;

  highlightTree(
    tree,
    build.codeFenceHighlighters,
    (from, to, className) => {
      let decoration = Decoration.mark({ class: className });
      splitTextRangeByLine(sourceText, from, to, (rangeFrom, rangeTo) => {
        addMark(build, contentFrom + rangeFrom, contentFrom + rangeTo, decoration);
      });
    },
    0,
    sourceText.length,
  );
}

function getCodeFenceHighlight(
  build: LiveMdBuild,
  contentFrom: number,
  contentTo: number,
  language: string,
) {
  let parser = build.codeFenceLanguages.get(language);
  if (!parser || contentFrom >= contentTo) return null;

  let sourceText = codeFenceSourceText(build.state, contentFrom, contentTo);
  let tree = parser.parse(sourceText);
  let highlight: CodeFenceHighlightTree = {
    contentFrom,
    contentTo,
    language,
    parser,
    sourceText,
    tree,
  };
  build.codeFenceHighlightTrees.push(highlight);
  return highlight;
}

function codeFenceSourceText(state: EditorState, contentFrom: number, contentTo: number) {
  return Text.of(state.sliceDoc(contentFrom, contentTo).split("\n"));
}

function splitTextRangeByLine(
  text: Text,
  from: number,
  to: number,
  visit: (from: number, to: number) => void,
) {
  let cursor = from;
  while (cursor < to) {
    let line = text.lineAt(cursor);
    let rangeTo = Math.min(to, line.to);
    if (cursor < rangeTo) visit(cursor, rangeTo);
    cursor = line.to < to ? line.to + 1 : to;
  }
}
