import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { filterCompletionOptions } from "../src/filter.js";
import { CompletionContext, insertCompletionText } from "../src/index.js";

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

  it("filters completion options by the existing prefix", () => {
    let state = EditorState.create({
      doc: "/** @pa */",
      selection: EditorSelection.cursor(7),
    });
    let options = filterCompletionOptions(
      state,
      {
        options: [{ label: "@param" }, { label: "@returns" }, { label: "@deprecated" }],
      },
      4,
      7,
    );

    expect(options.map((option) => option.label)).toEqual(["@param"]);
  });

  it("keeps source order when filtering is disabled", () => {
    let state = EditorState.create({
      doc: "/** @pa */",
      selection: EditorSelection.cursor(7),
    });
    let options = filterCompletionOptions(
      state,
      {
        filter: false,
        options: [{ label: "@param" }, { label: "@returns" }, { label: "@deprecated" }],
      },
      4,
      7,
    );

    expect(options.map((option) => option.label)).toEqual(["@param", "@returns", "@deprecated"]);
  });
});
