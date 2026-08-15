// @vitest-environment happy-dom

import DOMPurify from "dompurify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createLiveMdEditor, type LiveMdEditorController } from "../src/core/editor.js";

// Current security-hardened DOMPurify releases deliberately fail closed against
// happy-dom's incomplete SVG implementation. The subprocess security regression
// exercises the real sanitizer; this integration suite isolates LiveMD's renderer routing.
vi.spyOn(DOMPurify, "sanitize").mockImplementation((value) => value as string);

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

  it("renders supported diagrams with beautiful-mermaid", async () => {
    let doc = "```mermaid\nflowchart TD\n  A[Start] --> B{Decision}\n```\n\nnext";
    let editor = await mountEditor(doc, "next");
    let widget = editor.view.contentDOM.querySelector<HTMLElement>(".cm-md-mermaid");

    expect(widget).toBeTruthy();
    let svg = await waitForMermaidSvg(widget!);

    expect(svg.getAttribute("style")).toContain("--live-md-mermaid-accent");
    expect(svg.outerHTML).toContain("Start");
    expect(svg.outerHTML).toContain("--live-md-mermaid-font");
    expect(svg.outerHTML).not.toContain("fonts.googleapis.com");
  });

  it("falls back to the official Mermaid renderer for unsupported beautiful-mermaid syntax", async () => {
    let doc = "```mermaid\ngraph LR; A --> B\n```\n\nnext";
    let editor = await mountEditor(doc, "next");
    let widget = editor.view.contentDOM.querySelector<HTMLElement>(".cm-md-mermaid");

    expect(widget).toBeTruthy();
    let svg = await waitForMermaidSvg(widget!);

    expect(svg.id).toMatch(/^cm-md-mermaid-/);
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

async function waitForMermaidSvg(widget: HTMLElement) {
  for (let attempt = 0; attempt < 20; attempt++) {
    let svg = widget.querySelector<SVGElement>("svg");
    if (svg) return svg;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected Mermaid preview to render an SVG: ${widget.outerHTML}`);
}
