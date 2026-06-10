import { type EditorState } from "@codemirror/state";
import { type SyntaxNode } from "@codemirror-treesitter/language";
import { Decoration } from "@codemirror/view";
import { liveMdLinkMark } from "./links.js";
import { forEachLineInRange, isWhitespace, isWhitespaceOnly } from "./util.js";
import {
  ImagePreviewWidget,
  LatexWidget,
  ListMarkerWidget,
  MermaidWidget,
  TablePreviewWidget,
  TaskCheckboxWidget,
  type LatexFormula,
  type MarkdownTable,
  type MermaidDiagram,
} from "./widgets.js";
import {
  type LiveMdFeature,
  type LiveMdFeatureContext,
  type LiveMdFeatureMatch,
} from "./features.js";

type ParagraphContainerKind = "block" | "document" | "list" | "listItem";

type ParagraphContainer = {
  children: SyntaxNode[];
  kind: ParagraphContainerKind;
  node: SyntaxNode;
};

type CapturedTable = {
  delimiterCells: Map<string, CapturedTableDelimiterCell>;
  delimiterRow: SyntaxNode | null;
  headerCells: Map<string, SyntaxNode>;
  node: SyntaxNode;
  pipes: Map<string, SyntaxNode>;
  rows: Map<string, CapturedTableRow>;
};

type CapturedTableDelimiterCell = {
  left: boolean;
  node: SyntaxNode;
  right: boolean;
};

type CapturedTableRow = {
  cells: Map<string, SyntaxNode>;
  node: SyntaxNode;
};

const strongMark = Decoration.mark({ class: "cm-md-strong" });
const emphasisMark = Decoration.mark({ class: "cm-md-emphasis" });
const strikeMark = Decoration.mark({ class: "cm-md-strike" });
const inlineCodeMark = Decoration.mark({ class: "cm-md-inline-code" });
const tablePipeMark = Decoration.mark({ class: "cm-md-table-pipe" });

function collectParagraphContainer(
  context: LiveMdFeatureContext,
  match: LiveMdFeatureMatch,
  containers: Map<string, ParagraphContainer>,
) {
  let containerCapture = context.capture(match, "paragraph.container");
  let childCapture = context.capture(match, "paragraph.child");
  let kind = match.setProperties?.["paragraph.kind"];
  if (!containerCapture || !childCapture || typeof kind != "string") return;
  if (!isParagraphContainerKind(kind)) return;

  let key = context.nodeKey(containerCapture.node);
  let container = containers.get(key);
  if (!container) {
    container = { children: [], kind, node: containerCapture.node };
    containers.set(key, container);
  }
  container.children.push(childCapture.node);
}

function collectTable(
  context: LiveMdFeatureContext,
  match: LiveMdFeatureMatch,
  tables: Map<string, CapturedTable>,
) {
  let tableCapture = context.capture(match, "table");
  if (!tableCapture) return;
  let table = capturedTable(context, tables, tableCapture.node);
  for (let headerCell of context.captures(match, "table.header.cell")) {
    table.headerCells.set(context.nodeKey(headerCell.node), headerCell.node);
  }
  for (let delimiterRow of context.captures(match, "table.delimiter.row")) {
    table.delimiterRow = delimiterRow.node;
  }
  for (let delimiterCell of context.captures(match, "table.delimiter.cell")) {
    let key = context.nodeKey(delimiterCell.node);
    table.delimiterCells.set(key, {
      left: !!context.capture(match, "table.align.left"),
      node: delimiterCell.node,
      right: !!context.capture(match, "table.align.right"),
    });
  }
  for (let rowCapture of context.captures(match, "table.row")) {
    capturedTableRow(context, table, rowCapture.node);
  }
  let rowCapture = context.capture(match, "table.row");
  for (let rowCell of context.captures(match, "table.row.cell")) {
    let row = rowCapture ? capturedTableRow(context, table, rowCapture.node) : null;
    row?.cells.set(context.nodeKey(rowCell.node), rowCell.node);
  }
  for (let pipe of context.captures(match, "table.pipe")) {
    table.pipes.set(context.nodeKey(pipe.node), pipe.node);
  }
}

