// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { queryTreeMatches, syntaxTree } from "@codemirror-treesitter/language";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createLiveMdEditor } from "../src/core/editor.js";
import { codeFenceLanguagesField, loadMarkdownExtension } from "../src/core/languages.js";
import codeFenceQuerySource from "./queries/code-fence.scm?raw";

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
  it("loads no code grammar for plain Markdown and loads a newly encountered fence on demand", async () => {
    let parent = document.createElement("div");
    document.body.append(parent);
    let editor = createLiveMdEditor({ parent, doc: "plain Markdown", focus: false });

    await editor.ready;
    expect(editor.view.state.field(codeFenceLanguagesField).size).toBe(0);

    editor.setValue("```python\nprint('ready')\n```\n");
    await waitForCodeFenceLanguage(editor, "python");

    let languages = editor.view.state.field(codeFenceLanguagesField);
    expect(languages.has("python")).toBe(true);
    expect(languages.has("typescript")).toBe(false);
    editor.destroy();
  });

  it("loads grammars from actual nested fence syntax and edited info strings", async () => {
    for (let [opening, continuation] of [
      ["> ", "> "],
      ["- ", "  "],
      ["> 1. ", ">    "],
    ]) {
      let parent = document.createElement("div");
      document.body.append(parent);
      let editor = createLiveMdEditor({
        parent,
        doc: `${opening}\`\`\`ts\n${continuation}const value = 1;\n${continuation}\`\`\``,
        focus: false,
      });
      try {
        await editor.ready;
        expect(editor.view.state.field(codeFenceLanguagesField).has("ts")).toBe(true);
        let from = editor.value.indexOf("ts");
        editor.view.dispatch({ changes: { from, to: from + 2, insert: "python" } });
        await waitForCodeFenceLanguage(editor, "python");
      } finally {
        editor.destroy();
      }
    }
  });

  it("does not let an indented code block hide a later real fence from discovery", async () => {
    let parent = document.createElement("div");
    document.body.append(parent);
    let editor = createLiveMdEditor({
      parent,
      doc: "    ```typescript\n    this is indented code\n\n```python\nprint(1)\n```",
      focus: false,
    });
    try {
      await editor.ready;
      expect(editor.view.state.field(codeFenceLanguagesField).has("python")).toBe(true);
      expect(editor.view.state.field(codeFenceLanguagesField).has("typescript")).toBe(false);
    } finally {
      editor.destroy();
    }
  });
  it("tree-sitter should include closing delimiter for code fence at EOF", async () => {
    let markdown = await loadMarkdownExtension();

    // Test without trailing newline
    let stateNoNewline = EditorState.create({
      doc: "```ts\nconst x = 1;\n```",
      extensions: [markdown],
    });

    let tree = syntaxTree(stateNoNewline);
    let fencedBlocks = codeFenceSnapshots(tree);

    expect(fencedBlocks).toHaveLength(1);

    // Test with trailing newline
    let stateWithNewline = EditorState.create({
      doc: "```ts\nconst x = 1;\n```\n",
      extensions: [markdown],
    });

    let fencedBlocksWithNewline = codeFenceSnapshots(syntaxTree(stateWithNewline));

    expect(fencedBlocks[0]).toEqual({ delimiters: 2, hasContent: true });
    expect(fencedBlocksWithNewline[0]).toEqual({ delimiters: 2, hasContent: true });
  });

  it("keeps the closing delimiter visible in an active fence source island at EOF", async () => {
    let parent = document.createElement("div");
    document.body.append(parent);

    let editor = createLiveMdEditor({
      parent,
      doc: "```ts\nconst x = 1;\n```",
      focus: false,
    });

    await editor.ready;

    let closingLine = editor.view.contentDOM.querySelectorAll(".cm-line").item(2);
    let openingLine = editor.view.contentDOM.querySelectorAll(".cm-line").item(0);
    let closingSpan = Array.from(closingLine.querySelectorAll("span")).find((span) =>
      span.textContent?.includes("```"),
    );

    expect(closingSpan).toBeTruthy();
    expect(closingSpan?.classList.contains("cm-md-syntax-active")).toBe(true);
    expect(closingSpan?.classList.contains("cm-md-syntax-hidden")).toBe(false);
    expect(openingLine.classList.contains("cm-md-code-block-start")).toBe(true);
    expect(closingLine.classList.contains("cm-md-code-fence-line")).toBe(true);
    expect(closingLine.classList.contains("cm-md-code-block-end")).toBe(true);
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
    editor.view.dispatch({ selection: { anchor: editor.value.length } });

    let closingLine = editor.view.contentDOM.querySelectorAll(".cm-line").item(2);
    let openingLine = editor.view.contentDOM.querySelectorAll(".cm-line").item(0);
    let closingSpan = Array.from(closingLine.querySelectorAll("span")).find((span) =>
      span.textContent?.includes("```"),
    );

    expect(closingSpan).toBeTruthy();
    expect(closingSpan?.classList.contains("cm-md-syntax-hidden")).toBe(true);
    expect(openingLine.classList.contains("cm-md-code-block-start")).toBe(true);
    expect(closingLine.classList.contains("cm-md-code-fence-line")).toBe(true);
    expect(closingLine.classList.contains("cm-md-code-block-end")).toBe(true);
    expect(closingLine.classList.contains("cm-md-code-line")).toBe(false);
  });

  it("adds code line classes to empty physical lines inside fenced code", async () => {
    let parent = document.createElement("div");
    document.body.append(parent);

    let editor = createLiveMdEditor({
      parent,
      doc: "```ts\ntype Note = {\n  title: string;\n  done: boolean;\n\n\n};\n```",
      focus: false,
    });

    await editor.ready;

    let lines = Array.from(editor.view.contentDOM.querySelectorAll(".cm-line"));
    let contentLines = lines.slice(1, 7);
    let closingLine = lines[7]!;

    expect(lines).toHaveLength(8);
    expect(contentLines.map((line) => line.classList.contains("cm-md-code-line"))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(contentLines.map((line) => line.textContent)).toEqual([
      "type Note = {",
      "  title: string;",
      "  done: boolean;",
      "",
      "",
      "};",
    ]);
    expect(closingLine.classList.contains("cm-md-code-line")).toBe(false);
  });
});

async function waitForCodeFenceLanguage(
  editor: ReturnType<typeof createLiveMdEditor>,
  language: string,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (editor.view.state.field(codeFenceLanguagesField).has(language)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out loading ${language}`);
}

function codeFenceSnapshots(tree: ReturnType<typeof syntaxTree>) {
  return queryTreeMatches(tree, codeFenceQuerySource, { includeNested: false }).map((match) => ({
    delimiters: match.captures.filter((capture) => capture.name == "codeFence.delimiter").length,
    hasContent: match.captures.some((capture) => capture.name == "codeFence.content"),
  }));
}
