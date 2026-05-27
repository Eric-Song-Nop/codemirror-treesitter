import { EditorState } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { describe, expect, it } from "vite-plus/test";
import { liveMdAnalysis } from "../src/core/decorations.js";
import {
  codeFenceLanguagesField,
  loadMarkdownExtension,
  setCodeFenceLanguages,
} from "../src/core/languages.js";

describe("LiveMD analysis snapshot", () => {
  it("records text dirty ranges while continuing to rebuild the full analysis", () => {
    let state = analysisState("first\nsecond");
    let transaction = state.update({
      changes: { from: 0, to: 5, insert: "changed" },
    });
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.dirtyRanges).toEqual([{ from: 0, reasons: ["text"], to: 7 }]);
    expect(Array.from(analysis.activeLines)).toEqual([1]);
  });

  it("records selection dirty ranges from previous and current active lines", () => {
    let state = analysisState("first\nsecond\nthird", 1);
    let transaction = state.update({
      selection: { anchor: "first\nsecond\n".length },
    });
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.dirtyRanges).toEqual([
      { from: 0, reasons: ["selection"], to: 5 },
      { from: 13, reasons: ["selection"], to: 18 },
    ]);
    expect(Array.from(analysis.activeLines)).toEqual([3]);
  });

  it("records code fence language invalidation as one full-document dirty range", () => {
    let state = analysisState("```ts\nlet a = 1;\n```\n");
    let transaction = state.update({
      effects: setCodeFenceLanguages.of(new Map()),
    });
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.dirtyRanges).toEqual([
      { from: 0, reasons: ["codeFenceLanguages"], to: transaction.state.doc.length },
    ]);
  });

  it("records expanded dirty ranges using Markdown feature scopes", async () => {
    let doc = "![alt](one.png)\nnext";
    let state = await markdownAnalysisState(doc);
    let dirtyFrom = doc.indexOf("one");
    let transaction = state.update({
      changes: { from: dirtyFrom, to: dirtyFrom + 3, insert: "two" },
    });
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.dirtyRanges).toEqual([
      { from: dirtyFrom, reasons: ["text"], to: dirtyFrom + 3 },
    ]);
    expect(analysis.expandedDirtyRanges).toEqual([
      { from: 0, reasons: ["text"], to: "![alt](two.png)".length },
    ]);
  });

  it("records syntax dirty ranges for Markdown structure changes", async () => {
    let state = await markdownAnalysisState("plain\nnext");
    let transaction = state.update({
      changes: { from: 0, insert: "# " },
    });
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.dirtyRanges.some((range) => range.reasons.includes("syntax"))).toBe(true);
  });

  it("patches selection-only updates without rebuilding untouched line decorations", async () => {
    let doc = "- first\n- second\n- third";
    let state = await markdownAnalysisState(doc, 2);
    let untouchedLine = state.doc.line(2);
    let before = lineDecorations(state, untouchedLine.from);

    expect(before.length).toBeGreaterThan(0);

    let transaction = state.update({
      selection: { anchor: doc.indexOf("third") },
    });
    let after = lineDecorations(transaction.state, transaction.state.doc.line(2).from);
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.expandedDirtyRanges).toEqual([
      { from: 0, reasons: ["selection"], to: 7 },
      { from: 17, reasons: ["selection"], to: 24 },
    ]);
    expect(after).toHaveLength(before.length);
    expect(after[0]).toBe(before[0]);
  });
});

function analysisState(doc: string, selection = 0) {
  return EditorState.create({
    doc,
    selection: { anchor: selection },
    extensions: [codeFenceLanguagesField, liveMdAnalysis],
  });
}

async function markdownAnalysisState(doc: string, selection = 0) {
  return EditorState.create({
    doc,
    selection: { anchor: selection },
    extensions: [codeFenceLanguagesField, liveMdAnalysis, await loadMarkdownExtension()],
  });
}

function lineDecorations(state: EditorState, pos: number) {
  let values: Decoration[] = [];
  state.field(liveMdAnalysis).decorations.between(pos, pos, (from, to, value) => {
    if (from == pos && to == pos) values.push(value);
  });
  return values;
}
