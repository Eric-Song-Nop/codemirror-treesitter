import { Compartment, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { __testLiveMdOwnerSnapshots, liveMdAnalysis } from "../src/core/decorations.js";
import { codeFenceLanguagesField, loadMarkdownExtension } from "../src/core/languages.js";

describe("LiveMD query owner analysis", () => {
  it("records text dirty ranges", () => {
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

  it("records syntax dirty ranges when Markdown parsing becomes available", async () => {
    let markdown = new Compartment();
    let doc = "- first\n\n- second";
    let state = EditorState.create({
      doc,
      extensions: [codeFenceLanguagesField, liveMdAnalysis, markdown.of([])],
    });
    let transaction = state.update({
      effects: markdown.reconfigure(await loadMarkdownExtension()),
    });
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.dirtyRanges).toEqual([{ from: 0, reasons: ["syntax"], to: doc.length }]);
  });

  it("tracks query owners and lets affected owners escape the query window", async () => {
    let rows = Array.from({ length: 40 }, (_, index) => `| row ${index} | ${index} |`);
    let doc = ["| Name | Value |", "| --- | ---: |", ...rows, "", "after"].join("\n");
    let state = await markdownAnalysisState(doc, doc.indexOf("after"));
    let editFrom = doc.indexOf("row 30");
    let transaction = state.update({
      changes: { from: editFrom, to: editFrom + "row 30".length, insert: "row thirty" },
    });
    let analysis = transaction.state.field(liveMdAnalysis);
    let tableTo = transaction.state.doc.toString().indexOf("\n\nafter") + 1;
    let snapshots = __testLiveMdOwnerSnapshots(analysis);

    expect(snapshots.owners).toContainEqual({
      from: 0,
      id: expect.any(Number),
      kind: "table",
      to: tableTo,
    });
    expect(snapshots.queryRanges[0]!.from).toBeGreaterThan(0);
    expect(snapshots.affectedRanges).toEqual([{ from: 0, reasons: ["text"], to: tableTo }]);
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
