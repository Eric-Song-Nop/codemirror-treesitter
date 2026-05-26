// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror-treesitter/language";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createLiveMdEditor } from "../src/core/editor.js";
import { loadMarkdownExtension } from "../src/core/languages.js";

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

describe("code fence at end of document", () => {
  it("tree-sitter should include closing delimiter for code fence at EOF", async () => {
    let markdown = await loadMarkdownExtension();

    // Test without trailing newline
    let stateNoNewline = EditorState.create({
      doc: "```ts\nconst x = 1;\n```",
      extensions: [markdown],
    });

    let tree = syntaxTree(stateNoNewline);
    let fencedBlocks: Array<{ delimiters: number; hasContent: boolean }> = [];

    tree.iterate({
      enter(node) {
        if (node.name === "fenced_code_block") {
          let delimiters = node.children.filter(
            (child) => child.name === "fenced_code_block_delimiter",
          );
          fencedBlocks.push({
            delimiters: delimiters.length,
            hasContent: node.getChild("code_fence_content") !== null,
          });
        }
      },
    });

    expect(fencedBlocks).toHaveLength(1);

    // Test with trailing newline
    let stateWithNewline = EditorState.create({
      doc: "```ts\nconst x = 1;\n```\n",
      extensions: [markdown],
    });

    let fencedBlocksWithNewline: Array<{ delimiters: number; hasContent: boolean }> = [];
    syntaxTree(stateWithNewline).iterate({
      enter(node) {
        if (node.name === "fenced_code_block") {
          let delimiters = node.children.filter(
            (child) => child.name === "fenced_code_block_delimiter",
          );
          fencedBlocksWithNewline.push({
            delimiters: delimiters.length,
            hasContent: node.getChild("code_fence_content") !== null,
          });
        }
      },
    });

    expect(fencedBlocks[0]).toEqual({ delimiters: 2, hasContent: true });
    expect(fencedBlocksWithNewline[0]).toEqual({ delimiters: 2, hasContent: true });
  });

  it("closing delimiter should be hidden when cursor is not on that line (no trailing newline)", async () => {
    let parent = document.createElement("div");
    document.body.append(parent);

    let editor = createLiveMdEditor({
      parent,
      doc: "```ts\nconst x = 1;\n```",
      focus: false,
    });

    await editor.ready;

    let closingLine = editor.view.contentDOM.querySelectorAll(".cm-line").item(2);
    let closingSpan = Array.from(closingLine.querySelectorAll("span")).find((span) =>
      span.textContent?.includes("```"),
    );

    expect(closingSpan).toBeTruthy();
    expect(closingSpan?.classList.contains("cm-md-syntax-hidden")).toBe(true);
    expect(closingLine.classList.contains("cm-md-code-fence-line")).toBe(true);
    expect(closingLine.classList.contains("cm-md-code-line")).toBe(false);
  });

  it("closing delimiter should be hidden when cursor is not on that line (with trailing newline)", async () => {
    let parent = document.createElement("div");
    document.body.append(parent);

    let editor = createLiveMdEditor({
      parent,
      doc: "```ts\nconst x = 1;\n```\n",
      focus: false,
    });

    await editor.ready;

    let closingLine = editor.view.contentDOM.querySelectorAll(".cm-line").item(2);
    let closingSpan = Array.from(closingLine.querySelectorAll("span")).find((span) =>
      span.textContent?.includes("```"),
    );

    expect(closingSpan).toBeTruthy();
    expect(closingSpan?.classList.contains("cm-md-syntax-hidden")).toBe(true);
    expect(closingLine.classList.contains("cm-md-code-fence-line")).toBe(true);
    expect(closingLine.classList.contains("cm-md-code-line")).toBe(false);
  });
});