function capturedTable(
  context: LiveMdFeatureContext,
  tables: Map<string, CapturedTable>,
  node: SyntaxNode,
) {
  let key = context.nodeKey(node);
  let table = tables.get(key);
  if (!table) {
    table = {
      delimiterCells: new Map(),
      delimiterRow: null,
      headerCells: new Map(),
      node,
      pipes: new Map(),
      rows: new Map(),
    };
    tables.set(key, table);
  }
  return table;
}

function capturedTableRow(context: LiveMdFeatureContext, table: CapturedTable, node: SyntaxNode) {
  let key = context.nodeKey(node);
  let row = table.rows.get(key);
  if (!row) {
    row = { cells: new Map(), node };
    table.rows.set(key, row);
  }
  return row;
}

function markParagraphBreaks(
  context: LiveMdFeatureContext,
  containers: ReadonlyMap<string, ParagraphContainer>,
) {
  for (let container of containers.values()) {
    if (container.kind == "listItem") continue;
    let siblings = sortedNodes(container.children);
    let previousFrom =
      container.kind == "list"
        ? (node: SyntaxNode) => blockContainerBreakFrom(context, node, containers)
        : (node: SyntaxNode) => blockBreakFrom(context, node);
    for (let index = 1; index < siblings.length; index++) {
      markParagraphBreakRun(context, previousFrom(siblings[index - 1]!), siblings[index]!.from);
    }
    let last = siblings.at(-1);
    if (last) markParagraphBreakRun(context, previousFrom(last), container.node.to);
  }
}

function blockBreakFrom(context: LiveMdFeatureContext, node: SyntaxNode): number {
  if (node.to <= node.from) return node.to;
  let before = node.to - 1;
  if (context.state.sliceDoc(before, node.to) != "\n") return node.to;
  return context.state.doc.lineAt(before).to;
}

function blockContainerBreakFrom(
  context: LiveMdFeatureContext,
  node: SyntaxNode,
  containers: ReadonlyMap<string, ParagraphContainer>,
) {
  let blocks = sortedNodes(containers.get(context.nodeKey(node))?.children);
  return blocks.length ? blockBreakFrom(context, blocks[blocks.length - 1]!) : node.to;
}

function isParagraphContainerKind(kind: string): kind is ParagraphContainerKind {
  switch (kind) {
    case "block":
    case "document":
    case "list":
    case "listItem":
      return true;
    default:
      return false;
  }
}

function sortedNodes(nodes?: Iterable<SyntaxNode>) {
  return Array.from(nodes ?? []).sort(compareNodes);
}

function compareNodes(left: SyntaxNode, right: SyntaxNode) {
  return left.from - right.from || left.to - right.to || left.name.localeCompare(right.name);
}

function markParagraphBreakRun(context: LiveMdFeatureContext, from: number, to: number) {
  if (from >= to || !isWhitespaceOnly(context.state.sliceDoc(from, to))) return;

  let newlinePositions: number[] = [];
  let source = context.state.sliceDoc(from, to);
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) == 10) newlinePositions.push(from + index);
  }

  let separatorCount = Math.floor(newlinePositions.length / 2);
  if (!separatorCount) return;

  let blankLines: number[] = [];
  forEachLineInRange(context.state, from, to, (line) => {
    if (line.from > from && isWhitespaceOnly(context.state.sliceDoc(line.from, line.to))) {
      blankLines.push(line.number);
    }
  });

  for (let index = 0; index < separatorCount; index++) {
    context.atomic(newlinePositions[index * 2]!, newlinePositions[index * 2 + 1]! + 1);

    let separatorLine = blankLines[index * 2];
    if (separatorLine == null) return;
    context.lineClassAt(separatorLine, "cm-md-block-separator");
  }
}

