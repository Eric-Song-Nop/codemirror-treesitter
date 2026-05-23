import { EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { closeBrackets, deleteBracketPair, insertBracket } from "../src/index.js";

describe("close brackets", () => {
  it("inserts and deletes bracket pairs", () => {
    let state = EditorState.create({ extensions: [closeBrackets()] });
    state = insertBracket(state, "(")!.state;

    expect(state.doc.toString()).toBe("()");
    expect(state.selection.main.head).toBe(1);

    let dispatch = (tr: Transaction) => {
      state = tr.state;
    };
    expect(deleteBracketPair({ state, dispatch })).toBe(true);
    expect(state.doc.toString()).toBe("");
  });
});
