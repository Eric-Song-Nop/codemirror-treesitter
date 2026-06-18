// @vitest-environment happy-dom

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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

describe("paragraph breaks", () => {
  it("inserts a markdown paragraph break for Enter at the end of a paragraph", async () => {
    let editor = await mountEditor("first");

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("first\n\n");
  });

  it("keeps additional blank lines visible when Enter is pressed on a paragraph separator", async () => {
    let editor = await mountEditor("first\n\nsecond", "first\n".length);

    pressKey(editor.view, "Enter");
    pressKey(editor.view, "Enter");
    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("first\n\n\n\n\n\n\n\nsecond");

    let separatorCount = countLineClass(editor.view, "cm-md-block-separator");
    let fillCount = countLineClass(editor.view, "cm-md-block-separator-fill");
    expect(separatorCount).toBe(4);
    expect(fillCount).toBe(0);
  });

  it("decorates a trailing paragraph separator immediately after Enter at document end", async () => {
    let editor = await mountEditor("first");

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("first\n\n");
    expect(countLineClass(editor.view, "cm-md-block-separator")).toBe(1);
    expect(countLineClass(editor.view, "cm-md-block-separator-fill")).toBe(0);
  });

  it("decorates repeated trailing paragraph separators after consecutive Enter at document end", async () => {
    let editor = await mountEditor("first");

    pressKey(editor.view, "Enter");
    pressKey(editor.view, "Enter");
    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("first\n\n\n\n\n\n");
    expect(countLineClass(editor.view, "cm-md-block-separator")).toBe(3);
    expect(countLineClass(editor.view, "cm-md-block-separator-fill")).toBe(0);
  });

  it("inserts a soft line break for Shift+Enter", async () => {
    let editor = await mountEditor("first");

    pressKey(editor.view, "Enter", { shiftKey: true });

    expect(editor.value).toBe("first\n");
  });

  it("lets pipe table rows continue with a normal newline", async () => {
    let editor = await mountEditor("| Name | Value |");

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("| Name | Value |\n");
  });

  it("keeps list continuation behavior on Enter", async () => {
    let editor = await mountEditor("- first");

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("- first\n- ");
  });

  it("keeps task continuation behavior on Enter", async () => {
    let editor = await mountEditor("- [x] first");

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("- [x] first\n- [ ] ");
  });

  it("keeps block quote continuation behavior on Enter", async () => {
    let editor = await mountEditor("> first");

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("> first\n> ");
  });

  it("does not duplicate a block quote marker when Enter is pressed before it", async () => {
    let editor = await mountEditor("line 1\n> quote text", "line 1\n".length);

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("line 1\n\n> quote text");
  });

  it("does not duplicate a list marker when Enter is pressed before it", async () => {
    let editor = await mountEditor("line 1\n- list item", "line 1\n".length);

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("line 1\n\n- list item");
  });

  it("falls through to the default newline behavior inside code fences", async () => {
    let codeLineEnd = "```ts\nconst value = 1;".length;
    let editor = await mountEditor("```ts\nconst value = 1;\n```", codeLineEnd);

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("```ts\nconst value = 1;\n\n```");
  });

  it("decorates paragraph separator gaps without touching soft line breaks", async () => {
    let paragraphBreak = await mountEditor("first\n\nsecond");
    let softBreak = await mountEditor("first\nsecond");

    expect(hasLineClass(paragraphBreak.view, "cm-md-block-separator")).toBe(true);
    expect(hasLineClass(softBreak.view, "cm-md-block-separator")).toBe(false);
  });

  it("renders each newline pair in a block gap as one paragraph separator", async () => {
    let editor = await mountEditor("line1\n\n\n\n\n\nline2");

    expect(countLineClass(editor.view, "cm-md-block-separator")).toBe(3);
    expect(countLineClass(editor.view, "cm-md-block-separator-fill")).toBe(0);
  });

  it("treats paragraph separators as atomic cursor ranges", async () => {
    let editor = await mountEditor("line1\n\nline2");

    expect(editor.view.moveByChar(EditorSelection.cursor("line1".length), true).head).toBe(
      "line1\n\n".length,
    );
    expect(editor.view.moveByChar(EditorSelection.cursor("line1\n\n".length), false).head).toBe(
      "line1".length,
    );
  });

  it("decorates separator gaps between markdown block siblings", async () => {
    let editor = await mountEditor("first\n\n## Heading\n\n---\n\n```ts\ncode\n```\n\nsecond");

    expect(countLineClass(editor.view, "cm-md-block-separator")).toBe(4);
  });

  it("decorates separator gaps between list items", async () => {
    let editor = await mountEditor("- first\n\n- second");

    expect(hasLineClass(editor.view, "cm-md-block-separator")).toBe(true);
  });
});

async function mountEditor(doc: string, selection = doc.length): Promise<LiveMdEditorController> {
  let parent = document.createElement("div");
  document.body.append(parent);
  let editor = createLiveMdEditor({ parent, doc, focus: false });
  await editor.ready;
  editor.view.dispatch({ selection: { anchor: selection } });
  return editor;
}

function pressKey(view: EditorView, key: string, init: KeyboardEventInit = {}) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

function hasLineClass(view: EditorView, className: string) {
  return Array.from(view.contentDOM.querySelectorAll(".cm-line")).some((line) =>
    line.classList.contains(className),
  );
}

function countLineClass(view: EditorView, className: string) {
  return Array.from(view.contentDOM.querySelectorAll(".cm-line")).filter((line) =>
    line.classList.contains(className),
  ).length;
}
