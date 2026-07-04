import { type EditorState } from "@codemirror/state";
import { type SyntaxNode, type TreeSitterQueryMatch } from "@codemirror-treesitter/language";
import { Decoration } from "@codemirror/view";
import {
  capture,
  captureKey,
  isInsideSkippedRange,
  matchKind,
  nodeKey,
  sortedNodes,
} from "../analysis/query.js";
import { readTableFromCaptures } from "../analysis/tables.js";
import { type CapturedTable, type DocRange } from "../analysis/types.js";
import { liveMdLinkMark } from "../links.js";
import {
  cachedLiveMdImageSource,
  cachedLiveMdLatexResult,
  cachedLiveMdTableResult,
  liveMdFullQueryRenderKey,
} from "../runtime/render-cache.js";
import { isWhitespaceOnly } from "../util.js";
import {
  ImagePreviewWidget,
  LatexWidget,
  ListMarkerWidget,
  TablePreviewWidget,
  TaskCheckboxWidget,
  type LatexFormula,
} from "../widgets.js";
import { applyCodeFence } from "./code-fence.js";
import {
  addLineClass,
  addLineRangeClass,
  addMark,
  addReplace,
  addSyntax,
  isOnlyVisibleContentOnLine,
  rangeTouchesActiveSource,
  rangeTouchesActiveLine,
  tableTouchesActiveLine,
} from "./emit.js";
import { type LiveMdBuild } from "./types.js";

const strongMark = Decoration.mark({ class: "cm-md-strong" });
const emphasisMark = Decoration.mark({ class: "cm-md-emphasis" });
const strikeMark = Decoration.mark({ class: "cm-md-strike" });
const inlineCodeMark = Decoration.mark({ class: "cm-md-inline-code" });
const tablePipeMark = Decoration.mark({ class: "cm-md-table-pipe" });

type SimpleCaptureHandler = (build: LiveMdBuild, node: SyntaxNode) => void;

const simpleCaptureHandlers: Record<string, SimpleCaptureHandler> = {
  blockquote: (build, node) => addLineRangeClass(build, node.from, node.to, "cm-md-blockquote"),
  "list.item": (build, node) => addLineRangeClass(build, node.from, node.to, "cm-md-list-line"),
  "list.marker": applyListMarker,
  "mark.emphasis": (build, node) => addMark(build, node.from, node.to, emphasisMark),
  "mark.inlineCode": (build, node) => addMark(build, node.from, node.to, inlineCodeMark),
  "mark.strike": (build, node) => addMark(build, node.from, node.to, strikeMark),
  "mark.strong": (build, node) => addMark(build, node.from, node.to, strongMark),
  syntax: (build, node) => addSyntax(build, node.from, node.to),
  "task.checked": (build, node) => applyTaskMarker(build, node, true),
  "task.unchecked": (build, node) => applyTaskMarker(build, node, false),
  uriAutolink: applyUriAutolink,
};

export function processLiveMdMatch(
  build: LiveMdBuild,
  match: TreeSitterQueryMatch,
  tables: ReadonlyMap<string, CapturedTable>,
  processed: Set<string>,
  skipped: readonly DocRange[],
): false | void {
  switch (matchKind(match)) {
    case "codeFence":
      return applyCodeFence(build, match);
    case "heading":
      return applyHeadingMatch(build, match);
    case "image":
      return applyImage(build, match);
    case "latex":
      return applyLatex(build, match);
    case "link":
      return applyInlineLink(build, match);
    case "rule": {
      let node = capture(match, "rule")?.node;
      if (node) return applyRule(build, node);
      return;
    }
    case "table":
      return applyTable(build, match, tables, processed);
  }

  for (let item of match.captures) {
    if (isInsideSkippedRange(item.node, skipped)) continue;
    let handler = simpleCaptureHandlers[item.name];
    if (!handler) continue;
    let key = captureKey(item);
    if (processed.has(key)) continue;
    processed.add(key);
    handler(build, item.node);
  }
}

