// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror-treesitter/language";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createLiveMdEditor } from "../src/core/editor.js";
import { liveMarkdown } from "../src/core/extension.js";
import { loadMarkdownExtension } from "../src/core/languages.js";
import { __testIsLiveMdSearchVisible } from "../src/core/search.js";

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

describe("LiveMD Markdown parser service", () => {
  it("installs a block-only Markdown language while preserving explicit inline visibility", async () => {
    let doc = [
      "Text with *emphasis* and [Label](https://hidden.example).",
      "![Alt text](image.png)",
    ].join("\n");
    let state = EditorState.create({
      doc,
      extensions: [await loadMarkdownExtension(), liveMarkdown()],
    });
    ensureSyntaxTree(state, doc.length, 5_000);

    expect(syntaxTree(state).nested).toHaveLength(0);
    expectRangeVisible(state, doc, "emphasis", true);
    expectRangeVisible(state, doc, "Label", true);
    expectRangeVisible(state, doc, "Alt text", true);
    expectRangeVisible(state, doc, "*", false);
    expectRangeVisible(state, doc, "https://hidden.example", false);
    expectRangeVisible(state, doc, "image.png", false);
  });

  it("keeps Markdown commands on the block-only tree", async () => {
    let parent = document.createElement("div");
    document.body.append(parent);
    let editor = createLiveMdEditor({
      parent,
      doc: "- item",
      focus: false,
    });
    await editor.ready;

    expect(syntaxTree(editor.view.state).nested).toHaveLength(0);
    editor.view.dispatch({ selection: { anchor: editor.value.length } });
    pressKey(editor.view.contentDOM, "Enter");

    expect(editor.value).toBe("- item\n- ");
    editor.destroy();
  });
});

function expectRangeVisible(state: EditorState, doc: string, needle: string, expected: boolean) {
  let from = doc.indexOf(needle);
  expect(from, needle).toBeGreaterThanOrEqual(0);
  expect(__testIsLiveMdSearchVisible(state, from, from + needle.length), needle).toBe(expected);
}

function pressKey(target: HTMLElement, key: string) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key,
      bubbles: true,
      cancelable: true,
    }),
  );
}
