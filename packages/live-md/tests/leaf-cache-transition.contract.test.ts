// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import {
  EditorState,
  EditorView,
  __testBuildCanonicalLiveMdAnalysis,
  __testBuildLiveMdAnalysis,
  __testFlushLiveMdAnalysis,
  __testLiveMdAnalysis,
  buildFreshLeafAnalysisCache,
  canonicalAnalysis,
  canonicalSemanticCache,
  codeFenceLanguagesField,
  createLeafAnalysisCache,
  decorationClasses,
  deleteLiveMdTree,
  dispatchScheduledLocalEdit,
  ensureSyntaxTree,
  expectRelativeLineClassRange,
  hashDocRange,
  installAnalysisTestEnvironment,
  leafAnalysisCacheNextId,
  leafAnalysisCacheRecordCount,
  legacyFeatureFullQueryCount,
  lineBySource,
  lineClasses,
  liveMdAnalysis,
  liveMdKitchenSinkDoc,
  liveMdMarkdownParserServiceFacet,
  loadMarkdownParserService,
  markdownAnalysisState,
  markdownAnalysisView,
  markerRecordBySource,
  materializeLeafAnalysisCacheRecords,
  randomEditSeedDoc,
  randomTextEdit,
  recordBySource,
  seededRandom,
  taskMarkerChecked,
  transitionLeafAnalysisCache,
  walkMarkdownBlocks,
} from "./helpers/analysis.js";
import type { ScheduledLocalOracleMode, TransactionSpec } from "./helpers/analysis.js";

installAnalysisTestEnvironment();