function applyHeadingMatch(build: LiveMdBuild, match: TreeSitterQueryMatch) {
  let node = capture(match, "heading")?.node;
  if (!node) return;
  let level = Number(match.setProperties?.["heading.level"]) || 1;
  applyHeading(build, node, level, capture(match, "heading.marker")?.node);
}

function applyHeading(build: LiveMdBuild, node: SyntaxNode, level: number, marker?: SyntaxNode) {
  addLineRangeClass(build, node.from, node.to, "cm-md-heading");
  addLineRangeClass(build, node.from, node.to, `cm-md-heading-${level}`);
  if (marker) addSyntax(build, marker.from, marker.to);
}

function applyListMarker(build: LiveMdBuild, node: SyntaxNode) {
  let line = build.state.doc.lineAt(node.from);
  addLineClass(build, line.number, "cm-md-list-line");
  if (rangeTouchesActiveSource(build, node.from, node.to)) {
    addSyntax(build, node.from, node.to);
  } else {
    addReplace(
      build,
      node.from,
      node.to,
      new ListMarkerWidget(build.state.sliceDoc(node.from, node.to).trim()),
    );
  }
}

function applyTaskMarker(build: LiveMdBuild, node: SyntaxNode, checked: boolean) {
  let line = build.state.doc.lineAt(node.from);
  addLineClass(build, line.number, "cm-md-list-line");
  addLineClass(build, line.number, "cm-md-task-line");
  if (checked) addLineClass(build, line.number, "is-checked");
  if (rangeTouchesActiveSource(build, node.from, node.to)) {
    addSyntax(build, node.from, node.to);
  } else {
    addReplace(build, node.from, node.to, new TaskCheckboxWidget(checked));
  }
}

function applyRule(build: LiveMdBuild, node: SyntaxNode): false {
  addLineRangeClass(build, node.from, node.to, "cm-md-rule-line");
  addSyntax(build, node.from, node.to);
  return false;
}

function applyInlineLink(build: LiveMdBuild, match: TreeSitterQueryMatch) {
  let node = capture(match, "link")?.node;
  let text = capture(match, "link.text")?.node;
  let destination = capture(match, "link.destination")?.node;
  if (!node) return;
  if (!text) return;
  addSyntax(build, node.from, text.from);
  addMark(
    build,
    text.from,
    text.to,
    liveMdLinkMark(
      destination ? build.state.sliceDoc(destination.from, destination.to) : null,
      build.linkBaseUrl,
    ),
  );
  addSyntax(build, text.to, node.to);
}

function applyUriAutolink(build: LiveMdBuild, node: SyntaxNode) {
  if (node.to - node.from <= 2) return;
  addSyntax(build, node.from, node.from + 1);
  addMark(
    build,
    node.from + 1,
    node.to - 1,
    liveMdLinkMark(build.state.sliceDoc(node.from + 1, node.to - 1), build.linkBaseUrl),
  );
  addSyntax(build, node.to - 1, node.to);
}

function applyImage(build: LiveMdBuild, match: TreeSitterQueryMatch): false | void {
  let node = capture(match, "image")?.node;
  if (!node) return false;
  let description = capture(match, "image.description")?.node;
  let destination = capture(match, "image.destination")?.node;
  let alt = description ? build.state.sliceDoc(description.from, description.to) : "";
  let src = destination ? build.state.sliceDoc(destination.from, destination.to).trim() : "";
  if (!src) return false;

  let line = build.state.doc.lineAt(node.from);
  let active = rangeTouchesActiveLine(build, node.from, node.to);
  let image = cachedLiveMdImageSource(
    build.renderCache,
    build.trace,
    liveMdFullQueryRenderKey,
    src,
    build.imageSourceResolver,
  );
  let block =
    !active && isOnlyVisibleContentOnLine(build.state, line.from, line.to, node.from, node.to);
  let widget = new ImagePreviewWidget(alt, image, build.renderCache.measuredHeights, block);
  if (block) {
    addReplace(build, line.from, line.to, widget, true);
    return false;
  }

  if (!active) {
    addReplace(build, node.from, node.to, widget);
    return false;
  }

  if (description) {
    addSyntax(build, node.from, description.from);
    addMark(build, description.from, description.to, liveMdLinkMark(null, build.linkBaseUrl));
    addSyntax(build, description.to, node.to);
  }
  return false;
}

