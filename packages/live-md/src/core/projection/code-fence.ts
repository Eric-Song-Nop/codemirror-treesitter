import { Text, type EditorState } from "@codemirror/state";
import { type SyntaxNode, type TreeSitterQueryMatch } from "@codemirror-treesitter/language";
import { Decoration } from "@codemirror/view";
import { capture } from "../analysis/query.js";
import {
  cachedLiveMdCodeFenceHighlightResult,
  cachedLiveMdMermaidRequest,
  liveMdFullQueryRenderKey,
} from "../runtime/render-cache.js";
import { forEachLineInRange, isWhitespace } from "../util.js";
import { MermaidWidget, type MermaidDiagram } from "../widgets.js";
import { addLineClass, addMark, addReplace, addSyntax, rangeTouchesActiveLine } from "./emit.js";
import { type LiveMdBuild } from "./types.js";

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
      addReplace(
        build,
        node.from,
        node.to,
        new MermaidWidget(
          cachedLiveMdMermaidRequest(
            build.renderCache,
            build.trace,
            liveMdFullQueryRenderKey,
            diagram.source,
          ),
        ),
        true,
      );
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
    addCodeFenceHighlights(
      build,
      content.from,
      content.to,
      content.from,
      content.to,
      language,
      liveMdFullQueryRenderKey,
    );
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

export function addCodeFenceHighlights(
  build: LiveMdBuild,
  contentFrom: number,
  contentTo: number,
  emitFrom: number,
  emitTo: number,
  language: string,
  recordRenderKey: string,
) {
  if (contentFrom >= contentTo) return;

  let source = build.state.sliceDoc(contentFrom, contentTo);
  let sourceText = Text.of(source.split("\n"));
  let result = cachedLiveMdCodeFenceHighlightResult(
    build.renderCache,
    build.trace,
    source,
    build.codeFenceLanguages,
    build.codeFenceHighlighters,
    recordRenderKey,
    language,
  );
  let emitRelativeFrom = Math.max(0, emitFrom - contentFrom);
  let emitRelativeTo = Math.min(sourceText.length, emitTo - contentFrom);
  if (emitRelativeFrom >= emitRelativeTo) return;

  for (let span of result.spans) {
    let from = Math.max(span.from, emitRelativeFrom);
    let to = Math.min(span.to, emitRelativeTo);
    if (from >= to) continue;
    let decoration = Decoration.mark({ class: span.className });
    splitTextRangeByLine(sourceText, from, to, (rangeFrom, rangeTo) => {
      addMark(build, contentFrom + rangeFrom, contentFrom + rangeTo, decoration);
    });
  }
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
