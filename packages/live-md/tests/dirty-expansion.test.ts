import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { expandLiveMdDirtyRanges, type LiveMdDirtyRange } from "../src/core/dirty-ranges.js";
import { __testLiveMdFeatureRegistry } from "../src/core/decorations.js";
import { loadMarkdownExtension } from "../src/core/languages.js";

describe("LiveMD dirty range expansion", () => {
  it("expands dirty ranges to the touched line when no feature node is matched", () => {
    let state = EditorState.create({ doc: "first\nsecond\nthird" });

    expect(expand([{ from: 8, reasons: ["text"], to: 8 }], state)).toEqual([
      { from: 6, reasons: ["text"], to: 12 },
    ]);
  });

  it("uses feature line scope for image edits", async () => {
    let doc = "![alt](one.png)\nnext";
    let state = await markdownState(doc);
    let dirtyFrom = doc.indexOf("one");

    expect(expand([{ from: dirtyFrom, reasons: ["text"], to: dirtyFrom + 3 }], state)).toEqual([
      { from: 0, reasons: ["text"], to: "![alt](one.png)".length },
    ]);
  });

  it("uses feature node scope for fenced code edits", async () => {
    let doc = "```ts\nlet a = 1;\n```\n\n```ts\nlet b = 2;\n```\n";
    let state = await markdownState(doc);
    let dirtyFrom = doc.indexOf("a = 1");
    let firstFenceTo = doc.indexOf("\n\n") + 1;

    expect(expand([{ from: dirtyFrom, reasons: ["text"], to: dirtyFrom + 1 }], state)).toEqual([
      { from: 0, reasons: ["text"], to: firstFenceTo },
    ]);
  });
});

function expand(ranges: readonly LiveMdDirtyRange[], state: EditorState) {
  return expandLiveMdDirtyRanges({
    ranges,
    registry: __testLiveMdFeatureRegistry,
    state,
  });
}

async function markdownState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [await loadMarkdownExtension()],
  });
}
