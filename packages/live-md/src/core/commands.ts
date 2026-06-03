import { EditorSelection, type EditorState } from "@codemirror/state";
import { indentWithTab } from "@codemirror-treesitter/commands";
import { queryTreeCaptures, syntaxTree, type SyntaxNode } from "@codemirror-treesitter/language";
import { EditorView, keymap, type Command } from "@codemirror/view";
import { hasAncestor, isAsciiDigit, isWhitespace, isWhitespaceOnly, type DocLine } from "./util.js";
import lineMarkerQuerySource from "./queries/line-markers.scm?raw";

type LineMarkers = {
  inCode: boolean;
  listMarker: { from: number; text: string; to: number } | null;
  quoteTo: number | null;
  task: { checked: boolean; from: number; to: number } | null;
};

export const liveMdKeymap = keymap.of([
  { key: "Enter", run: continueMarkdownBlock, shift: insertMarkdownSoftBreak },
  { key: "Mod-b", run: surroundSelection("**", "**", "strong text") },
  { key: "Mod-i", run: surroundSelection("_", "_", "emphasis") },
  { key: "Mod-e", run: surroundSelection("`", "`", "code") },
  { key: "Mod-Shift-x", run: surroundSelection("~~", "~~", "removed text") },
  { key: "Mod-k", run: insertMarkdownLink },
  { key: "Mod-Shift-Enter", run: toggleTaskOnCurrentLine },
  indentWithTab,
]);

function readLineMarkers(state: EditorState, line: DocLine) {
  let result: LineMarkers = {
    inCode: lineIsInsideCodeFence(state, line),
    listMarker: null,
    quoteTo: null,
    task: null,
  };

  if (result.inCode) return result;

  for (let capture of queryTreeCaptures(syntaxTree(state), lineMarkerQuerySource, {
    from: line.from,
    includeNested: false,
    to: line.to,
  })) {
    let { node } = capture;
    if (node.from < line.from || node.from > line.to) continue;
    switch (capture.name) {
      case "quote":
        result.quoteTo = Math.max(result.quoteTo ?? line.from, node.to);
        break;
      case "list":
        result.listMarker ??= {
          from: node.from,
          text: state.sliceDoc(node.from, node.to),
          to: node.to,
        };
        break;
      case "task.checked":
      case "task.unchecked":
        result.task ??= {
          checked: capture.name == "task.checked",
          from: node.from,
          to: node.to,
        };
        break;
    }
  }

  return result;
}

function lineIsInsideCodeFence(state: EditorState, line: DocLine) {
  let tree = syntaxTree(state);
  let positions = new Set([line.from, line.to > line.from ? line.to - 1 : line.from]);
  for (let position of positions) {
    let node: SyntaxNode | null = tree.resolveInner(position, 1);
    if (hasAncestor(node, "fenced_code_block")) return true;
    node = tree.resolveInner(position, -1);
    if (hasAncestor(node, "fenced_code_block")) return true;
  }
  return false;
}

function continueMarkdownBlock(view: EditorView) {
  if (view.state.readOnly) return true;

  let { state } = view;
  if (state.selection.ranges.length != 1 || !state.selection.main.empty) return false;

  let cursor = state.selection.main.head;
  let line = state.doc.lineAt(cursor);
  let markers = readLineMarkers(state, line);
  if (markers.inCode) return false;

  let after = state.sliceDoc(cursor, line.to);
  if (isWhitespaceOnly(after)) {
    if (markers.task && isWhitespaceOnly(state.sliceDoc(markers.task.to, cursor))) {
      return clearMarkdownContinuation(view, markers.listMarker?.from ?? markers.task.from, cursor);
    }
    if (markers.listMarker && isWhitespaceOnly(state.sliceDoc(markers.listMarker.to, cursor))) {
      return clearMarkdownContinuation(view, markers.listMarker.from, cursor);
    }
    if (
      !markers.listMarker &&
      markers.quoteTo &&
      isWhitespaceOnly(state.sliceDoc(markers.quoteTo, cursor))
    ) {
      return clearMarkdownContinuation(view, line.from, cursor);
    }
  }

  if (markers.task && markers.listMarker && cursor >= markers.task.to) {
    let prefix = state.sliceDoc(line.from, markers.listMarker.from);
    return insertContinuation(view, cursor, `${prefix}${nextMarker(markers.listMarker.text)}[ ] `);
  }

  if (markers.listMarker && cursor >= markers.listMarker.to) {
    let prefix = state.sliceDoc(line.from, markers.listMarker.from);
    return insertContinuation(view, cursor, `${prefix}${nextMarker(markers.listMarker.text)}`);
  }

  if (markers.quoteTo && cursor >= markers.quoteTo) {
    return insertContinuation(view, cursor, state.sliceDoc(line.from, markers.quoteTo));
  }

  if (cursor == line.to) {
    return insertParagraphBreak(view, cursor);
  }

  return false;
}