function applyHeadingMatch(context: LiveMdFeatureContext, match: LiveMdFeatureMatch) {
  let node = context.capture(match, "heading")?.node;
  if (!node) return;
  let level = Number(match.setProperties?.["heading.level"]) || 1;
  applyHeading(context, node, level, context.capture(match, "heading.marker")?.node);
}

function applyHeading(
  context: LiveMdFeatureContext,
  node: SyntaxNode,
  level: number,
  marker?: SyntaxNode,
) {
  context.lineClass(node.from, node.to, "cm-md-heading");
  context.lineClass(node.from, node.to, `cm-md-heading-${level}`);
  if (marker) context.syntax(marker.from, marker.to);
}

function applyListMarker(context: LiveMdFeatureContext, node: SyntaxNode) {
  let line = context.state.doc.lineAt(node.from);
  context.lineClassAt(line.number, "cm-md-list-line");
  if (context.activeLines.has(line.number)) {
    context.syntax(node.from, node.to);
  } else {
    context.replace(
      node.from,
      node.to,
      new ListMarkerWidget(context.state.sliceDoc(node.from, node.to).trim()),
    );
  }
}

function applyTaskMarker(context: LiveMdFeatureContext, node: SyntaxNode, checked: boolean) {
  let line = context.state.doc.lineAt(node.from);
  context.lineClassAt(line.number, "cm-md-list-line");
  context.lineClassAt(line.number, "cm-md-task-line");
  if (checked) context.lineClassAt(line.number, "is-checked");
  context.replace(node.from, node.to, new TaskCheckboxWidget(checked));
}

function applyRule(context: LiveMdFeatureContext, node: SyntaxNode) {
  context.lineClass(node.from, node.to, "cm-md-rule-line");
  context.syntax(node.from, node.to);
  context.consume(node.from, node.to);
}

function applyInlineLink(context: LiveMdFeatureContext, match: LiveMdFeatureMatch) {
  let node = context.capture(match, "link")?.node;
  let text = context.capture(match, "link.text")?.node;
  let destination = context.capture(match, "link.destination")?.node;
  if (!node) return;
  if (!text) return;
  context.syntax(node.from, text.from);
  context.mark(
    text.from,
    text.to,
    liveMdLinkMark(
      destination ? context.state.sliceDoc(destination.from, destination.to) : null,
      context.linkBaseUrl,
    ),
  );
  context.syntax(text.to, node.to);
}

function applyUriAutolink(context: LiveMdFeatureContext, node: SyntaxNode) {
  if (node.to - node.from <= 2) return;
  context.syntax(node.from, node.from + 1);
  context.mark(
    node.from + 1,
    node.to - 1,
    liveMdLinkMark(context.state.sliceDoc(node.from + 1, node.to - 1), context.linkBaseUrl),
  );
  context.syntax(node.to - 1, node.to);
}

function applyImage(context: LiveMdFeatureContext, match: LiveMdFeatureMatch) {
  let node = context.capture(match, "image")?.node;
  if (!node) return;
  let description = context.capture(match, "image.description")?.node;
  let destination = context.capture(match, "image.destination")?.node;
  let alt = description ? context.state.sliceDoc(description.from, description.to) : "";
  let src = destination ? context.state.sliceDoc(destination.from, destination.to).trim() : "";
  if (!src) return;

  let line = context.state.doc.lineAt(node.from);
  let active = context.activeLines.has(line.number);
  let widget = new ImagePreviewWidget(alt, context.resolveImageSource(src));
  if (!active && context.onlyVisibleContentOnLine(line.from, line.to, node.from, node.to)) {
    context.replace(line.from, line.to, widget, true);
    context.consume(line.from, line.to);
    return;
  }

  if (!active) {
    context.replace(node.from, node.to, widget);
    context.consume(node.from, node.to);
    return;
  }

  if (description) {
    context.syntax(node.from, description.from);
    context.mark(description.from, description.to, liveMdLinkMark(null, context.linkBaseUrl));
    context.syntax(description.to, node.to);
  }
  context.consume(node.from, node.to);
}

