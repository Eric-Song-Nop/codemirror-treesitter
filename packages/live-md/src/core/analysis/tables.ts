import { type EditorState } from "@codemirror/state";
import { type SyntaxNode, type TreeSitterQueryMatch } from "@codemirror-treesitter/language";
import { type MarkdownTable } from "../widgets.js";
import { capture, captures, compareNodes, nodeKey, sortedNodes } from "./query.js";
import { type CapturedTable, type CapturedTableDelimiterCell } from "./types.js";

export function collectTable(match: TreeSitterQueryMatch, tables: Map<string, CapturedTable>) {
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

function capturedTable(tables: Map<string, CapturedTable>, node: SyntaxNode) {
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

function capturedTableRow(table: CapturedTable, node: SyntaxNode) {
  let key = nodeKey(node);
  let row = table.rows.get(key);
  if (!row) {
    row = { cells: new Map(), node };
    table.rows.set(key, row);
  }
  return row;
}

export function readTableFromCaptures(
  state: EditorState,
  table: CapturedTable,
): MarkdownTable | null {
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
