import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  CompletionContext,
  completeFromList,
  hasNextSnippetField,
  insertCompletionText,
  snippet,
} from "../src/index.js";

describe("completion helpers", () => {
  it("matches text directly before the cursor", () => {
    let state = EditorState.create({
      doc: "/** @pa */",
      selection: EditorSelection.cursor(7),
    });
    let context = new CompletionContext(state, 7, true);

    expect(context.matchBefore(/@\w*/)).toEqual({ from: 4, to: 7, text: "@pa" });
  });

  it("builds a transaction that inserts completion text and moves the cursor", () => {
    let state = EditorState.create({
      doc: "/** @pa */",
      selection: EditorSelection.cursor(7),
    });

    let tr = state.update(insertCompletionText(state, "@param", 4, 7));

    expect(tr.state.doc.toString()).toBe("/** @param */");
    expect(tr.state.selection.main.head).toBe(10);
  });

  it("creates fixed-list completion sources", () => {
    let state = EditorState.create({
      doc: "/** @pa */",
      selection: EditorSelection.cursor(7),
    });
    let source = completeFromList([{ label: "@param" }, { label: "@returns" }]);
    let result = source(new CompletionContext(state, 7, true));

    expect(result && "then" in result).toBe(false);
    expect(result && !("then" in result) ? result.from : null).toBe(4);
    expect(
      result && !("then" in result) ? result.options.map((option) => option.label) : [],
    ).toEqual(["@param", "@returns"]);
  });

  it("skips fixed-list completions without a token unless explicit", () => {
    let state = EditorState.create({
      doc: "/**  */",
      selection: EditorSelection.cursor(4),
    });
    let source = completeFromList([{ label: "@param" }]);

    expect(source(new CompletionContext(state, 4, false))).toBe(null);
  });

  it("registers completion context abort handlers", () => {
    let state = EditorState.create({ doc: "value" });
    let context = new CompletionContext(state, 5, true);
    let aborted = false;

    context.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { onDocChange: true },
    );
    context.abortListeners?.forEach((listener) => listener());
    context.abortListeners = null;

    expect(aborted).toBe(true);
    expect(context.abortOnDocChange).toBe(true);
    expect(context.aborted).toBe(true);
  });

  it("applies snippets and selects the first field", () => {
    let state = EditorState.create({
      doc: "fn",
      selection: EditorSelection.cursor(2),
    });
    let apply = snippet("function ${name}() {\n\t${}\n}");
    let dispatch = (tr: Transaction) => {
      state = tr.state;
    };

    apply({ state, dispatch }, null, 0, 2);

    expect(state.doc.toString()).toBe("function name() {\n  \n}");
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("name");
    expect(hasNextSnippetField(state)).toBe(true);
  });
});
