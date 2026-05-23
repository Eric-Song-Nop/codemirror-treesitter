import {
  Annotation,
  ChangeSet,
  EditorSelection,
  EditorState,
  Facet,
  StateEffect,
  StateField,
  Transaction,
  combineConfig,
  countColumn,
  type ChangeSpec,
  type Extension,
  type Line,
  type SelectionRange,
  type StateCommand,
} from "@codemirror/state";
import { EditorView, type Command, type KeyBinding } from "@codemirror/view";
import {
  getIndentUnit,
  getIndentation,
  indentString,
  indentUnit,
} from "@codemirror-treesitter/language";

interface HistoryConfig {
  minDepth?: number;
  newGroupDelay?: number;
}

const historyConfig = Facet.define<HistoryConfig, Required<HistoryConfig>>({
  combine(configs) {
    return combineConfig(
      configs,
      { minDepth: 100, newGroupDelay: 500 },
      { minDepth: Math.max, newGroupDelay: Math.min },
    );
  },
});

type HistoryEvent = {
  changes: ChangeSet;
  inverted: ChangeSet;
  before: EditorSelection;
  after: EditorSelection;
};

type HistoryAnnotation = {
  side: "undo" | "redo";
  event: HistoryEvent;
};

const fromHistory = Annotation.define<HistoryAnnotation>();

export const isolateHistory = Annotation.define<"before" | "after" | "full">();
export const invertedEffects = Facet.define<(tr: Transaction) => readonly StateEffect<unknown>[]>();

class HistoryState {
  constructor(
    readonly done: readonly HistoryEvent[] = [],
    readonly undone: readonly HistoryEvent[] = [],
  ) {}

  add(event: HistoryEvent, depth: number) {
    let done =
      this.done.length >= depth ? this.done.slice(this.done.length - depth + 1) : this.done.slice();
    return new HistoryState(done.concat(event), []);
  }
}

const historyField_ = StateField.define<HistoryState>({
  create() {
    return new HistoryState();
  },
  update(value, tr) {
    let from = tr.annotation(fromHistory);
    if (from?.side == "undo") {
      return new HistoryState(value.done.slice(0, -1), value.undone.concat(from.event));
    }
    if (from?.side == "redo") {
      return new HistoryState(value.done.concat(from.event), value.undone.slice(0, -1));
    }
    if (tr.annotation(Transaction.addToHistory) === false || tr.changes.empty) return value;
    let event: HistoryEvent = {
      changes: tr.changes,
      inverted: tr.changes.invert(tr.startState.doc),
      before: tr.startState.selection,
      after: tr.state.selection,
    };
    return value.add(event, tr.state.facet(historyConfig).minDepth);
  },
  toJSON(value) {
    return {
      done: value.done.length,
      undone: value.undone.length,
    };
  },
});

export const historyField = historyField_ as StateField<unknown>;

export function history(config: HistoryConfig = {}): Extension {
  return [
    historyField_,
    historyConfig.of(config),
    EditorView.domEventHandlers({
      beforeinput(event, view) {
        let command =
          event.inputType == "historyUndo" ? undo : event.inputType == "historyRedo" ? redo : null;
        if (!command) return false;
        event.preventDefault();
        return command(view);
      },
    }),
  ];
}