function applyLatex(context: LiveMdFeatureContext, match: LiveMdFeatureMatch) {
  let node = context.capture(match, "latex")?.node;
  let openingDelimiter = context.capture(match, "latex.open")?.node;
  let closingDelimiter = context.capture(match, "latex.close")?.node;
  if (!node || !openingDelimiter || !closingDelimiter) return;
  let formula = readLatexFormula(context.state, node, openingDelimiter, closingDelimiter);
  if (!formula) return;
  if (context.touchesActiveLine(node.from, node.to)) return;

  let range = latexReplacementRange(context.state, node, formula.displayMode);
  context.replace(
    range.from,
    range.to,
    new LatexWidget({ ...formula, block: range.block }),
    range.block,
  );
  context.consume(range.from, range.to);
}

function applyTable(
  context: LiveMdFeatureContext,
  match: LiveMdFeatureMatch,
  tables: ReadonlyMap<string, CapturedTable>,
) {
  let tableCapture = context.capture(match, "table");
  if (!tableCapture) return;
  let node = tableCapture.node;
  let key = `table:${context.nodeKey(node)}`;
  if (!context.claim(key)) return;

  let captured = tables.get(context.nodeKey(node));
  let table = captured ? readTableFromCaptures(context.state, captured) : null;
  if (table && !tableTouchesActiveLine(context, node.from, node.to, table)) {
    context.replace(node.from, node.to, new TablePreviewWidget(table), true);
    context.consume(node.from, node.to);
    return;
  }

  context.lineClass(node.from, node.to, "cm-md-table-line");
  if (captured?.delimiterRow) {
    context.lineClass(captured.delimiterRow.from, captured.delimiterRow.to, "cm-md-table-divider");
  }
  for (let pipe of sortedNodes(captured?.pipes.values())) {
    context.syntax(pipe.from, pipe.to, tablePipeMark);
  }
  context.consume(node.from, node.to);
}