describe("LiveMD leaf cache transition contract", () => {
  it("keeps transitioned semantic cache equivalent to a fresh full rebuild", async () => {
    let view = await markdownAnalysisView(liveMdKitchenSinkDoc(), "After anchor");
    let editFrom = view.state.doc.toString().indexOf("alpha | 1");
    let transaction = view.state.update({
      changes: {
        from: editFrom,
        insert: "alpha | 9",
        to: editFrom + "alpha | 1".length,
      },
    });
    ensureSyntaxTree(transaction.state, transaction.state.doc.length, 5_000);

    view.dispatch(transaction);
    await __testFlushLiveMdAnalysis(view);

    let transitioned = __testLiveMdAnalysis(view);
    let fresh = __testBuildLiveMdAnalysis(view.state);
    expect(transitioned.semanticTrace?.recordsReused).toBeGreaterThan(0);
    expect(canonicalSemanticCache(view.state, transitioned)).toEqual(
      canonicalSemanticCache(view.state, fresh),
    );
    expect(canonicalAnalysis(view.state, transitioned)).toEqual(
      canonicalAnalysis(view.state, fresh),
    );
    view.destroy();
  });

  it("keeps full-document analysis equivalent after selection-only updates", async () => {
    let view = await markdownAnalysisView(liveMdKitchenSinkDoc(), "After anchor");

    for (let target of ["Heading One", "Alt image", "E = mc^2", "After anchor"]) {
      view.dispatch({
        selection: { anchor: view.state.doc.toString().indexOf(target) },
      });

      expect(canonicalAnalysis(view.state, __testLiveMdAnalysis(view)), target).toEqual(
        canonicalAnalysis(view.state, __testBuildCanonicalLiveMdAnalysis(view.state)),
      );
    }
    view.destroy();
  });

  it("reuses unchanged cache records after front inserts", async () => {
    let doc = "first *one*\n\nsecond **two**\n\nthird _three_";
    let view = await markdownAnalysisView(doc, "first");
    let before = __testLiveMdAnalysis(view);
    let beforeRecord = recordBySource(view.state, before, "second **two**");

    let transaction = view.state.update({ changes: { from: 0, insert: "intro\n\n" } });
    ensureSyntaxTree(transaction.state, transaction.state.doc.length, 5_000);
    view.dispatch(transaction);
    await __testFlushLiveMdAnalysis(view);

    let after = __testLiveMdAnalysis(view);
    if (!after.semantic) throw new Error("Expected semantic cache after front insert");
    let afterRecord = recordBySource(view.state, after, "second **two**");
    let recordCount = leafAnalysisCacheRecordCount(after.semantic.cache);

    expect(afterRecord.cacheId).toBe(beforeRecord.cacheId);
    expect(afterRecord.analysis).toBe(beforeRecord.analysis);
    expect(after.semanticTrace?.recordsReused).toBeGreaterThan(0);
    expect(after.semanticTrace?.recordsVisited).toBeGreaterThan(0);
    expect(after.semanticTrace?.recordsVisited).toBeLessThan(recordCount!);
    expect(after.semanticTrace?.exactSourceComparisons).toBeGreaterThan(0);
    expect(after.semanticTrace?.exactSourceComparedChars).toBeGreaterThan(0);
    expect(after.semanticTrace?.inlineParserSessions).toBeLessThanOrEqual(1);
    expect(after.semanticTrace?.projectionRecords).toBe(0);
    expect(legacyFeatureFullQueryCount(after)).toBe(0);
    view.destroy();
  });

  it("keeps scheduled semantic transition local for ordinary paragraph edits", async () => {
    let doc = Array.from({ length: 1_000 }, (_value, index) => `paragraph ${index}`).join("\n\n");
    let target = doc.indexOf("paragraph 500") + "paragraph 500".length;
    let view = await markdownAnalysisView(doc, "paragraph 0");

    let { after } = await dispatchScheduledLocalEdit(
      view,
      { changes: { from: target, insert: "!" } },
      "ordinary paragraph edit",
    );

    expect(after.semanticTrace?.recordsAnalyzed).toBe(1);
    expect(after.semanticTrace?.fallbackCount).toBe(0);
    expect(after.semanticTrace?.recordsVisited).toBeLessThan(5);
    expect(after.semanticTrace?.recordsCollected).toBeLessThan(10);
    expect(after.semanticTrace?.recordsMappedIndividually).toBeLessThan(10);
    expect(after.semanticTrace?.cacheFullMaterializations).toBe(0);
    expect(after.semanticTrace?.blockNodesVisited).toBeLessThan(160);
    expect(after.semanticTrace?.checkedRanges.length).toBeGreaterThan(0);
    view.destroy();
  });

  it("keeps local, full-walk, and fresh semantic transitions equivalent across block boundaries", async () => {
    let cases: Array<{
      changes: (doc: string) => TransactionSpec["changes"];
      doc: string;
      name: string;
      oracle?: ScheduledLocalOracleMode;
      selection?: string;
    }> = [
      {
        name: "paragraph split",
        doc: "alpha beta\n\ngamma",
        selection: "gamma",
        changes: (doc) => ({ from: doc.indexOf(" beta"), insert: "\n\n" }),
      },
      {
        name: "paragraph merge",
        doc: "alpha\n\nbeta\n\ngamma",
        selection: "gamma",
        changes: (doc) => ({
          from: doc.indexOf("\n\nbeta"),
          insert: "\n",
          to: doc.indexOf("\n\nbeta") + 2,
        }),
      },
      {
        name: "table create",
        doc: "before\n\nName | Value\n--- | ---\nalpha | 1\n\nafter",
        selection: "after",
        changes: (doc) => [
          { from: doc.indexOf("Name"), insert: "| " },
          { from: doc.indexOf("Value") + "Value".length, insert: " |" },
          { from: doc.indexOf("--- | ---"), insert: "| " },
          { from: doc.indexOf("---\nalpha") + "---".length, insert: " |" },
          { from: doc.indexOf("alpha"), insert: "| " },
          { from: doc.indexOf("1\n\nafter") + "1".length, insert: " |" },
        ],
      },
      {
        name: "table destroy",
        doc: "before\n\n| Name | Value |\n| --- | --- |\n| alpha | 1 |\n\nafter",
        selection: "after",
        changes: (doc) => ({
          from: doc.indexOf("| --- | --- |"),
          insert: "not a table separator",
          to: doc.indexOf("| --- | --- |") + "| --- | --- |".length,
        }),
      },
      {
        name: "fence open",
        doc: "before\n\nlet answer = 1;\n\nafter",
        selection: "after",
        changes: (doc) => [
          { from: doc.indexOf("let answer"), insert: "```ts\n" },
          {
            from: doc.indexOf("\n\nafter"),
            insert: "\n```",
          },
        ],
      },
      {
        name: "fence close",
        doc: "before\n\n```ts\nlet answer = 1;\n\nafter",
        selection: "after",
        changes: (doc) => ({ from: doc.indexOf("\n\nafter"), insert: "\n```" }),
      },
      {
        name: "list context indent",
        doc: "before\n\n- parent\n- child\n\nafter",
        oracle: "semantic",
        selection: "after",
        changes: (doc) => ({ from: doc.indexOf("- child"), insert: "  " }),
      },
      {
        name: "list context dedent",
        doc: "before\n\n- parent\n  - child\n\nafter",
        oracle: "semantic",
        selection: "after",
        changes: (doc) => ({
          from: doc.indexOf("  - child"),
          to: doc.indexOf("  - child") + 2,
        }),
      },
      {
        name: "quote context enter",
        doc: "before\n\nplain **bold**\n\nafter",
        oracle: "semantic",
        selection: "after",
        changes: (doc) => ({ from: doc.indexOf("plain"), insert: "> " }),
      },
      {
        name: "quote context exit",
        doc: "before\n\n> quoted **bold**\n\nafter",
        oracle: "semantic",
        selection: "after",
        changes: (doc) => ({
          from: doc.indexOf("> quoted"),
          to: doc.indexOf("> quoted") + 2,
        }),
      },
    ];

    for (let testCase of cases) {
      let view = await markdownAnalysisView(testCase.doc, testCase.selection ?? "");
      try {
        let { after } = await dispatchScheduledLocalEdit(
          view,
          { changes: testCase.changes(testCase.doc) },
          testCase.name,
          { oracle: testCase.oracle },
        );
        expect(after.semanticTrace?.fallbackCount, testCase.name).toBe(0);
        expect(after.semanticTrace?.cacheFullMaterializations, testCase.name).toBe(0);
        expect(after.semanticTrace?.recordsCollected, testCase.name).toBeLessThan(40);
        expect(after.semanticTrace?.recordsMappedIndividually, testCase.name).toBeLessThan(40);
        expect(after.semanticTrace?.cacheIndexCallbacks, testCase.name).toBeLessThan(40);
        expect(after.semanticTrace?.cacheIndexQueries, testCase.name).toBeLessThan(20);
      } finally {
        view.destroy();
      }
    }
  }, 60_000);

  it("keeps a deterministic random edit sequence equivalent to full-walk and fresh rebuilds", async () => {
    let view = await markdownAnalysisView(randomEditSeedDoc(), "tail");
    let random = seededRandom(0x75f);

    try {
      for (let index = 0; index < 24; index++) {
        let doc = view.state.doc.toString();
        await dispatchScheduledLocalEdit(
          view,
          { changes: randomTextEdit(doc, random) },
          `random edit ${index}`,
        );
      }
    } finally {
      view.destroy();
    }
  }, 60_000);

  it("keeps task list marker cache ids stable when editing only the task body", async () => {
    let doc = "before\n\n- [ ] todo\n\nafter";
    let view = await markdownAnalysisView(doc, "before");
    let before = __testLiveMdAnalysis(view);
    let beforeList = markerRecordBySource(view.state, before, "- [ ] todo", "listMarker");
    let beforeTask = markerRecordBySource(view.state, before, "- [ ] todo", "taskMarker");
    let editFrom = doc.indexOf("todo") + "todo".length;
    let transaction = view.state.update({
      changes: { from: editFrom, insert: " with more detail" },
    });
    ensureSyntaxTree(transaction.state, transaction.state.doc.length, 5_000);

    view.dispatch(transaction);
    await __testFlushLiveMdAnalysis(view);

    let afterLineText = "- [ ] todo with more detail";
    let after = __testLiveMdAnalysis(view);
    let fresh = __testBuildLiveMdAnalysis(view.state);
    let afterList = markerRecordBySource(view.state, after, afterLineText, "listMarker");
    let afterTask = markerRecordBySource(view.state, after, afterLineText, "taskMarker");
    let afterLine = lineBySource(view.state, afterLineText);

    expect(afterList.cacheId).toBe(beforeList.cacheId);
    expect(afterTask.cacheId).toBe(beforeTask.cacheId);
    expect(afterList.analysis).toBe(beforeList.analysis);
    expect(afterTask.analysis).toBe(beforeTask.analysis);
    expect(afterList.sourceRange).toEqual({ from: afterLine.from, to: afterLine.to });
    expect(afterTask.sourceRange).toEqual({ from: afterLine.from, to: afterLine.to });
    expectRelativeLineClassRange(afterList, "cm-md-list-line", { from: 0, to: 2 });
    expectRelativeLineClassRange(afterTask, "cm-md-list-line", { from: 2, to: 5 });
    expectRelativeLineClassRange(afterTask, "cm-md-task-line", { from: 2, to: 5 });
    expect(lineClasses(view.state, after).get(afterLine.from)?.has("cm-md-list-line")).toBe(true);
    expect(lineClasses(view.state, after).get(afterLine.from)?.has("cm-md-task-line")).toBe(true);
    expect(canonicalSemanticCache(view.state, after)).toEqual(
      canonicalSemanticCache(view.state, fresh),
    );
    expect(canonicalAnalysis(view.state, after)).toEqual(canonicalAnalysis(view.state, fresh));
    view.destroy();
  });

  it("does not reuse unchecked task marker analysis when the check state changes", async () => {
    let doc = "before\n\n- [ ] todo\n\nafter";
    let view = await markdownAnalysisView(doc, "before");
    let before = __testLiveMdAnalysis(view);
    let beforeTask = markerRecordBySource(view.state, before, "- [ ] todo", "taskMarker");
    let editFrom = doc.indexOf("[ ]") + 1;
    let transaction = view.state.update({
      changes: { from: editFrom, insert: "x", to: editFrom + 1 },
    });
    ensureSyntaxTree(transaction.state, transaction.state.doc.length, 5_000);

    view.dispatch(transaction);
    await __testFlushLiveMdAnalysis(view);

    let after = __testLiveMdAnalysis(view);
    let fresh = __testBuildLiveMdAnalysis(view.state);
    let afterTask = markerRecordBySource(view.state, after, "- [x] todo", "taskMarker");

    expect(taskMarkerChecked(beforeTask)).toBe(false);
    expect(taskMarkerChecked(afterTask)).toBe(true);
    expect(afterTask.analysis.analysisKey).not.toBe(beforeTask.analysis.analysisKey);
    expect(canonicalSemanticCache(view.state, after)).toEqual(
      canonicalSemanticCache(view.state, fresh),
    );
    expect(canonicalAnalysis(view.state, after)).toEqual(canonicalAnalysis(view.state, fresh));
    view.destroy();
  });

  it("assigns new cache ids when leaves merge", async () => {
    let doc = "alpha\n\nbeta";
    let view = await markdownAnalysisView(doc, "alpha");
    let before = __testLiveMdAnalysis(view);
    let alpha = recordBySource(view.state, before, "alpha");
    let beta = recordBySource(view.state, before, "beta");
    let blank = doc.indexOf("\n\n");

    let transaction = view.state.update({
      changes: { from: blank, insert: "\n", to: blank + 2 },
    });
    ensureSyntaxTree(transaction.state, transaction.state.doc.length, 5_000);
    view.dispatch(transaction);
    await __testFlushLiveMdAnalysis(view);

    let after = __testLiveMdAnalysis(view);
    let merged = recordBySource(view.state, after, "alpha\nbeta");

    expect([alpha.cacheId, beta.cacheId]).not.toContain(merged.cacheId);
    expect(after.semanticTrace?.recordsAnalyzed).toBeGreaterThan(0);
    view.destroy();
  });

  it("assigns new cache ids when leaves split", async () => {
    let doc = "alpha\nbeta";
    let view = await markdownAnalysisView(doc, "alpha");
    let before = __testLiveMdAnalysis(view);
    let original = recordBySource(view.state, before, "alpha\nbeta");
    let lineBreak = doc.indexOf("\n");

    let transaction = view.state.update({
      changes: { from: lineBreak + 1, insert: "\n" },
    });
    ensureSyntaxTree(transaction.state, transaction.state.doc.length, 5_000);
    view.dispatch(transaction);
    await __testFlushLiveMdAnalysis(view);

    let after = __testLiveMdAnalysis(view);
    let alpha = recordBySource(view.state, after, "alpha");
    let beta = recordBySource(view.state, after, "beta");

    expect(alpha.cacheId).not.toBe(original.cacheId);
    expect(beta.cacheId).not.toBe(original.cacheId);
    expect(after.semanticTrace?.recordsAnalyzed).toBeGreaterThanOrEqual(2);
    view.destroy();
  });

  it("skips block walking and inline parsing for selection-only cache reuse", async () => {
    let service = await loadMarkdownParserService();
    let parseCalls = 0;
    let inlineParser = Object.create(service.inlineParser) as typeof service.inlineParser;
    inlineParser.parseWith = (...args: Parameters<typeof service.inlineParser.parseWith>) => {
      parseCalls++;
      return service.inlineParser.parseWith(...args);
    };
    let trackedService = { ...service, inlineParser };
    let doc = "first *one*\n\nsecond **two**\n\nthird _three_";
    let view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({
        doc,
        extensions: [
          service.blockLanguage.extension,
          liveMdMarkdownParserServiceFacet.of(trackedService),
          codeFenceLanguagesField,
          liveMdAnalysis,
        ],
      }),
    });
    ensureSyntaxTree(view.state, doc.length, 5_000);
    view.dispatch({});
    let before = __testLiveMdAnalysis(view);

    parseCalls = 0;
    view.dispatch({ selection: { anchor: doc.indexOf("second") } });
    let after = __testLiveMdAnalysis(view);

    expect(parseCalls).toBe(0);
    expect(after.semantic?.cache).toBe(before.semantic?.cache);
    expect(after.semantic?.revision).toBe(before.semantic?.revision);
    expect(after.semanticTrace?.blockNodesVisited).toBe(0);
    expect(after.semanticTrace?.recordsVisited).toBe(0);
    expect(after.semanticTrace?.inlineParseCalls).toBe(0);
    expect(after.semanticTrace?.projectionRecords).toBe(0);
    view.destroy();
  });

  it("uses exact source comparison after source hash candidate matches", async () => {
    let service = await loadMarkdownParserService();
    let oldState = EditorState.create({ doc: "alpha" });
    let newState = EditorState.create({ doc: "bravo" });
    let oldTree = service.blockParser.parse(oldState.doc);
    let newTree = service.blockParser.parse(newState.doc);

    try {
      let oldSnapshot = walkMarkdownBlocks(oldTree, oldState.doc).snapshot;
      let oldTransition = buildFreshLeafAnalysisCache({
        analysisInput: { service, state: oldState, tree: oldTree },
        snapshot: oldSnapshot,
      });
      let newSnapshot = walkMarkdownBlocks(newTree, newState.doc).snapshot;
      let newHash = hashDocRange(newState.doc, { from: 0, to: newState.doc.length });
      expect(typeof newHash).toBe("number");
      let tamperedRecords = materializeLeafAnalysisCacheRecords(oldTransition.cache).map(
        (record) => ({
          ...record,
          sourceHash: newHash,
        }),
      );
      let tamperedCache = createLeafAnalysisCache(
        tamperedRecords,
        leafAnalysisCacheNextId(oldTransition.cache),
      );
      let changes = oldState.update({
        changes: { from: 0, insert: "bravo", to: oldState.doc.length },
      }).changes;
      let transitioned = transitionLeafAnalysisCache({
        analysisInput: { service, state: newState, tree: newTree },
        changes,
        oldCache: tamperedCache,
        oldDoc: oldState.doc,
        snapshot: newSnapshot,
      });

      let transitionedRecords = materializeLeafAnalysisCacheRecords(transitioned.cache);
      expect(transitionedRecords[0]?.cacheId).not.toBe(tamperedRecords[0]?.cacheId);
      expect(transitioned.trace.sourceHashCollisions).toBe(1);
      expect(transitioned.trace.exactSourceComparisons).toBe(1);
      expect(transitioned.trace.exactSourceComparedChars).toBe(5);
    } finally {
      deleteLiveMdTree(oldTree);
      deleteLiveMdTree(newTree);
    }
  });

  it("keeps leaf-local projection equivalent to the canonical full-query projection", async () => {
    let docs = [
      liveMdKitchenSinkDoc(),
      "![Alt](image.png)\n\n| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n\n```mermaid\ngraph TD\nA-->B\n```\n",
      "> - [ ] quoted task\n>\n> paragraph with **bold**\n\n---\n",
    ];

    for (let doc of docs) {
      let state = await markdownAnalysisState(doc);

      expect(canonicalAnalysis(state, __testBuildLiveMdAnalysis(state))).toEqual(
        canonicalAnalysis(state, __testBuildCanonicalLiveMdAnalysis(state)),
      );
    }
  });

  it("keeps active table inline projection equivalent to the canonical full-query projection", async () => {
    let doc =
      "before\n\n" +
      "| Name | Value |\n" +
      "| --- | ---: |\n" +
      "| _alpha_ | **1** |\n" +
      "| [beta](https://example.com) | `2` |\n\n" +
      "after\n";
    let state = await markdownAnalysisState(doc, "_alpha_");
    let leafLocal = __testBuildLiveMdAnalysis(state);

    expect(canonicalAnalysis(state, leafLocal)).toEqual(
      canonicalAnalysis(state, __testBuildCanonicalLiveMdAnalysis(state)),
    );
    expect(decorationClasses(state, leafLocal).has("cm-md-emphasis")).toBe(true);
    expect(decorationClasses(state, leafLocal).has("cm-md-strong")).toBe(true);
    expect(decorationClasses(state, leafLocal).has("cm-md-inline-code")).toBe(true);
  });
});
