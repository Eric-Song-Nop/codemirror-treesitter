// @vitest-environment happy-dom

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { __testLiveMdAnalysis } from "../src/core/decorations.js";
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
    expect(countLineClass(editor.view, "cm-md-block-separator")).toBe(0);
  });

  it("keeps a trailing newline editable after Enter at document end", async () => {
    let editor = await mountEditor("first");

    pressKey(editor.view, "Enter");

    expect(editor.value).toBe("first\n");
    expect(countLineClass(editor.view, "cm-md-block-separator")).toBe(0);
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

  it("does not decorate blank lines as paragraph separators", async () => {
    let paragraphBreak = await mountEditor("first\n\nsecond");
    let softBreak = await mountEditor("first\nsecond");

    expect(hasLineClass(paragraphBreak.view, "cm-md-block-separator")).toBe(false);
    expect(hasLineClass(softBreak.view, "cm-md-block-separator")).toBe(false);
  });

  it("leaves every blank line visible as regular editor content", async () => {
    let editor = await mountEditor("line1\n\n\n\n\n\nline2");

    expect(countLineClass(editor.view, "cm-md-block-separator")).toBe(0);
    expect(editor.view.contentDOM.textContent).toContain("line1");
    expect(editor.view.contentDOM.textContent).toContain("line2");
  });

  it("does not add atomic cursor ranges for blank lines", async () => {
    let editor = await mountEditor("line1\n\nline2");
    let atomicRanges: Array<{ from: number; to: number }> = [];

    __testLiveMdAnalysis(editor.view).atomicRanges.between(0, editor.value.length, (from, to) => {
      atomicRanges.push({ from, to });
    });

    expect(atomicRanges).toEqual([]);
  });

  it("keeps blank lines addressable from editor DOM positions", async () => {
    let editor = await mountEditor("line1\n\nline2");
    let blankLine = blankLines(editor.view)[0];

    expect(blankLine).toBeTruthy();
    expect(editor.view.posAtDOM(blankLine!, 0)).toBe("line1\n".length);
  });

  it("moves through blank lines without atomic jumps", async () => {
    let editor = await mountEditor("line1\n\nline2", "line1".length);
    let firstStep = editor.view.moveByChar(editor.view.state.selection.main, true);
    let secondStep = editor.view.moveByChar(EditorSelection.cursor(firstStep.head), true);

    expect(firstStep.head).toBe("line1\n".length);
    expect(secondStep.head).toBe("line1\n\n".length);

    let back = editor.view.moveByChar(EditorSelection.cursor(secondStep.head), false);
    expect(back.head).toBe("line1\n".length);
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

  it("does not decorate gaps between markdown block siblings", async () => {
    let editor = await mountEditor("first\n\n## Heading\n\n---\n\n```ts\ncode\n```\n\nsecond");

    expect(countLineClass(editor.view, "cm-md-block-separator")).toBe(0);
  });

  it("does not decorate gaps between list items", async () => {
    let editor = await mountEditor("- first\n\n- second");

    expect(hasLineClass(editor.view, "cm-md-block-separator")).toBe(false);
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

function blankLines(view: EditorView) {
  return Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")).filter(
    (line) => line.textContent == "",
  );
}
