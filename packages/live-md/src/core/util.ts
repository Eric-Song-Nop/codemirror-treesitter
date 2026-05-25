import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@codemirror-treesitter/language";

export type DocLine = {
  from: number;
  number: number;
  to: number;
};

export function forEachLineInRange(
  state: EditorState,
  from: number,
  to: number,
  visit: (line: DocLine) => void,
) {
  if (from >= to) return;
  let firstLine = state.doc.lineAt(from).number;
  let lastLine = state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
    visit(state.doc.line(lineNumber));
  }
}

export function splitRangeByLine(
  state: EditorState,
  from: number,
  to: number,
  visit: (lineNumber: number, from: number, to: number) => void,
) {
  let cursor = from;
  while (cursor < to) {
    let line = state.doc.lineAt(cursor);
    let rangeTo = Math.min(to, line.to);
    if (cursor < rangeTo) visit(line.number, cursor, rangeTo);
    cursor = line.to < to ? line.to + 1 : to;
  }
}

export function isWhitespaceOnly(value: string) {
  for (let index = 0; index < value.length; index++) {
    if (!isWhitespace(value.charCodeAt(index))) return false;
  }
  return true;
}

export function isWhitespace(code: number) {
  return code == 9 || code == 10 || code == 13 || code == 32;
}

export function isAsciiDigit(code: number) {
  return code >= 48 && code <= 57;
}

export function hasAncestor(node: SyntaxNode | null, name: string) {
  while (node) {
    if (node.name == name) return true;
    node = node.parent;
  }
  return false;
}
