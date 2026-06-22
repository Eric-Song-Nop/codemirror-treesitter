import { type Text } from "@codemirror/state";
import {
  queryTreeMatches,
  type SyntaxNode,
  type Tree,
  type TreeSitterQueryMatch,
} from "@codemirror-treesitter/language";
import {
  type LiveMdDescriptor,
  type LiveMdTableAlignment,
  type LiveMdTableModel,
} from "./descriptors.js";
import {
  capture,
  captures,
  compareNodes,
  liveMdMarkdownBlockQuerySource,
  matchKind,
  nodeKey,
  sortedNodes,
} from "./query.js";
import { type DocRange } from "./types.js";

type CapturedLeafTable = {
  delimiterCells: Map<string, CapturedLeafTableDelimiterCell>;
  delimiterRow: SyntaxNode | null;
  headerCells: Map<string, SyntaxNode>;
  node: SyntaxNode;
  pipes: Map<string, SyntaxNode>;
  rows: Map<string, CapturedLeafTableRow>;
};

type CapturedLeafTableDelimiterCell = {
  left: boolean;
  node: SyntaxNode;
  right: boolean;
};

type CapturedLeafTableRow = {
  cells: Map<string, SyntaxNode>;
  node: SyntaxNode;
};

export type MarkdownTableAnalysis = {
  descriptor: LiveMdDescriptor | null;
  inlineRanges: readonly DocRange[];
};

export function analyzeMarkdownTableAnalysis(
  doc: Text,
  tree: Tree,
  range: DocRange,
): MarkdownTableAnalysis {
  let tables = new Map<string, CapturedLeafTable>();
  for (let match of queryTreeMatches(tree, liveMdMarkdownBlockQuerySource, {
    from: range.from,
    includeNested: false,
    to: range.to,
  })) {
    if (matchKind(match) == "table") collectTable(match, tables);
  }

  let table = Array.from(tables.values()).find((candidate) =>
    rangesOverlap(nodeRange(candidate.node), range),
  );
  if (!table) return tableAnalysisFromSource(doc, range);

  return {
    descriptor: {
      delimiterRowRange: table.delimiterRow ? nodeRange(table.delimiterRow) : null,
      kind: "table",
      pipeRanges: sortedNodes(table.pipes.values()).map(nodeRange),
      range: nodeRange(table.node),
      table: readTableFromCaptures(doc, table) ?? readTableFromSource(doc, nodeRange(table.node)),
    },
    inlineRanges: tableInlineRanges(doc, table),
  };
}

export function analyzeMarkdownTableDescriptor(
  doc: Text,
  tree: Tree,
  range: DocRange,
): LiveMdDescriptor | null {
  return analyzeMarkdownTableAnalysis(doc, tree, range).descriptor;
}

function tableAnalysisFromSource(doc: Text, range: DocRange): MarkdownTableAnalysis {
  let table = readTableFromSource(doc, range);
  if (!table) return { descriptor: null, inlineRanges: [] };
  let lineRanges = tableLineRanges(doc, range);
  return {
    descriptor: {
      delimiterRowRange: lineRanges[1] ?? null,
      kind: "table",
      pipeRanges: sourcePipeRanges(doc, lineRanges),
      range,
      table,
    },
    inlineRanges: sourceTableInlineRanges(doc, lineRanges),
  };
}

function collectTable(match: TreeSitterQueryMatch, tables: Map<string, CapturedLeafTable>) {
  let tableCapture = capture(match, "table");
  if (!tableCapture) return;
  let table = capturedTable(tables, tableCapture.node);
  for (let headerCell of captures(match, "table.header.cell")) {
    table.headerCells.set(nodeKey(headerCell.node), headerCell.node);
  }
  for (let delimiterRow of captures(match, "table.delimiter.row")) {
    table.delimiterRow = delimiterRow.node;
  }
  for (let delimiterCell of captures(match, "table.delimiter.cell")) {
    let key = nodeKey(delimiterCell.node);
    table.delimiterCells.set(key, {
      left: !!capture(match, "table.align.left"),
      node: delimiterCell.node,
      right: !!capture(match, "table.align.right"),
    });
  }
  for (let rowCapture of captures(match, "table.row")) {
    capturedTableRow(table, rowCapture.node);
  }
  let rowCapture = capture(match, "table.row");
  for (let rowCell of captures(match, "table.row.cell")) {
    let row = rowCapture ? capturedTableRow(table, rowCapture.node) : null;
    row?.cells.set(nodeKey(rowCell.node), rowCell.node);
  }
  for (let pipe of captures(match, "table.pipe")) {
    table.pipes.set(nodeKey(pipe.node), pipe.node);
  }
}