function clearMarkdownContinuation(view: EditorView, from: number, to: number) {
  if (view.state.readOnly) return true;

  view.dispatch({
    changes: { from, to, insert: "" },
    selection: { anchor: from },
    scrollIntoView: true,
    userEvent: "delete.markdownMarker",
  });
  return true;
}

function insertContinuation(view: EditorView, cursor: number, prefix: string) {
  if (view.state.readOnly) return true;

  view.dispatch({
    changes: { from: cursor, insert: `\n${prefix}` },
    selection: { anchor: cursor + prefix.length + 1 },
    scrollIntoView: true,
    userEvent: "input.markdownNewline",
  });
  return true;
}

function insertParagraphBreak(view: EditorView, cursor: number) {
  if (view.state.readOnly) return true;

  view.dispatch({
    changes: { from: cursor, insert: "\n\n" },
    selection: { anchor: cursor + 2 },
    scrollIntoView: true,
    userEvent: "input.markdownParagraphBreak",
  });
  return true;
}

function insertMarkdownSoftBreak(view: EditorView) {
  if (view.state.readOnly) return true;

  view.dispatch(
    view.state.update(view.state.replaceSelection(view.state.lineBreak), {
      scrollIntoView: true,
      userEvent: "input.markdownSoftBreak",
    }),
  );
  return true;
}

function nextMarker(marker: string) {
  let trimmedEnd = marker.length;
  while (trimmedEnd > 0 && isWhitespace(marker.charCodeAt(trimmedEnd - 1))) trimmedEnd--;
  let suffix = marker.charAt(trimmedEnd - 1);
  if (suffix != "." && suffix != ")") return marker;

  let digitsEnd = trimmedEnd - 1;
  let digitsStart = digitsEnd;
  while (digitsStart > 0 && isAsciiDigit(marker.charCodeAt(digitsStart - 1))) digitsStart--;
  if (digitsStart == digitsEnd || !isWhitespaceOnly(marker.slice(0, digitsStart))) return marker;

  let nextNumber = Number(marker.slice(digitsStart, digitsEnd)) + 1;
  return `${marker.slice(0, digitsStart)}${nextNumber}${suffix}${marker.slice(trimmedEnd)}`;
}

function surroundSelection(open: string, close: string, placeholder: string): Command {
  return (view) => {
    if (view.state.readOnly) return true;

    let transaction = view.state.changeByRange((range) => {
      if (range.empty) {
        let insert = `${open}${placeholder}${close}`;
        return {
          changes: { from: range.from, insert },
          range: EditorSelection.range(
            range.from + open.length,
            range.from + open.length + placeholder.length,
          ),
        };
      }

      let selected = view.state.sliceDoc(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: `${open}${selected}${close}` },
        range: EditorSelection.range(range.from + open.length, range.to + open.length),
      };
    });

    view.dispatch({ ...transaction, scrollIntoView: true, userEvent: "input.markdownWrap" });
    return true;
  };
}

function insertMarkdownLink(view: EditorView) {
  if (view.state.readOnly) return true;

  let transaction = view.state.changeByRange((range) => {
    let label = range.empty ? "link" : view.state.sliceDoc(range.from, range.to);
    let insert = `[${label}](https://example.com)`;
    let urlFrom = range.from + label.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlFrom, urlFrom + "https://example.com".length),
    };
  });
  view.dispatch({ ...transaction, scrollIntoView: true, userEvent: "input.markdownLink" });
  return true;
}

function toggleTaskOnCurrentLine(view: EditorView) {
  if (view.state.readOnly) return true;

  let line = view.state.doc.lineAt(view.state.selection.main.head);
  let task = readLineMarkers(view.state, line).task;
  if (!task) return false;
  view.dispatch({
    changes: {
      from: task.from + 1,
      to: task.from + 2,
      insert: task.checked ? " " : "x",
    },
    userEvent: "input.task",
  });
  return true;
}
