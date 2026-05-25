// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { highlightTree, syntaxTree } from "@codemirror-treesitter/language";
import { EditorView } from "@codemirror/view";
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

    // Debug: print tree structure for EOF code fence
    let tree2 = syntaxTree(stateNoNewline);
    tree2.iterate({
      enter(node) {
        if (node.name === "fenced_code_block") {
          console.log("NO NEWLINE fenced_code_block children:");
          for (let child of node.children) {
            console.log(`  ${child.name}: "${stateNoNewline.sliceDoc(child.from, child.to)}" (${child.from}-${child.to})`);
          }
        }
      },
    });

    // Test with trailing newline
    let stateWithNewline = EditorState.create({
      doc: "```ts\nconst x = 1;\n```\n",
      extensions: [markdown],
    });

    let tree3 = syntaxTree(stateWithNewline);
    tree3.iterate({
      enter(node) {
        if (node.name === "fenced_code_block") {
          console.log("WITH NEWLINE fenced_code_block children:");
          for (let child of node.children) {
            console.log(`  ${child.name}: "${stateWithNewline.sliceDoc(child.from, child.to)}" (${child.from}-${child.to})`);
          }
        }
      },
    });

    expect(fencedBlocks[0]).toEqual({ delimiters: 2, hasContent: true });
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

    // Get all elements with the closing ``` text
    let contentDOM = editor.view.contentDOM;
    let spans = contentDOM.querySelectorAll("span");

    // Find spans containing ```
    let backtickSpans = Array.from(spans).filter((span) =>
      span.textContent?.includes("`"),
    );

    console.log("NO NEWLINE spans with backticks:");
    backtickSpans.forEach((span) => {
      console.log(`  class="${span.className}" text="${span.textContent}"`);
    });

    // The closing ``` should have cm-md-syntax-hidden class
    let closingSpan = backtickSpans.find((span) => {
      let text = span.textContent || "";
      return text.includes("```") && !text.includes("ts");
    });

    expect(closingSpan).toBeTruthy();
    expect(closingSpan?.classList.contains("cm-md-syntax-hidden")).toBe(true);
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

    // Get all elements with the closing ``` text
    let contentDOM = editor.view.contentDOM;
    let spans = contentDOM.querySelectorAll("span");

    // Find spans containing ```
    let backtickSpans = Array.from(spans).filter((span) =>
      span.textContent?.includes("`"),
    );

    console.log("WITH NEWLINE spans with backticks:");
    backtickSpans.forEach((span) => {
      console.log(`  class="${span.className}" text="${span.textContent}"`);
    });

    // Find all spans that contain ``` and assert at least one is hidden
    let codeFenceSpans = backtickSpans.filter((span) => {
      let text = span.textContent || "";
      return text.includes("```") && !text.includes("ts");
    });

    expect(codeFenceSpans.length).toBeGreaterThanOrEqual(2); // opening + closing
    expect(codeFenceSpans.some((span) => span.classList.contains("cm-md-syntax-hidden"))).toBe(true);
  });
});
