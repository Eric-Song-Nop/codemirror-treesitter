import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { indentLess, indentMore, insertTab } from "../src/index.js";

function commandState(state: EditorState, run: typeof indentMore) {
  let next = state;
  let dispatch = (tr: Transaction) => {
    next = tr.state;
  };
  expect(run({ state, dispatch })).toBe(true);
  return next;
}

describe("indent commands", () => {
  it("moves the cursor along when indenting the current line", () => {
    let state = EditorState.create({
      doc: "first\nsecond",
      selection: EditorSelection.cursor(6),
    });

    state = commandState(state, indentMore);

    expect(state.doc.toString()).toBe("first\n  second");
    expect(state.selection.main.head).toBe(8);
  });

  it("moves the cursor back when dedenting the current line", () => {
    let state = EditorState.create({
      doc: "first\n  second",
      selection: EditorSelection.cursor(8),
    });

    state = commandState(state, indentLess);

    expect(state.doc.toString()).toBe("first\nsecond");
    expect(state.selection.main.head).toBe(6);
  });

  it("inserts a literal tab for an empty selection", () => {
    let state = EditorState.create({
      doc: "first",
      selection: EditorSelection.cursor(2),
    });

    state = commandState(state, insertTab);

    expect(state.doc.toString()).toBe("fi\trst");
    expect(state.selection.main.head).toBe(3);
  });

  it("indents selected text instead of replacing it with a tab", () => {
    let state = EditorState.create({
      doc: "first\nsecond",
      selection: EditorSelection.range(6, 12),
    });

    state = commandState(state, insertTab);

    expect(state.doc.toString()).toBe("first\n  second");
    expect(state.selection.main.from).toBe(8);
    expect(state.selection.main.to).toBe(14);
  });
});