function applyCodeFence(context: LiveMdFeatureContext, match: LiveMdFeatureMatch) {
  let node = context.capture(match, "codeFence")?.node;
  let openingDelimiter = context.capture(match, "codeFence.open")?.node;
  if (!node || !openingDelimiter) return;

  let closingDelimiter = context.capture(match, "codeFence.close")?.node ?? null;
  let content = context.capture(match, "codeFence.content")?.node;
  let language = readFenceLanguage(
    context.state,
    context.capture(match, "codeFence.language")?.node,
  );

  if (content && content.from < content.to) {
    let diagram = readMermaidDiagram(context.state, content, language);
    if (diagram && !context.touchesActiveLine(node.from, node.to)) {
      context.replace(node.from, node.to, new MermaidWidget(diagram), true);
      context.consume(node.from, node.to);
      return;
    }
  }

  let openingLineNumber = context.state.doc.lineAt(openingDelimiter.from).number;
  let blockEndLineNumber = openingLineNumber;

  context.lineClassAt(openingLineNumber, "cm-md-code-fence-line");
  context.lineClassAt(openingLineNumber, "cm-md-code-block-start");
  context.syntax(openingDelimiter.from, openingDelimiter.to);

  if (content && content.from < content.to) {
    forEachLineInRange(context.state, content.from, content.to, (line) => {
      context.lineClassAt(line.number, "cm-md-code-line");
      blockEndLineNumber = line.number;
    });
    context.highlightCodeFence(content.from, content.to, language);
  }

  if (closingDelimiter) {
    let closingLineNumber = context.state.doc.lineAt(closingDelimiter.from).number;
    blockEndLineNumber = closingLineNumber;
    context.lineClassAt(closingLineNumber, "cm-md-code-fence-line");
    context.syntax(closingDelimiter.from, closingDelimiter.to);
  }

  context.lineClassAt(blockEndLineNumber, "cm-md-code-block-end");
  context.consume(node.from, node.to);
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

function readTableFromCaptures(state: EditorState, table: CapturedTable): MarkdownTable | null {
  let header = sortedNodes(table.headerCells.values()).map((cell) => tableCellText(state, cell));
  let alignments = Array.from(table.delimiterCells.values())
    .sort((left, right) => compareNodes(left.node, right.node))
    .map(tableAlignment);
  if (header.length < 2 || alignments.length < 2) return null;

  let columnCount = Math.max(header.length, alignments.length);
  return {
    alignments: normalizeTableAlignments(alignments, columnCount),
    header: normalizeTableCells(header, columnCount),
    rows: Array.from(table.rows.values())
      .sort((left, right) => compareNodes(left.node, right.node))
      .map((row) =>
        normalizeTableCells(
          sortedNodes(row.cells.values()).map((cell) => tableCellText(state, cell)),
          columnCount,
        ),
      ),
  };
}

function tableCellText(state: EditorState, node: SyntaxNode) {
  return state.sliceDoc(node.from, node.to).trim();
}

function tableAlignment(cell: CapturedTableDelimiterCell): "center" | "default" | "left" | "right" {
  if (cell.left && cell.right) return "center";
  if (cell.right) return "right";
  if (cell.left) return "left";
  return "default";
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

function tableTouchesActiveLine(
  context: LiveMdFeatureContext,
  from: number,
  to: number,
  table: MarkdownTable,
) {
  if (context.touchesActiveLine(from, to)) return true;
  if (table.rows.length) return false;
  let end = Math.min(to, context.state.doc.length);
  let lastLine = context.state.doc.lineAt(Math.max(from, end - 1));
  let nextLineNumber = lastLine.number + 1;
  if (!context.activeLines.has(nextLineNumber) || nextLineNumber > context.state.doc.lines) {
    return false;
  }
  let nextLine = context.state.doc.line(nextLineNumber);
  return isWhitespaceOnly(context.state.sliceDoc(nextLine.from, nextLine.to));
}

function normalizeTableCells(cells: string[], columnCount: number) {
  let normalized = cells.slice(0, columnCount);
  while (normalized.length < columnCount) normalized.push("");
  return normalized;
}

function normalizeTableAlignments(
  alignments: Array<"center" | "default" | "left" | "right">,
  columnCount: number,
) {
  let normalized = alignments.slice(0, columnCount);
  while (normalized.length < columnCount) normalized.push("default");
  return normalized;
}

const paragraphBreakFeature: LiveMdFeature<Map<string, ParagraphContainer>> = {
  id: "paragraphBreak",
  priority: 10,
  query: {
    document: `
((document (section) @paragraph.child) @paragraph.container
  (#set! paragraph.kind "document"))

((section [
  (atx_heading)
  (block_quote)
  (fenced_code_block)
  (list)
  (paragraph)
  (pipe_table)
  (setext_heading)
  (thematic_break)
] @paragraph.child) @paragraph.container
  (#set! paragraph.kind "block"))

((block_quote [
  (block_quote)
  (fenced_code_block)
  (list)
  (paragraph)
  (pipe_table)
  (setext_heading)
  (thematic_break)
] @paragraph.child) @paragraph.container
  (#set! paragraph.kind "block"))

((list (list_item) @paragraph.child) @paragraph.container
  (#set! paragraph.kind "list"))

((list_item [
  (block_quote)
  (fenced_code_block)
  (list)
  (paragraph)
  (pipe_table)
  (setext_heading)
  (thematic_break)
] @paragraph.child) @paragraph.container
  (#set! paragraph.kind "listItem"))
`,
  },
  create: () => new Map(),
  collect: (match, containers, context) => collectParagraphContainer(context, match, containers),
  finish: (containers, context) => markParagraphBreaks(context, containers),
};

const headingFeature: LiveMdFeature = {
  id: "heading",
  priority: 20,
  query: {
    document: `
((atx_heading . (atx_h1_marker) @heading.marker) @heading
  (#set! heading.level "1"))
((atx_heading . (atx_h2_marker) @heading.marker) @heading
  (#set! heading.level "2"))
((atx_heading . (atx_h3_marker) @heading.marker) @heading
  (#set! heading.level "3"))
((atx_heading . (atx_h4_marker) @heading.marker) @heading
  (#set! heading.level "4"))
((atx_heading . (atx_h5_marker) @heading.marker) @heading
  (#set! heading.level "5"))
((atx_heading . (atx_h6_marker) @heading.marker) @heading
  (#set! heading.level "6"))
((setext_heading heading_content: (paragraph) (setext_h1_underline) @heading.marker) @heading
  (#set! heading.level "1"))
((setext_heading heading_content: (paragraph) (setext_h2_underline) @heading.marker) @heading
  (#set! heading.level "2"))
`,
  },
  apply: (match, _state, context) => applyHeadingMatch(context, match),
};

const syntaxFeature: LiveMdFeature = {
  id: "syntax",
  priority: 30,
  query: {
    document: `
(block_continuation) @syntax
(block_quote_marker) @syntax
`,
    inline: `
(code_span_delimiter) @syntax
(emphasis_delimiter) @syntax
`,
  },
  apply(match, _state, context) {
    for (let item of context.captures(match, "syntax")) {
      let key = `syntax:${context.nodeKey(item.node)}`;
      if (context.claim(key)) context.syntax(item.node.from, item.node.to);
    }
  },
};

const blockquoteFeature: LiveMdFeature = {
  id: "blockquote",
  priority: 40,
  query: {
    document: `(block_quote) @blockquote`,
  },
  apply(match, _state, context) {
    for (let item of context.captures(match, "blockquote")) {
      context.lineClass(item.node.from, item.node.to, "cm-md-blockquote");
    }
  },
};

const listFeature: LiveMdFeature = {
  id: "list",
  priority: 50,
  query: {
    document: `
(list_item) @list.item
(list_marker_dot) @list.marker
(list_marker_minus) @list.marker
(list_marker_parenthesis) @list.marker
(list_marker_plus) @list.marker
(list_marker_star) @list.marker
`,
  },
  apply(match, _state, context) {
    for (let item of context.captures(match, "list.item")) {
      context.lineClass(item.node.from, item.node.to, "cm-md-list-line");
    }
    for (let item of context.captures(match, "list.marker")) {
      let key = `list.marker:${context.nodeKey(item.node)}`;
      if (context.claim(key)) applyListMarker(context, item.node);
    }
  },
};

const taskFeature: LiveMdFeature = {
  id: "task",
  priority: 60,
  query: {
    document: `
(task_list_marker_checked) @task.checked
(task_list_marker_unchecked) @task.unchecked
`,
  },
  apply(match, _state, context) {
    for (let item of context.captures(match, "task.checked")) {
      applyTaskMarker(context, item.node, true);
    }
    for (let item of context.captures(match, "task.unchecked")) {
      applyTaskMarker(context, item.node, false);
    }
  },
};

const ruleFeature: LiveMdFeature = {
  id: "rule",
  priority: 70,
  query: {
    document: `(thematic_break) @rule`,
  },
  apply(match, _state, context) {
    let node = context.capture(match, "rule")?.node;
    if (node) applyRule(context, node);
  },
};

const codeFenceFeature: LiveMdFeature = {
  id: "codeFence",
  priority: 80,
  query: {
    document: `
((fenced_code_block
  .
  (fenced_code_block_delimiter) @codeFence.open
  (info_string (language) @codeFence.language)?
  (block_continuation)?
  (code_fence_content)? @codeFence.content
  (fenced_code_block_delimiter)? @codeFence.close
  .) @codeFence)
`,
  },
  apply: (match, _state, context) => applyCodeFence(context, match),
};

const tableFeature: LiveMdFeature<Map<string, CapturedTable>> = {
  id: "table",
  priority: 90,
  query: {
    document: `
(pipe_table) @table
((pipe_table (pipe_table_header (pipe_table_cell) @table.header.cell) @table.header) @table)
((pipe_table (pipe_table_delimiter_row) @table.delimiter.row) @table)
((pipe_table
  (pipe_table_delimiter_row
    (pipe_table_delimiter_cell
      (pipe_table_align_left)? @table.align.left
      (pipe_table_align_right)? @table.align.right) @table.delimiter.cell)) @table)
((pipe_table (pipe_table_row (pipe_table_cell) @table.row.cell) @table.row) @table)
((pipe_table (pipe_table_header "|" @table.pipe)) @table)
((pipe_table (pipe_table_delimiter_row "|" @table.pipe)) @table)
((pipe_table (pipe_table_row "|" @table.pipe)) @table)
`,
  },
  create: () => new Map(),
  collect: (match, tables, context) => collectTable(context, match, tables),
  apply: (match, tables, context) => applyTable(context, match, tables),
};

const inlineMarkFeature: LiveMdFeature = {
  id: "inlineMark",
  priority: 100,
  query: {
    inline: `
(code_span) @mark.inlineCode
(emphasis) @mark.emphasis
(strikethrough) @mark.strike
(strong_emphasis) @mark.strong
`,
  },
  apply(match, _state, context) {
    for (let item of context.captures(match, "mark.inlineCode")) {
      context.mark(item.node.from, item.node.to, inlineCodeMark);
    }
    for (let item of context.captures(match, "mark.emphasis")) {
      context.mark(item.node.from, item.node.to, emphasisMark);
    }
    for (let item of context.captures(match, "mark.strike")) {
      context.mark(item.node.from, item.node.to, strikeMark);
    }
    for (let item of context.captures(match, "mark.strong")) {
      context.mark(item.node.from, item.node.to, strongMark);
    }
  },
};

const autolinkFeature: LiveMdFeature = {
  id: "autolink",
  priority: 110,
  query: {
    inline: `(uri_autolink) @uriAutolink`,
  },
  apply(match, _state, context) {
    for (let item of context.captures(match, "uriAutolink")) applyUriAutolink(context, item.node);
  },
};

const linkFeature: LiveMdFeature = {
  id: "link",
  priority: 120,
  query: {
    inline: `
((inline_link
  .
  (link_text) @link.text
  (link_destination)? @link.destination
  (link_title)?
  .) @link)
`,
  },
  apply: (match, _state, context) => applyInlineLink(context, match),
};

const imageFeature: LiveMdFeature = {
  id: "image",
  priority: 130,
  query: {
    inline: `
((image
  .
  (image_description)? @image.description
  (link_destination)? @image.destination
  (link_title)?
  .) @image)
`,
  },
  apply: (match, _state, context) => applyImage(context, match),
};

const latexFeature: LiveMdFeature = {
  id: "latex",
  priority: 140,
  query: {
    inline: `
((latex_block
  .
  (latex_span_delimiter) @latex.open
  (latex_span_delimiter) @latex.close
  .) @latex
  (#set! injection.language "latex"))
`,
  },
  apply: (match, _state, context) => applyLatex(context, match),
};

export const liveMdDefaultFeatures: readonly LiveMdFeature<unknown>[] = [
  eraseLiveMdFeatureState(paragraphBreakFeature),
  eraseLiveMdFeatureState(headingFeature),
  eraseLiveMdFeatureState(syntaxFeature),
  eraseLiveMdFeatureState(blockquoteFeature),
  eraseLiveMdFeatureState(listFeature),
  eraseLiveMdFeatureState(taskFeature),
  eraseLiveMdFeatureState(ruleFeature),
  eraseLiveMdFeatureState(codeFenceFeature),
  eraseLiveMdFeatureState(tableFeature),
  eraseLiveMdFeatureState(inlineMarkFeature),
  eraseLiveMdFeatureState(autolinkFeature),
  eraseLiveMdFeatureState(linkFeature),
  eraseLiveMdFeatureState(imageFeature),
  eraseLiveMdFeatureState(latexFeature),
];

function eraseLiveMdFeatureState<State>(feature: LiveMdFeature<State>) {
  return feature as unknown as LiveMdFeature<unknown>;
}