function applyLatex(build: LiveMdBuild, match: TreeSitterQueryMatch): false | void {
  let node = capture(match, "latex")?.node;
  let openingDelimiter = capture(match, "latex.open")?.node;
  let closingDelimiter = capture(match, "latex.close")?.node;
  if (!node || !openingDelimiter || !closingDelimiter) return false;
  let formula = readLatexFormula(build.state, node, openingDelimiter, closingDelimiter);
  if (!formula) return false;
  if (rangeTouchesActiveLine(build, node.from, node.to)) return;

  let range = latexReplacementRange(build.state, node, formula.displayMode);
  let cachedFormula = { ...formula, block: range.block };
  addReplace(
    build,
    range.from,
    range.to,
    new LatexWidget(
      cachedFormula,
      cachedLiveMdLatexResult(
        build.renderCache,
        build.trace,
        liveMdFullQueryRenderKey,
        cachedFormula,
      ),
      build.renderCache.measuredHeights,
    ),
    range.block,
  );
  return false;
}

function applyTable(
  build: LiveMdBuild,
  match: TreeSitterQueryMatch,
  tables: ReadonlyMap<string, CapturedTable>,
  processed: Set<string>,
): false | void {
  let tableCapture = capture(match, "table");
  if (!tableCapture) return;
  let node = tableCapture.node;
  let key = `table:${nodeKey(node)}`;
  if (processed.has(key)) return;
  processed.add(key);

  let captured = tables.get(nodeKey(node));
  let table = captured ? readTableFromCaptures(build.state, captured) : null;
  if (table && !tableTouchesActiveLine(build, node.from, node.to, table)) {
    let result = cachedLiveMdTableResult(
      build.renderCache,
      build.trace,
      liveMdFullQueryRenderKey,
      table,
    );
    addReplace(
      build,
      node.from,
      node.to,
      new TablePreviewWidget(
        result.table,
        build.renderCache.measuredHeights,
        result.resultKey,
        build.linkBaseUrl,
        build.imageSourceResolver,
      ),
      true,
    );
    return false;
  }

  addLineRangeClass(build, node.from, node.to, "cm-md-table-line");
  if (captured?.delimiterRow) {
    addLineRangeClass(
      build,
      captured.delimiterRow.from,
      captured.delimiterRow.to,
      "cm-md-table-divider",
    );
  }
  for (let pipe of sortedNodes(captured?.pipes.values())) {
    addSyntax(build, pipe.from, pipe.to, tablePipeMark);
  }
}

function readLatexFormula(
  state: EditorState,
  node: SyntaxNode,
  openingDelimiter: SyntaxNode,
  closingDelimiter: SyntaxNode,
): Omit<LatexFormula, "block"> | null {
  if (!openingDelimiter || !closingDelimiter || openingDelimiter == closingDelimiter) return null;

  let source = state.sliceDoc(node.from, node.to);
  let opening = state.sliceDoc(openingDelimiter.from, openingDelimiter.to);
  let closing = state.sliceDoc(closingDelimiter.from, closingDelimiter.to);
  let tex = state.sliceDoc(openingDelimiter.to, closingDelimiter.from).trim();
  if (!tex) return null;

  return {
    displayMode: opening.length > 1 || closing.length > 1 || tex.includes("\n"),
    source,
    tex,
  };
}

function latexReplacementRange(state: EditorState, node: SyntaxNode, displayMode: boolean) {
  if (!displayMode) return { block: false, from: node.from, to: node.to };

  let firstLine = state.doc.lineAt(node.from);
  let lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1));
  if (
    isWhitespaceOnly(state.sliceDoc(firstLine.from, node.from)) &&
    isWhitespaceOnly(state.sliceDoc(node.to, lastLine.to))
  ) {
    return { block: true, from: firstLine.from, to: lastLine.to };
  }

  return { block: false, from: node.from, to: node.to };
}
