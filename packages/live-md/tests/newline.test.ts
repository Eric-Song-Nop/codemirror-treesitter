// @vitest-environment happy-dom

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

describe("newline editing", () => {
  it("inserts one editable newline for Enter at the end of a paragraph", async () => {
    let editor = await mountEditor("first");

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("first\n");
  });

  it("keeps additional blank lines editable when Enter is pressed on a blank line", async () => {
    let editor = await mountEditor("first\n\nsecond", "first\n".length);

    pressKey(editor.view, "Enter");
    pressKey(editor.view, "Enter");
    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("first\n\n\n\n\nsecond");
    expect(blankLines(editor.view)).toHaveLength(4);
  });

  it("keeps a trailing newline editable after Enter at document end", async () => {
    let editor = await mountEditor("first");

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("first\n");
    expect(editor.view.contentDOM.textContent).toBe("first");
  });

  it("inserts a raw newline for Shift+Enter", async () => {
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

  it("does not indent every following code fence line after an opening brace", async () => {
    let codeLineEnd = "```ts\nif (x) {".length;
    let editor = await mountEditor("```ts\nif (x) {\n}\n```\n\nafter", codeLineEnd);

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("```ts\nif (x) {\n\n}\n```\n\nafter");
  });

  it("keeps blank-line and soft-line breaks as ordinary editable lines", async () => {
    let blankLineDoc = await mountEditor("first\n\nsecond");
    let softBreak = await mountEditor("first\nsecond");

    expect(blankLines(blankLineDoc.view)).toHaveLength(1);
    expect(blankLines(softBreak.view)).toHaveLength(0);
  });

  it("leaves every blank line visible as regular editor content", async () => {
    let editor = await mountEditor("line1\n\n\n\n\n\nline2");

    expect(blankLines(editor.view)).toHaveLength(5);
    expect(editor.view.contentDOM.textContent).toContain("line1");
    expect(editor.view.contentDOM.textContent).toContain("line2");
  });

  it("keeps blank lines addressable from editor DOM positions", async () => {
    let editor = await mountEditor("line1\n\nline2");
    let blankLine = blankLines(editor.view)[0];

    expect(blankLine).toBeTruthy();
    expect(editor.view.posAtDOM(blankLine!, 0)).toBe("line1\n".length);
  });

  it("inserts text on a blank line", async () => {
    let editor = await mountEditor("line1\n\nline2", "line1\n".length);

    editor.view.dispatch(editor.view.state.replaceSelection("middle"));

    expect(editor.value).toBe("line1\nmiddle\nline2");
  });

  it("deletes blank lines with Backspace", async () => {
    let editor = await mountEditor("line1\n\nline2", "line1\n".length);

    pressKey(editor.view, "Backspace");

    expect(editor.value).toBe("line1\nline2");
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

function blankLines(view: EditorView) {
  return Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")).filter(
    (line) => line.textContent == "",
  );
}
