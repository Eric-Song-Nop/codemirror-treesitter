// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { __testFlushLiveMdAnalysis } from "../src/core/decorations.js";
import { createLiveMdEditor, type LiveMdEditorController } from "../src/core/editor.js";

let locationDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  document.body.replaceChildren();
  if (locationDescriptor) {
    Object.defineProperty(globalThis, "location", locationDescriptor);
  }
});

describe("LiveMD structural line classes", () => {
  it("does not leave heading classes on a blank line inserted before a heading", async () => {
    let editor = await mountEditor("# Title", 0);

    editor.view.dispatch({
      changes: { from: 0, insert: "\n" },
      selection: { anchor: 1 },
      userEvent: "input",
    });

    expect(lineAt(editor.view, 0).textContent).toBe("");
    expect(lineAt(editor.view, 0).classList.contains("cm-md-heading")).toBe(false);

    await __testFlushLiveMdAnalysis(editor.view);

    expect(lineAt(editor.view, 0).classList.contains("cm-md-heading")).toBe(false);
    expect(lineAt(editor.view, 1).textContent).toBe("# Title");
    expect(lineAt(editor.view, 1).classList.contains("cm-md-heading")).toBe(true);
  });

  it("clears list classes after deleting a list marker", async () => {
    let editor = await mountEditor("- item", "- ".length);

    editor.view.dispatch({
      changes: { from: 0, to: 2 },
      selection: { anchor: 0 },
      userEvent: "delete",
    });

    expect(lineAt(editor.view, 0).textContent).toBe("item");
    expect(lineAt(editor.view, 0).classList.contains("cm-md-list-line")).toBe(false);

    await __testFlushLiveMdAnalysis(editor.view);

    expect(lineAt(editor.view, 0).classList.contains("cm-md-list-line")).toBe(false);
  });

  it("clears table line classes after replacing the delimiter row", async () => {
    let doc = "| a | b |\n| --- | --- |";
    let delimiterFrom = doc.indexOf("| ---");
    let editor = await mountEditor(doc, delimiterFrom);

    editor.view.dispatch({
      changes: { from: delimiterFrom, to: doc.length, insert: "not a table delimiter" },
      selection: { anchor: delimiterFrom + "not a table delimiter".length },
      userEvent: "input",
    });

    let delimiterLine = lineWithText(editor.view, "not a table delimiter");
    expect(delimiterLine.classList.contains("cm-md-table-line")).toBe(false);
    expect(delimiterLine.classList.contains("cm-md-table-divider")).toBe(false);

    await __testFlushLiveMdAnalysis(editor.view);

    delimiterLine = lineWithText(editor.view, "not a table delimiter");
    expect(delimiterLine.classList.contains("cm-md-table-line")).toBe(false);
    expect(delimiterLine.classList.contains("cm-md-table-divider")).toBe(false);
  });

  it("keeps list line classes stable during pending content edits", async () => {
    let doc = "- item";
    let editor = await mountEditor(doc, doc.indexOf("item") + "it".length);

    editor.view.dispatch({
      changes: { from: editor.view.state.selection.main.head, insert: "x" },
      userEvent: "input",
    });

    expect(lineWithText(editor.view, "- itxem").classList.contains("cm-md-list-line")).toBe(true);

    await __testFlushLiveMdAnalysis(editor.view);

    expect(lineWithText(editor.view, "- itxem").classList.contains("cm-md-list-line")).toBe(true);
  });

  it("keeps quote line classes stable during pending content edits", async () => {
    let doc = "> quote";
    let editor = await mountEditor(doc, doc.indexOf("quote") + "qu".length);

    editor.view.dispatch({
      changes: { from: editor.view.state.selection.main.head, insert: "x" },
      userEvent: "input",
    });

    expect(lineWithText(editor.view, "> quxote").classList.contains("cm-md-blockquote")).toBe(true);

    await __testFlushLiveMdAnalysis(editor.view);

    expect(lineWithText(editor.view, "> quxote").classList.contains("cm-md-blockquote")).toBe(true);
  });

  it("keeps code fence line classes stable during pending content edits", async () => {
    let doc = "```ts\nlet value = 1\n```";
    let editor = await mountEditor(doc, doc.indexOf("value") + "val".length);

    editor.view.dispatch({
      changes: { from: editor.view.state.selection.main.head, insert: "x" },
      userEvent: "input",
    });

    expect(lineWithText(editor.view, "let valxue = 1").classList.contains("cm-md-code-line")).toBe(
      true,
    );

    await __testFlushLiveMdAnalysis(editor.view);

    expect(lineWithText(editor.view, "let valxue = 1").classList.contains("cm-md-code-line")).toBe(
      true,
    );
  });

  it("keeps table line classes stable during pending content edits", async () => {
    let doc = "| a | b |\n| --- | --- |";
    let editor = await mountEditor(doc, doc.indexOf("a") + 1);

    editor.view.dispatch({
      changes: { from: editor.view.state.selection.main.head, insert: "x" },
      userEvent: "input",
    });

    expect(lineWithText(editor.view, "| ax | b |").classList.contains("cm-md-table-line")).toBe(
      true,
    );
    expect(
      lineWithText(editor.view, "| --- | --- |").classList.contains("cm-md-table-divider"),
    ).toBe(true);

    await __testFlushLiveMdAnalysis(editor.view);

    expect(lineWithText(editor.view, "| ax | b |").classList.contains("cm-md-table-line")).toBe(
      true,
    );
    expect(
      lineWithText(editor.view, "| --- | --- |").classList.contains("cm-md-table-divider"),
    ).toBe(true);
  });
});

async function mountEditor(doc: string, selection = 0): Promise<LiveMdEditorController> {
  let parent = document.createElement("div");
  document.body.append(parent);
  let editor = createLiveMdEditor({ parent, doc, focus: false });
  await editor.ready;
  editor.view.dispatch({ selection: { anchor: selection } });
  return editor;
}

function lineAt(view: EditorView, index: number) {
  let line = view.contentDOM.querySelectorAll<HTMLElement>(".cm-line").item(index);
  if (!line) throw new Error(`Missing rendered line ${index}`);
  return line;
}

function lineWithText(view: EditorView, text: string) {
  let line = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")).find(
    (element) => element.textContent == text,
  );
  if (!line) throw new Error(`Missing rendered line: ${text}`);
  return line;
}
