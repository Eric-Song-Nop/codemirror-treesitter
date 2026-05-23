import {
  EditorSelection,
  EditorState,
  type StateCommand,
  type Transaction,
} from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { moveLineDown, moveLineUp } from "../src/index.js";

function runCommand(state: EditorState, command: StateCommand) {
  let next = state;
  let dispatch = (tr: Transaction) => {
    next = tr.state;
  };
  expect(command({ state, dispatch })).toBe(true);
  return next;
}

describe("line commands", () => {
  it("moves the selected line up and down", () => {
    let state = EditorState.create({
      doc: "one\ntwo\nthree",
      selection: EditorSelection.cursor(5),
    });

    state = runCommand(state, moveLineUp);
    expect(state.doc.toString()).toBe("two\none\nthree");
    expect(state.selection.main.head).toBe(1);

    state = runCommand(state, moveLineDown);
    expect(state.doc.toString()).toBe("one\ntwo\nthree");
    expect(state.selection.main.head).toBe(5);
  });
});
