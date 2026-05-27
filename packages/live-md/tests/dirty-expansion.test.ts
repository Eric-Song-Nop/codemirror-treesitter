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

  it("uses touched line scope for plain paragraph text edits", async () => {
    let doc = "first paragraph\n\nsecond paragraph\nthird line";
    let state = await markdownState(doc);
    let dirtyFrom = doc.indexOf("third");
    let dirtyLine = state.doc.lineAt(dirtyFrom);

    expect(expand([{ from: dirtyFrom, reasons: ["text"], to: dirtyFrom + 1 }], state)).toEqual([
      { from: dirtyLine.from, reasons: ["text"], to: dirtyLine.to },
    ]);
  });

  it("uses touched line scope for text-only edits in block gaps", async () => {
    let doc = "first\n\nsecond\n\nthird";
    let state = await markdownState(doc);
    let dirtyFrom = doc.indexOf("\n\nsecond") + 1;
    let dirtyLine = state.doc.lineAt(dirtyFrom);

    expect(expand([{ from: dirtyFrom, reasons: ["text"], to: dirtyFrom + 1 }], state)).toEqual([
      { from: dirtyLine.from, reasons: ["text"], to: dirtyFrom + 1 },
    ]);
  });

  it("keeps syntax edits in block gaps scoped to their container", async () => {
    let doc = "first\n\nsecond\n\nthird";
    let state = await markdownState(doc);
    let dirtyFrom = doc.indexOf("\n\nsecond") + 1;

    expect(expand([{ from: dirtyFrom, reasons: ["syntax"], to: dirtyFrom + 1 }], state)).toEqual([
      { from: 0, reasons: ["syntax"], to: doc.length + 1 },
    ]);
  });

  it("uses touched line scope for text-only edits in list item block gaps", async () => {
    let doc = "- first\n\n  second\n  third";
    let state = await markdownState(doc);
    let dirtyFrom = doc.indexOf("\n\n  second") + 1;
    let dirtyLine = state.doc.lineAt(dirtyFrom);

    expect(expand([{ from: dirtyFrom, reasons: ["text"], to: dirtyFrom + 1 }], state)).toEqual([
      { from: dirtyLine.from, reasons: ["text"], to: dirtyFrom + 1 },
    ]);
  });

  it("keeps syntax edits in list item block gaps scoped to the list item", async () => {
    let doc = "- first\n\n  second\n  third";
    let state = await markdownState(doc);
    let dirtyFrom = doc.indexOf("\n\n  second") + 1;

    expect(expand([{ from: dirtyFrom, reasons: ["syntax"], to: dirtyFrom + 1 }], state)).toEqual([
      { from: 0, reasons: ["syntax"], to: doc.length + 1 },
    ]);
  });

  for (let markdownCase of [
    {
      doc: "<div>\ncontent\n</div>\n\nnext",
      name: "html blocks",
      target: "content",
    },
    {
      doc: "    first\n    second\n\nnext",
      name: "indented code blocks",
      target: "second",
    },
    {
      doc: "[id]: https://example.com\n\nnext",
      name: "link reference definitions",
      target: "example",
    },
    {
      doc: "---\ntitle: One\n---\n\nnext",
      name: "YAML metadata blocks",
      target: "One",
    },
    {
      doc: '+++\ntitle = "One"\n+++\n\nnext',
      name: "TOML metadata blocks",
      target: "One",
    },
  ]) {
    it(`uses touched line scope for undecorated ${markdownCase.name}`, async () => {
      let state = await markdownState(markdownCase.doc);
      let dirtyFrom = markdownCase.doc.indexOf(markdownCase.target);
      let dirtyLine = state.doc.lineAt(dirtyFrom);

      expect(expand([{ from: dirtyFrom, reasons: ["text"], to: dirtyFrom + 1 }], state)).toEqual([
        { from: dirtyLine.from, reasons: ["text"], to: dirtyLine.to },
      ]);
    });
  }

  it("uses feature line scope for code fence content edits", async () => {
    let doc = "```ts\nlet a = 1;\n```\n\n```ts\nlet b = 2;\n```\n";
    let state = await markdownState(doc);
    let dirtyFrom = doc.indexOf("a = 1");
    let dirtyLine = state.doc.lineAt(dirtyFrom);

    expect(expand([{ from: dirtyFrom, reasons: ["text"], to: dirtyFrom + 1 }], state)).toEqual([
      { from: dirtyLine.from, reasons: ["text"], to: dirtyLine.to },
    ]);
  });

  it("uses feature node scope for code fence metadata edits", async () => {
    let doc = "```ts\nlet a = 1;\n```\n\n```ts\nlet b = 2;\n```\n";
    let state = await markdownState(doc);
    let dirtyFrom = doc.indexOf("ts");
    let firstFenceTo = doc.indexOf("\n\n") + 1;

    expect(expand([{ from: dirtyFrom, reasons: ["text"], to: dirtyFrom + 2 }], state)).toEqual([
      { from: 0, reasons: ["text"], to: firstFenceTo },
    ]);
  });

  it("does not shrink dirty ranges that already cover a feature node", async () => {
    let doc = "```ts\nlet a = 1;\n```\n\nplain";
    let state = await markdownState(doc);
    let firstFenceTo = doc.indexOf("\n\n") + 1;

    expect(expand([{ from: 0, reasons: ["codeFenceLanguages"], to: firstFenceTo }], state)).toEqual(
      [{ from: 0, reasons: ["codeFenceLanguages"], to: firstFenceTo }],
    );
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