function capturedTable(tables: Map<string, CapturedLeafTable>, node: SyntaxNode) {
  let key = nodeKey(node);
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

function capturedTableRow(table: CapturedLeafTable, node: SyntaxNode) {
  let key = nodeKey(node);
  let row = table.rows.get(key);
  if (!row) {
    row = { cells: new Map(), node };
    table.rows.set(key, row);
  }
  return row;
}

function readTableFromCaptures(doc: Text, table: CapturedLeafTable): LiveMdTableModel | null {
  let header = sortedNodes(table.headerCells.values()).map((cell) => tableCellText(doc, cell));
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
          sortedNodes(row.cells.values()).map((cell) => tableCellText(doc, cell)),
          columnCount,
        ),
      ),
  };
}

function tableInlineRanges(doc: Text, table: CapturedLeafTable) {
  let ranges: DocRange[] = [];
  for (let cell of sortedNodes(table.headerCells.values())) {
    addInlineRange(ranges, trimRange(doc, nodeRange(cell)));
  }
  for (let row of Array.from(table.rows.values()).sort((left, right) =>
    compareNodes(left.node, right.node),
  )) {
    for (let cell of sortedNodes(row.cells.values())) {
      addInlineRange(ranges, trimRange(doc, nodeRange(cell)));
    }
  }
  return ranges;
}

function tableCellText(doc: Text, node: SyntaxNode) {
  return doc.sliceString(node.from, node.to).trim();
}

function tableAlignment(cell: CapturedLeafTableDelimiterCell): LiveMdTableAlignment {
  if (cell.left && cell.right) return "center";
  if (cell.right) return "right";
  if (cell.left) return "left";
  return "default";
}

function normalizeTableCells(cells: string[], columnCount: number) {
  let normalized = cells.slice(0, columnCount);
  while (normalized.length < columnCount) normalized.push("");
  return normalized;
}

function normalizeTableAlignments(alignments: LiveMdTableAlignment[], columnCount: number) {
  let normalized = alignments.slice(0, columnCount);
  while (normalized.length < columnCount) normalized.push("default");
  return normalized;
}

function readTableFromSource(doc: Text, range: DocRange): LiveMdTableModel | null {
  let lines = tableLines(doc, range);
  if (lines.length < 2) return null;

  let header = splitTableLine(lines[0]!);
  let alignments = splitTableLine(lines[1]!).map(sourceTableAlignment);
  if (header.length < 2 || alignments.length < 2) return null;

  let columnCount = Math.max(header.length, alignments.length);
  return {
    alignments: normalizeTableAlignments(alignments, columnCount),
    header: normalizeTableCells(
      header.map((cell) => cell.trim()),
      columnCount,
    ),
    rows: lines.slice(2).map((line) =>
      normalizeTableCells(
        splitTableLine(line).map((cell) => cell.trim()),
        columnCount,
      ),
    ),
  };
}

function tableLines(doc: Text, range: DocRange) {
  return tableLineRanges(doc, range).map((line) => doc.sliceString(line.from, line.to));
}

function tableLineRanges(doc: Text, range: DocRange) {
  let lines: DocRange[] = [];
  let firstLine = doc.lineAt(range.from);
  let lastLine = doc.lineAt(Math.max(range.from, range.to - 1));
  for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber++) {
    let line = doc.line(lineNumber);
    let text = doc.sliceString(line.from, line.to);
    if (text.trim()) lines.push({ from: line.from, to: line.to });
  }
  return lines;
}

