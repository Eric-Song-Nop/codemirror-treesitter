// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
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

describe("latex rendering", () => {
  it("renders inline latex with KaTeX away from the active line", async () => {
    let editor = await mountEditor("$x^2 + y^2$\n\nnext", "next");

    let widget = editor.view.contentDOM.querySelector(".cm-md-latex-inline");
    expect(widget).toBeTruthy();
    expect(widget?.querySelector(".katex")).toBeTruthy();
    expect(widget?.textContent).toContain("x");
  });

  it("renders display latex as a block widget when it owns the line", async () => {
    let editor = await mountEditor("$$x^2 + y^2$$\n\nnext", "next");

    let widget = editor.view.contentDOM.querySelector(".cm-md-latex-display");
    expect(widget).toBeTruthy();
    expect(widget?.tagName).toBe("DIV");
    expect(widget?.querySelector(".katex-display")).toBeTruthy();
  });

  it("keeps latex source editable on the active line", async () => {
    let editor = await mountEditor("$x^2$\n\nnext", "next");
    expect(editor.view.contentDOM.querySelector(".cm-md-latex-inline")).toBeTruthy();

    editor.view.dispatch({ selection: { anchor: 1 } });

    expect(editor.view.contentDOM.querySelector(".cm-md-latex-inline")).toBeNull();
    expect(editor.view.contentDOM.textContent).toContain("$x^2$");
  });

  it("does not throw when KaTeX reports invalid latex", async () => {
    let editor = await mountEditor("$\\sqrt{$\n\nnext", "next");

    expect(editor.view.contentDOM.querySelector(".cm-md-latex-inline")).toBeTruthy();
  });
});

async function mountEditor(doc: string, selectText: string): Promise<LiveMdEditorController> {
  let parent = document.createElement("div");
  document.body.append(parent);
  let editor = createLiveMdEditor({ parent, doc, focus: false });
  await editor.ready;
  editor.view.dispatch({ selection: { anchor: doc.indexOf(selectText) } });
  return editor;
}
