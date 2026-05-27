import { EditorState, type ChangeDesc } from "@codemirror/state";
import {
  syntaxTree,
  TreeSitterLanguage,
  TreeSitterParser,
  type DocRange,
} from "@codemirror-treesitter/language";
import { describe, expect, it } from "vite-plus/test";
import { __testCollectLiveMdDirtyRanges } from "../src/core/dirty-ranges.js";

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

  it("deduplicates text ranges covered by full code fence language invalidation", () => {
    let state = EditorState.create({ doc: "```ts\nlet a = 1;\n```\n" });
    let transaction = state.update({
      changes: { from: 10, to: 11, insert: "b" },
    });

    expect(
      __testCollectLiveMdDirtyRanges({
        changes: transaction.changes,
        codeFenceLanguagesChanged: true,
        startState: state,
        state: transaction.state,
        syntaxChangedRanges: [],
      }),
    ).toEqual([
      {
        from: 0,
        reasons: ["text", "codeFenceLanguages"],
        to: transaction.state.doc.length,
      },
    ]);
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
