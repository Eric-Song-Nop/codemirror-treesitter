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

describe("mermaid rendering", () => {
  it("renders a mermaid fence as a block preview away from the active line", async () => {
    let doc = "```mermaid\nflowchart TD\n  A --> B\n```\n\nnext";
    let editor = await mountEditor(doc, "next");

    let widget = editor.view.contentDOM.querySelector<HTMLElement>(".cm-md-mermaid");
    expect(widget).toBeTruthy();
    expect(widget?.tagName).toBe("DIV");
    expect(widget?.dataset.source).toBe("flowchart TD\n  A --> B");
    expect(editor.view.contentDOM.textContent).not.toContain("```mermaid");
  });

  it("supports the mmd fence alias", async () => {
    let editor = await mountEditor("```mmd\nflowchart TD\n  A --> B\n```\n\nnext", "next");

    expect(editor.view.contentDOM.querySelector(".cm-md-mermaid")).toBeTruthy();
  });

  it("keeps mermaid source editable on the active line", async () => {
    let doc = "```mermaid\nflowchart TD\n  A --> B\n```\n\nnext";
    let editor = await mountEditor(doc, "next");
    expect(editor.view.contentDOM.querySelector(".cm-md-mermaid")).toBeTruthy();

    editor.view.dispatch({ selection: { anchor: doc.indexOf("A --> B") } });

    expect(editor.view.contentDOM.querySelector(".cm-md-mermaid")).toBeNull();
    expect(editor.view.contentDOM.textContent).toContain("```mermaid");
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