function historyCommand(side: "undo" | "redo"): StateCommand {
  return ({ state, dispatch }) => {
    let historyState = state.field(historyField_, false);
    if (!historyState) return false;
    let branch = side == "undo" ? historyState.done : historyState.undone;
    let event = branch[branch.length - 1];
    if (!event) return false;
    dispatch(
      state.update({
        changes: side == "undo" ? event.inverted : event.changes,
        selection: side == "undo" ? event.before : event.after,
        annotations: [Transaction.addToHistory.of(false), fromHistory.of({ side, event })],
        userEvent: side,
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

export const undo = historyCommand("undo");
export const redo = historyCommand("redo");
export const undoSelection = undo;
export const redoSelection = redo;

export function undoDepth(state: EditorState) {
  return state.field(historyField_, false)?.done.length ?? 0;
}

export function redoDepth(state: EditorState) {
  return state.field(historyField_, false)?.undone.length ?? 0;
}

export const historyKeymap: readonly KeyBinding[] = [
  { key: "Mod-z", run: undo, preventDefault: true },
  { key: "Mod-y", mac: "Mod-Shift-z", run: redo, preventDefault: true },
  { linux: "Ctrl-Shift-z", run: redo, preventDefault: true },
  { key: "Mod-u", run: undoSelection, preventDefault: true },
  { key: "Alt-u", mac: "Mod-Shift-u", run: redoSelection, preventDefault: true },
];

function dispatchSelection(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  selection: EditorSelection,
) {
  dispatch(state.update({ selection, scrollIntoView: true, userEvent: "select" }));
  return true;
}

export const selectAll: StateCommand = ({ state, dispatch }) =>
  dispatchSelection(state, dispatch, EditorSelection.single(0, state.doc.length));

export const insertNewline: StateCommand = ({ state, dispatch }) => {
  dispatch(state.update(state.replaceSelection("\n")));
  return true;
};

export const insertNewlineKeepIndent: StateCommand = ({ state, dispatch }) => {
  let changes = state.changeByRange((range) => {
    let line = state.doc.lineAt(range.head);
    let indent = /^\s*/.exec(line.text)![0];
    let insert = `\n${indent}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

export const insertNewlineAndIndent: StateCommand = ({ state, dispatch }) => {
  let changes = state.changeByRange((range) => {
    let indent = getIndentation(state, range.head);
    if (indent == null) indent = state.doc.lineAt(range.head).text.search(/\S|$/);
    let insert = `\n${indentString(state, indent)}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

export const insertBlankLine: StateCommand = ({ state, dispatch }) => {
  let line = state.doc.lineAt(state.selection.main.head);
  let indent = /^\s*/.exec(line.text)![0];
  dispatch(
    state.update({
      changes: { from: line.to, insert: `\n${indent}` },
      selection: EditorSelection.cursor(line.to + 1 + indent.length),
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

export const deleteCharBackward: Command = (view) => deleteByChar(view, false);

export const deleteCharBackwardStrict: Command = (view) => deleteByChar(view, false);
export const deleteCharForward: Command = (view) => deleteByChar(view, true);

function deleteByChar(view: EditorView, forward: boolean) {
  let { state } = view;
  if (state.readOnly) return false;
  let changes = state.changeByRange((range) => {
    if (!range.empty)
      return {
        changes: { from: range.from, to: range.to },
        range: EditorSelection.cursor(range.from),
      };
    let pos = range.head;
    let line = state.doc.lineAt(pos);
    if (forward) {
      let to = pos < line.to ? pos + 1 : Math.min(state.doc.length, pos + 1);
      return { changes: { from: pos, to }, range: EditorSelection.cursor(pos) };
    }
    let from = pos > line.from ? pos - 1 : Math.max(0, pos - 1);
    return { changes: { from, to: pos }, range: EditorSelection.cursor(from) };
  });
  view.dispatch(
    state.update(changes, {
      scrollIntoView: true,
      userEvent: forward ? "delete.forward" : "delete.backward",
    }),
  );
  return true;
}

export const deleteLine: Command = (view) => {
  let { state } = view;
  let changes = state.changeByRange((range) => {
    let line = state.doc.lineAt(range.head);
    let to = Math.min(state.doc.length, line.to + 1);
    let from = line.from == to ? Math.max(0, line.from - 1) : line.from;
    return { changes: { from, to }, range: EditorSelection.cursor(from) };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "delete.line" }));
  return true;
};

function changeBySelectedLine(
  state: EditorState,
  f: (line: Line, changes: ChangeSpec[], range: SelectionRange) => void,
) {
  let atLine = -1;
  return state.changeByRange((range) => {
    let changes: ChangeSpec[] = [];
    for (let pos = range.from; pos <= range.to; ) {
      let line = state.doc.lineAt(pos);
      if (line.number > atLine && (range.empty || range.to > line.from)) {
        f(line, changes, range);
        atLine = line.number;
      }
      pos = line.to + 1;
    }
    let changeSet = state.changes(changes);
    return {
      changes,
      range: EditorSelection.range(
        changeSet.mapPos(range.anchor, 1),
        changeSet.mapPos(range.head, 1),
      ),
    };
  });
}

export const indentMore: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  let indent = state.facet(indentUnit);
  dispatch(
    state.update(
      changeBySelectedLine(state, (line, changes) => {
        changes.push({ from: line.from, insert: indent });
      }),
      { scrollIntoView: true, userEvent: "input.indent" },
    ),
  );
  return true;
};

export const indentLess: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  dispatch(
    state.update(
      changeBySelectedLine(state, (line, changes) => {
        let space = /^\s*/.exec(line.text)![0];
        if (!space) return;
        let col = countColumn(space, state.tabSize);
        let keep = 0;
        let insert = indentString(state, Math.max(0, col - getIndentUnit(state)));
        while (
          keep < space.length &&
          keep < insert.length &&
          space.charCodeAt(keep) == insert.charCodeAt(keep)
        ) {
          keep++;
        }
        changes.push({
          from: line.from + keep,
          to: line.from + space.length,
          insert: insert.slice(keep),
        });
      }),
      { scrollIntoView: true, userEvent: "delete.dedent" },
    ),
  );
  return true;
};

export const indentSelection: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  dispatch(
    state.update(indentRangeBySelection(state), {
      scrollIntoView: true,
      userEvent: "input.indent",
    }),
  );
  return true;
};

function indentRangeBySelection(state: EditorState) {
  let indent = state.facet(indentUnit);
  return changeBySelectedLine(state, (line, changes) => {
    changes.push({ from: line.from, insert: indent });
  });
}

export interface CommentTokens {
  line?: string;
  block?: { open: string; close: string };
}

function commentTokens(state: EditorState) {
  return state.languageDataAt<CommentTokens>("commentTokens", state.selection.main.head)[0];
}

export const toggleLineComment: StateCommand = ({ state, dispatch }) => {
  let token = commentTokens(state)?.line;
  if (!token) return false;
  let changes = [];
  let seen = new Set<number>();
  for (let range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      let line = state.doc.lineAt(pos);
      if (!seen.has(line.from)) {
        seen.add(line.from);
        let indent = /^\s*/.exec(line.text)![0].length;
        let at = line.from + indent;
        if (state.sliceDoc(at, at + token.length) == token) {
          changes.push({
            from: at,
            to:
              at +
              token.length +
              (state.sliceDoc(at + token.length, at + token.length + 1) == " " ? 1 : 0),
          });
        } else {
          changes.push({ from: at, insert: `${token} ` });
        }
      }
      pos = line.to + 1;
    }
  }
  dispatch(state.update({ changes, scrollIntoView: true, userEvent: "input.comment" }));
  return true;
};

export const lineComment = toggleLineComment;
export const lineUncomment = toggleLineComment;
export const toggleComment = toggleLineComment;

export const toggleBlockComment: StateCommand = ({ state, dispatch }) => {
  let block = commentTokens(state)?.block;
  if (!block) return false;
  let changes = state.changeByRange((range) => {
    let before = state.sliceDoc(range.from, range.from + block.open.length);
    let after = state.sliceDoc(range.to - block.close.length, range.to);
    if (before == block.open && after == block.close) {
      return {
        changes: [
          { from: range.to - block.close.length, to: range.to },
          { from: range.from, to: range.from + block.open.length },
        ],
        range: EditorSelection.range(
          range.anchor,
          range.head - block.open.length - block.close.length,
        ),
      };
    }
    return {
      changes: [
        { from: range.from, insert: block.open },
        { from: range.to, insert: block.close },
      ],
      range: EditorSelection.range(
        range.anchor + block.open.length,
        range.head + block.open.length,
      ),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input.comment" }));
  return true;
};

export const blockComment = toggleBlockComment;
export const blockUncomment = toggleBlockComment;
export const toggleBlockCommentByLine = toggleBlockComment;

const noOp: Command = () => false;

export const cursorSyntaxLeft = noOp;
export const cursorSyntaxRight = noOp;
export const selectSyntaxLeft = noOp;
export const selectSyntaxRight = noOp;
export const cursorMatchingBracket = noOp;
export const selectParentSyntax = noOp;
export const moveLineUp = noOp;
export const moveLineDown = noOp;
export const copyLineUp = noOp;
export const copyLineDown = noOp;
export const addCursorAbove = noOp;
export const addCursorBelow = noOp;
export const simplifySelection = noOp;
export const toggleTabFocusMode = noOp;
export const temporarilySetTabFocusMode = noOp;
export const insertTab: StateCommand = ({ state, dispatch }) => {
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore({ state, dispatch });
  dispatch(
    state.update(state.replaceSelection("\t"), { scrollIntoView: true, userEvent: "input" }),
  );
  return true;
};

export const standardKeymap: readonly KeyBinding[] = [
  { key: "Mod-a", run: selectAll },
  { key: "Enter", run: insertNewlineAndIndent },
  { key: "Backspace", run: deleteCharBackwardStrict },
  { key: "Delete", run: deleteCharForward },
];

export const defaultKeymap: readonly KeyBinding[] = [
  { key: "Alt-ArrowLeft", mac: "Ctrl-ArrowLeft", run: cursorSyntaxLeft, shift: selectSyntaxLeft },
  {
    key: "Alt-ArrowRight",
    mac: "Ctrl-ArrowRight",
    run: cursorSyntaxRight,
    shift: selectSyntaxRight,
  },
  { key: "Alt-ArrowUp", run: moveLineUp },
  { key: "Shift-Alt-ArrowUp", run: copyLineUp },
  { key: "Alt-ArrowDown", run: moveLineDown },
  { key: "Shift-Alt-ArrowDown", run: copyLineDown },
  { key: "Mod-Alt-ArrowUp", run: addCursorAbove },
  { key: "Mod-Alt-ArrowDown", run: addCursorBelow },
  { key: "Escape", run: simplifySelection },
  { key: "Mod-Enter", run: insertBlankLine },
  { key: "Mod-i", run: selectParentSyntax, preventDefault: true },
  { key: "Mod-[", run: indentLess },
  { key: "Mod-]", run: indentMore },
  { key: "Mod-Alt-\\", run: indentSelection },
  { key: "Shift-Mod-k", run: deleteLine },
  { key: "Shift-Mod-\\", run: cursorMatchingBracket },
  { key: "Mod-/", run: toggleComment },
  { key: "Alt-A", run: toggleBlockComment },
  { key: "Ctrl-m", mac: "Shift-Alt-m", run: toggleTabFocusMode },
  ...standardKeymap,
];

export const indentWithTab: KeyBinding = { key: "Tab", run: indentMore, shift: indentLess };
export const emacsStyleKeymap: readonly KeyBinding[] = [];