function sourceTableInlineRanges(doc: Text, lines: readonly DocRange[]) {
  let ranges: DocRange[] = [];
  let contentLines = [lines[0], ...lines.slice(2)];
  for (let line of contentLines) {
    if (!line) continue;
    for (let range of sourceTableCellRanges(doc, line)) {
      addInlineRange(ranges, trimRange(doc, range));
    }
  }
  return ranges;
}

function sourceTableCellRanges(doc: Text, line: DocRange) {
  let text = doc.sliceString(line.from, line.to);
  let pipeOffsets = sourcePipeOffsets(text);
  if (!pipeOffsets.length) return [{ from: line.from, to: line.to }];

  let ranges: DocRange[] = [];
  let firstContent = firstNonWhitespaceOffset(text);
  let lastContent = lastNonWhitespaceOffset(text);
  let startsWithPipe = firstContent != null && text[firstContent] == "|";
  let endsWithPipe = lastContent != null && text[lastContent] == "|";
  let cellFrom = startsWithPipe ? pipeOffsets[0]! + 1 : 0;
  let lastPipeIndex = pipeOffsets.length - 1;
  for (let index = startsWithPipe ? 1 : 0; index < pipeOffsets.length; index++) {
    let pipe = pipeOffsets[index]!;
    if (endsWithPipe && index == lastPipeIndex) break;
    ranges.push({ from: line.from + cellFrom, to: line.from + pipe });
    cellFrom = pipe + 1;
  }
  let cellTo = endsWithPipe ? pipeOffsets[lastPipeIndex]! : text.length;
  ranges.push({ from: line.from + cellFrom, to: line.from + cellTo });
  return ranges;
}

function splitTableLine(line: string) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);

  let cells: string[] = [];
  let cell = "";
  for (let index = 0; index < text.length; index++) {
    let char = text[index]!;
    if (char == "\\" && index + 1 < text.length) {
      cell += char + text[++index]!;
      continue;
    }
    if (char == "|") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

function sourceTableAlignment(cell: string): LiveMdTableAlignment {
  let value = cell.trim();
  let left = value.startsWith(":");
  let right = value.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "default";
}

function sourcePipeRanges(doc: Text, lines: readonly DocRange[]) {
  let ranges: DocRange[] = [];
  for (let line of lines) {
    let text = doc.sliceString(line.from, line.to);
    for (let index of sourcePipeOffsets(text)) {
      ranges.push({ from: line.from + index, to: line.from + index + 1 });
    }
  }
  return ranges;
}

function sourcePipeOffsets(text: string) {
  let offsets: number[] = [];
  for (let index = 0; index < text.length; index++) {
    let char = text[index]!;
    if (char == "\\" && index + 1 < text.length) {
      index++;
      continue;
    }
    if (char == "|") offsets.push(index);
  }
  return offsets;
}

function addInlineRange(ranges: DocRange[], range: DocRange) {
  if (range.from < range.to) ranges.push(range);
}

function trimRange(doc: Text, range: DocRange): DocRange {
  let from = range.from;
  let to = range.to;
  while (from < to && isWhitespaceCode(doc.sliceString(from, from + 1).charCodeAt(0))) from++;
  while (to > from && isWhitespaceCode(doc.sliceString(to - 1, to).charCodeAt(0))) to--;
  return { from, to };
}

function firstNonWhitespaceOffset(text: string) {
  for (let index = 0; index < text.length; index++) {
    if (!isWhitespaceCode(text.charCodeAt(index))) return index;
  }
  return null;
}

function lastNonWhitespaceOffset(text: string) {
  for (let index = text.length - 1; index >= 0; index--) {
    if (!isWhitespaceCode(text.charCodeAt(index))) return index;
  }
  return null;
}

function isWhitespaceCode(code: number) {
  return code == 9 || code == 10 || code == 13 || code == 32;
}

function nodeRange(node: SyntaxNode): DocRange {
  return { from: node.from, to: node.to };
}

function rangesOverlap(left: DocRange, right: DocRange) {
  return left.from < right.to && right.from < left.to;
}
