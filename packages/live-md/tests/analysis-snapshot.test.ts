import { Compartment, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror-treesitter/language";
import { describe, expect, it } from "vite-plus/test";
import {
  __testBuildLiveMdAnalysis,
  __testLiveMdOwnerSnapshots,
  liveMdAnalysis,
} from "../src/core/decorations.js";
import {
  codeFenceLanguagesField,
  loadMarkdownExtension,
  setCodeFenceLanguages,
} from "../src/core/languages.js";

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

  it("uses old-tree owner hits when the new tree no longer contains that owner", async () => {
    let rows = numberedTableRows(30);
    let doc = ["| Name | Value |", "| --- | ---: |", ...rows, "", "after"].join("\n");
    let state = await markdownAnalysisState(doc, doc.indexOf("after"));
    let delimiterFrom = doc.indexOf("| --- | ---: |");
    let transaction = state.update({
      changes: {
        from: delimiterFrom,
        to: delimiterFrom + "| --- | ---: |".length,
        insert: "not a delimiter",
      },
    });
    let snapshots = __testLiveMdOwnerSnapshots(transaction.state.field(liveMdAnalysis));
    let finalDoc = transaction.state.doc.toString();
    let oldTableMappedTo = finalDoc.indexOf("\n\nafter") + 1;

    expect(snapshots.owners.some((owner) => owner.kind == "table")).toBe(false);
    expect(snapshots.affectedRanges).toContainEqual({
      from: 0,
      reasons: ["text", "syntax"],
      to: oldTableMappedTo,
    });
  });

  it("keeps incremental owners consistent with a fresh final analysis", async () => {
    await expectIncrementalOwnersToMatchFresh({
      startDoc: ["| Name | Value |", "| --- | ---: |", ...numberedTableRows(40), "", "after"].join(
        "\n",
      ),
      replace: "row 30",
      insert: "row thirty",
      selectionText: "after",
    });

    await expectIncrementalOwnersToMatchFresh({
      startDoc: "[docs](https://one.example)\n\nnext",
      replace: "one.example",
      insert: "two.example",
      selectionText: "next",
    });

    await expectIncrementalOwnersToMatchFresh({
      startDoc: "first\nsecond",
      replace: "\n",
      insert: "\n\n",
      selectionText: "second",
    });

    await expectIncrementalOwnersToMatchFresh({
      startDoc: [...numberedQuoteRows(30), "", "after"].join("\n"),
      replace: "> quote 20",
      insert: "quote 20",
      selectionText: "after",
    });
  });

  it("does not duplicate owners when code fence languages update without text changes", async () => {
    let markdown = new Compartment();
    let doc = "# Title\n\n```ts\ncode\n```\n\n[docs](https://example.test)";
    let state = EditorState.create({
      doc,
      extensions: [codeFenceLanguagesField, liveMdAnalysis, markdown.of([])],
    });
    state = state.update({ effects: markdown.reconfigure(await loadMarkdownExtension()) }).state;
    let before = normalizedOwners(state.field(liveMdAnalysis));

    state = state.update({ effects: setCodeFenceLanguages.of(new Map()) }).state;
    let after = normalizedOwners(state.field(liveMdAnalysis));

    expect(after).toEqual(before);
    expect(new Set(after.map(ownerKey)).size).toBe(after.length);
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

async function expectIncrementalOwnersToMatchFresh(spec: {
  insert: string;
  replace: string;
  selectionText: string;
  startDoc: string;
}) {
  let editFrom = spec.startDoc.indexOf(spec.replace);
  expect(editFrom).toBeGreaterThanOrEqual(0);
  let finalDoc =
    spec.startDoc.slice(0, editFrom) +
    spec.insert +
    spec.startDoc.slice(editFrom + spec.replace.length);
  let startState = await markdownAnalysisState(
    spec.startDoc,
    spec.startDoc.indexOf(spec.selectionText),
  );
  let transaction = startState.update({
    changes: { from: editFrom, to: editFrom + spec.replace.length, insert: spec.insert },
  });
  let freshState = await markdownAnalysisState(finalDoc, finalDoc.indexOf(spec.selectionText));
  ensureSyntaxTree(freshState, freshState.doc.length, 5_000);

  expect(normalizedOwners(transaction.state.field(liveMdAnalysis))).toEqual(
    normalizedOwners(__testBuildLiveMdAnalysis(freshState)),
  );
}

function normalizedOwners(analysis: Parameters<typeof __testLiveMdOwnerSnapshots>[0]) {
  return __testLiveMdOwnerSnapshots(analysis)
    .owners.map(({ from, kind, to }) => ({ from, kind, to }))
    .sort(
      (left, right) =>
        left.from - right.from || left.to - right.to || left.kind.localeCompare(right.kind),
    );
}

function ownerKey(owner: { from: number; kind: string; to: number }) {
  return `${owner.kind}:${owner.from}:${owner.to}`;
}

function numberedTableRows(count: number) {
  return Array.from({ length: count }, (_, index) => `| row ${index} | ${index} |`);
}

function numberedQuoteRows(count: number) {
  return Array.from({ length: count }, (_, index) => `> quote ${index}`);
}
