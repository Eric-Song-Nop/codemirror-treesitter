import { EditorState, type ChangeDesc } from "@codemirror/state";
import {
  ensureSyntaxTree,
  syntaxTree,
  TreeSitterLanguage,
  TreeSitterParser,
  type DocRange,
} from "@codemirror-treesitter/language";
import { describe, expect, it } from "vite-plus/test";
import {
  __testCollectLiveMdDirtyRanges,
  analyzeLiveMdDirtyRanges,
  collectSyntaxNodeDirtyRanges,
} from "../src/core/dirty-ranges.js";
import { __testLiveMdFeatureRegistry } from "../src/core/decorations.js";
import { loadMarkdownExtension } from "../src/core/languages.js";

const javascriptWasm = new URL(
  "../../../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
  import.meta.url,
).pathname;

let javascriptParser: Promise<TreeSitterParser> | null = null;

describe("LiveMD dirty range collection", () => {
  it("keeps text edits dirty when tree-sitter reports no structural changes", async () => {
    let { parser, state } = await javascriptState("let foo = 1;\n");
    let transaction = state.update({
      changes: { from: 4, to: 7, insert: "bar" },
    });
    let syntaxChangedRanges = changedSyntaxRanges(
      parser,
      state,
      transaction.state,
      transaction.changes,
    );

    expect(syntaxChangedRanges).toEqual([]);
    expect(
      __testCollectLiveMdDirtyRanges({
        changes: transaction.changes,
        startState: state,
        state: transaction.state,
        syntaxChangedRanges,
      }),
    ).toEqual([{ from: 4, reasons: ["text"], to: 7 }]);
  });

  it("merges overlapping text and syntax changes into one recompute range", async () => {
    let { parser, state } = await javascriptState("let foo = 1;\n");
    let transaction = state.update({
      changes: { from: 4, to: 7, insert: "function f() {}" },
    });
    let syntaxChangedRanges = changedSyntaxRanges(
      parser,
      state,
      transaction.state,
      transaction.changes,
    );

    let syntaxTo = transaction.state.doc.length - 1;
    expect(syntaxChangedRanges).toEqual([{ from: 0, to: syntaxTo }]);
    expect(
      __testCollectLiveMdDirtyRanges({
        changes: transaction.changes,
        startState: state,
        state: transaction.state,
        syntaxChangedRanges,
      }),
    ).toEqual([{ from: 0, reasons: ["text", "syntax"], to: syntaxTo }]);
  });

  it("keeps zero-width text dirty points for pure deletions", () => {
    let state = EditorState.create({ doc: "let foo = 1;\n" });
    let transaction = state.update({
      changes: { from: 4, to: 7 },
    });

    expect(
      __testCollectLiveMdDirtyRanges({
        changes: transaction.changes,
        startState: state,
        state: transaction.state,
        syntaxChangedRanges: [],
      }),
    ).toEqual([{ from: 4, reasons: ["text"], to: 4 }]);
  });

  it("merges text ranges covered by code fence language invalidation ranges", () => {
    let state = EditorState.create({ doc: "```ts\nlet a = 1;\n```\n" });
    let transaction = state.update({
      changes: { from: 10, to: 11, insert: "b" },
    });
    let contentLine = transaction.state.doc.lineAt(transaction.state.doc.toString().indexOf("let"));

    expect(
      __testCollectLiveMdDirtyRanges({
        changes: transaction.changes,
        sourceRanges: [
          { from: contentLine.from, reason: "codeFenceLanguages", to: contentLine.to + 1 },
        ],
        startState: state,
        state: transaction.state,
        syntaxChangedRanges: [],
      }),
    ).toEqual([
      {
        from: contentLine.from,
        reasons: ["text", "codeFenceLanguages"],
        to: contentLine.to + 1,
      },
    ]);
  });

  it("collects syntax node dirty ranges for code fence language invalidation", async () => {
    let doc = "```ts\nlet a = 1;\n```\n\nplain\n\n```ts\nlet b = 2;\n```\n";
    let state = await markdownState(doc);
    let firstContentLine = state.doc.lineAt(doc.indexOf("let a"));
    let secondContentLine = state.doc.lineAt(doc.indexOf("let b"));

    expect(
      collectSyntaxNodeDirtyRanges({
        nodes: ["code_fence_content"],
        reason: "codeFenceLanguages",
        state,
      }),
    ).toEqual([
      { from: firstContentLine.from, reason: "codeFenceLanguages", to: firstContentLine.to + 1 },
      { from: secondContentLine.from, reason: "codeFenceLanguages", to: secondContentLine.to + 1 },
    ]);
  });

  it("analyzes dirty ranges, feature invalidations, and expanded ranges through one API", async () => {
    let doc = "![alt](one.png)\n\n```ts\nlet a = 1;\n```\n\nplain";
    let state = await markdownState(doc);
    let dirtyFrom = doc.indexOf("one");
    let transaction = state.update({
      changes: { from: dirtyFrom, to: dirtyFrom + 3, insert: "two" },
    });
    let nextDoc = transaction.state.doc.toString();
    let contentLine = transaction.state.doc.lineAt(nextDoc.indexOf("let a"));

    expect(
      analyzeLiveMdDirtyRanges({
        changes: transaction.changes,
        invalidations: [{ nodes: ["code_fence_content"], reason: "codeFenceLanguages" }],
        registry: __testLiveMdFeatureRegistry,
        startState: state,
        state: transaction.state,
        syntaxChangedRanges: [],
      }),
    ).toEqual({
      dirtyRanges: [
        { from: dirtyFrom, reasons: ["text"], to: dirtyFrom + 3 },
        { from: contentLine.from, reasons: ["codeFenceLanguages"], to: contentLine.to + 1 },
      ],
      expandedDirtyRanges: [
        { from: 0, reasons: ["text"], to: "![alt](two.png)".length },
        { from: contentLine.from, reasons: ["codeFenceLanguages"], to: contentLine.to + 1 },
      ],
    });
  });

  it("adds old and new active lines for selection-only updates", () => {
    let doc = "first\nsecond\nthird";
    let state = EditorState.create({
      doc,
      selection: { anchor: 1 },
    });
    let transaction = state.update({
      selection: { anchor: doc.indexOf("third") },
    });

    expect(
      __testCollectLiveMdDirtyRanges({
        activeLines: [3],
        changes: transaction.changes,
        previousActiveLines: [1],
        startState: state,
        state: transaction.state,
        syntaxChangedRanges: [],
      }),
    ).toEqual([
      { from: 0, reasons: ["selection"], to: 5 },
      { from: 13, reasons: ["selection"], to: 18 },
    ]);
  });
});

async function javascriptState(doc: string) {
  javascriptParser ??= TreeSitterParser.load(javascriptWasm);
  let parser = await javascriptParser;
  let language = TreeSitterLanguage.define({ name: "javascript", parser });
  return {
    parser,
    state: EditorState.create({ doc, extensions: [language.extension] }),
  };
}

async function markdownState(doc: string) {
  let state = EditorState.create({
    doc,
    extensions: [await loadMarkdownExtension()],
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state;
}

function changedSyntaxRanges(
  parser: TreeSitterParser,
  startState: EditorState,
  state: EditorState,
  changes: ChangeDesc,
): DocRange[] {
  let oldTree = syntaxTree(startState).tree!;
  let editedOldTree = parser.editTree(oldTree, changes, startState.doc, state.doc);
  let newTree = syntaxTree(state).tree!;
  return editedOldTree.getChangedRanges(newTree).map((range) => ({
    from: range.startIndex,
    to: range.endIndex,
  }));
}
