import { EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { history, redo, redoDepth, undo, undoDepth } from "../src/index.js";

describe("history", () => {
  it("undoes and redoes document changes", () => {
    let state = EditorState.create({ doc: "a", extensions: [history()] });
    state = state.update({ changes: { from: 1, insert: "b" } }).state;

    let dispatch = (tr: Transaction) => {
      state = tr.state;
    };

    expect(undoDepth(state)).toBe(1);
    expect(undo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe("a");
    expect(redoDepth(state)).toBe(1);
    expect(redo({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe("ab");
  });
});
