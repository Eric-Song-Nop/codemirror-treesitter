// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import {
  EditorState,
  Tree,
  __testLiveMdAnalysis,
  buildFreshLeafAnalysisCache,
  canonicalSemanticRecordsFromCache,
  canonicalSemanticTransitionCache,
  commandTransaction,
  createLocalCacheHarness,
  deleteLiveMdTree,
  dispatchScheduledLocalEdit,
  expectPr75LocalTrace,
  firstCanonicalMismatch,
  history,
  installAnalysisTestEnvironment,
  leafAnalysisCacheRecordCount,
  loadMarkdownParserService,
  mapRangeForTest,
  markdownAnalysisView,
  materializeLeafAnalysisCacheRecords,
  numberedListDoc,
  numberedParagraphDoc,
  numberedPlainParagraphDoc,
  numberedQuoteParagraphDoc,
  onlyRecordTouching,
  redo,
  sourceIslandLeavesFromLeafAnalysisRecords,
  transitionLeafAnalysisCache,
  transitionLeafAnalysisCacheLocal,
  transitionSourceIslandLeavesFromLeafAnalysisRecords,
  undo,
  walkMarkdownBlocks,
} from "./helpers/analysis.js";
import type { LiveMdSourceIslandLeaf } from "./helpers/analysis.js";

installAnalysisTestEnvironment();

describe("LiveMD leaf cache transition performance", () => {
  it("keeps a 10,000 paragraph middle edit range-local on the scheduled path", async () => {
    let doc = numberedParagraphDoc(10_000);
    let target = doc.indexOf("paragraph 5000") + "paragraph 5000".length;
    let view = await markdownAnalysisView(doc, "paragraph 0");

    let { after, pending } = await dispatchScheduledLocalEdit(
      view,
      { changes: { from: target, insert: "!" } },
      "10k paragraph middle edit",
      { oracle: "semantic" },
    );

    expect(pending.pending).toBeTruthy();
    expect(pending.trace.blockNodesVisited).toBe(0);
    expect(pending.trace.recordsVisited).toBe(0);
    expect(pending.trace.inlineParseCalls).toBe(0);
    expect(after.semanticTrace?.recordsAnalyzed).toBe(1);
    expect(after.semanticTrace?.fallbackCount).toBe(0);
    expect(after.semanticTrace?.recordsVisited).toBeLessThan(5);
    expect(after.semanticTrace?.recordsCollected).toBeLessThan(10);
    expect(after.semanticTrace?.recordsMappedIndividually).toBeLessThan(10);
    expect(after.semanticTrace?.cacheFullMaterializations).toBe(0);
    expect(after.semanticTrace?.cacheIndexQueries).toBeLessThan(10);
    expect(after.semanticTrace?.cacheIndexCallbacks).toBeLessThan(12);
    expect(after.semanticTrace?.blockNodesVisited).toBeLessThan(180);
    view.destroy();
  }, 60_000);

  it("keeps a 10,000 list item body edit from traversing the whole list", async () => {
    let doc = numberedListDoc(10_000);
    let target = doc.indexOf("item 5000 body") + "item 5000 body".length;
    let view = await markdownAnalysisView(doc, "item 0");

    let { after } = await dispatchScheduledLocalEdit(
      view,
      { changes: { from: target, insert: "!" } },
      "10k list item body edit",
      { oracle: "semantic" },
    );

    expect(after.semanticTrace?.recordsAnalyzed).toBe(1);
    expect(after.semanticTrace?.fallbackCount).toBe(0);
    expect(after.semanticTrace?.recordsVisited).toBeLessThanOrEqual(5);
    expect(after.semanticTrace?.recordsCollected).toBeLessThan(10);
    expect(after.semanticTrace?.recordsMappedIndividually).toBeLessThan(10);
    expect(after.semanticTrace?.cacheFullMaterializations).toBe(0);
    expect(after.semanticTrace?.cacheIndexQueries).toBeLessThan(10);
    expect(after.semanticTrace?.cacheIndexCallbacks).toBeLessThan(12);
    expect(after.semanticTrace?.leavesCollected).toBeLessThanOrEqual(5);
    expect(after.semanticTrace?.blockNodesVisited).toBeLessThan(220);
    view.destroy();
  }, 60_000);

  it("keeps a 10,000 quote paragraph middle edit range-local", async () => {
    let doc = numberedQuoteParagraphDoc(10_000);
    let target = doc.indexOf("quote 5000 body") + "quote 5000 body".length;
    let view = await markdownAnalysisView(doc, "quote 0");

    let { after } = await dispatchScheduledLocalEdit(
      view,
      { changes: { from: target, insert: "!" } },
      "10k quote paragraph middle edit",
      { oracle: "semantic" },
    );

    expect(after.semanticTrace?.recordsAnalyzed).toBe(1);
    expect(after.semanticTrace?.fallbackCount).toBe(0);
    expect(after.semanticTrace?.recordsVisited).toBeLessThanOrEqual(3);
    expect(after.semanticTrace?.recordsCollected).toBeLessThan(10);
    expect(after.semanticTrace?.recordsMappedIndividually).toBeLessThan(10);
    expect(after.semanticTrace?.cacheFullMaterializations).toBe(0);
    expect(after.semanticTrace?.cacheIndexQueries).toBeLessThan(10);
    expect(after.semanticTrace?.cacheIndexCallbacks).toBeLessThan(10);
    expect(after.semanticTrace?.leavesCollected).toBeLessThanOrEqual(3);
    expect(after.semanticTrace?.blockNodesVisited).toBeLessThan(260);
    view.destroy();
  }, 60_000);

  it("keeps disjoint 10,000 paragraph multi-change transactions range-local", async () => {
    let doc = numberedPlainParagraphDoc(10_000);
    let firstTarget = doc.indexOf("paragraph 100") + "paragraph 100".length;
    let secondTarget = doc.indexOf("paragraph 9000") + "paragraph 9000".length;
    let view = await markdownAnalysisView(doc, "paragraph 0");

    let { after } = await dispatchScheduledLocalEdit(
      view,
      {
        changes: [
          { from: firstTarget, insert: "!" },
          { from: secondTarget, insert: "?" },
        ],
      },
      "10k disjoint paragraph multi-change",
      { oracle: "semantic" },
    );

    expectPr75LocalTrace(after.semanticTrace, "10k disjoint paragraph multi-change", {
      recordsAnalyzed: 2,
      recordsCollectedLessThan: 20,
      recordsMappedLessThan: 20,
      recordsVisitedLessThan: 10,
      cacheIndexCallbacksLessThan: 12,
      cacheIndexQueriesLessThan: 12,
    });
    view.destroy();
  }, 60_000);

  it("does not materialize old RangeSet cache records during consecutive local transitions", async () => {
    let service = await loadMarkdownParserService();
    let state0 = EditorState.create({ doc: numberedParagraphDoc(1_000) });
    let tree0 = service.blockParser.parse(state0.doc);
    let tree1: Tree | null = null;
    let tree2: Tree | null = null;

    try {
      let snapshot0 = walkMarkdownBlocks(tree0, state0.doc).snapshot;
      let fresh0 = buildFreshLeafAnalysisCache({
        analysisInput: { service, state: state0, tree: tree0 },
        snapshot: snapshot0,
      });
      let sourceIslandLeaves0 = sourceIslandLeavesFromLeafAnalysisRecords(
        state0.doc,
        materializeLeafAnalysisCacheRecords(fresh0.cache),
      );

      let firstTarget = state0.doc.toString().indexOf("paragraph 500") + "paragraph 500".length;
      let transaction1 = state0.update({ changes: { from: firstTarget, insert: "!" } });
      tree1 = service.blockParser.parse(transaction1.state.doc);
      let local1 = transitionLeafAnalysisCacheLocal({
        analysisInput: { service, state: transaction1.state, tree: tree1 },
        changes: transaction1.changes,
        oldCache: fresh0.cache,
        oldDoc: state0.doc,
        oldSourceIslandLeaves: sourceIslandLeaves0,
      });
      expect(local1.fallback).toBeUndefined();
      expect(local1.sourceIslandLeaves).toBeDefined();

      let doc1 = transaction1.state.doc.toString();
      let secondTarget = doc1.indexOf("paragraph 700") + "paragraph 700".length;
      let transaction2 = transaction1.state.update({
        changes: { from: secondTarget, insert: "?" },
      });
      tree2 = service.blockParser.parse(transaction2.state.doc);
      let local2 = transitionLeafAnalysisCacheLocal({
        analysisInput: { service, state: transaction2.state, tree: tree2 },
        changes: transaction2.changes,
        oldCache: local1.cache,
        oldDoc: transaction1.state.doc,
        oldSourceIslandLeaves: local1.sourceIslandLeaves,
      });

      expect(local2.fallback).toBeUndefined();
      expect(local2.trace.recordsAnalyzed).toBe(1);
      expect(local2.trace.recordsVisited).toBeLessThan(5);
      expect(local2.trace.cacheFullMaterializations).toBe(0);
    } finally {
      deleteLiveMdTree(tree0);
      if (tree1) deleteLiveMdTree(tree1);
      if (tree2) deleteLiveMdTree(tree2);
    }
  });

  it("does not materialize RangeSet cache records during selection-only reprojection", async () => {
    let doc = numberedParagraphDoc(1_000);
    let target = doc.indexOf("paragraph 500") + "paragraph 500".length;
    let view = await markdownAnalysisView(doc, "paragraph 0");

    try {
      let { after } = await dispatchScheduledLocalEdit(
        view,
        { changes: { from: target, insert: "!" } },
        "selection-only reprojection",
        { oracle: "semantic" },
      );
      if (!after.semantic) throw new Error("Expected semantic cache after local edit");

      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("paragraph 900") } });

      let reprojected = __testLiveMdAnalysis(view);
      expect(reprojected.semantic?.cache).toBe(after.semantic.cache);
      expect(reprojected.semanticTrace?.projectionRecords).toBe(0);
      expect(reprojected.semanticTrace?.cacheFullMaterializations).toBe(0);
    } finally {
      view.destroy();
    }
  });

  it("keeps 100,000 paragraph local cache transitions off full-record remapping", async () => {
    let service = await loadMarkdownParserService();
    let state0 = EditorState.create({ doc: numberedPlainParagraphDoc(100_000) });
    let tree0 = service.blockParser.parse(state0.doc);
    let snapshot0 = walkMarkdownBlocks(tree0, state0.doc).snapshot;
    let fresh = buildFreshLeafAnalysisCache({
      analysisInput: { service, state: state0, tree: tree0 },
      snapshot: snapshot0,
    });
    let oldCache = fresh.cache;
    let oldRecords = materializeLeafAnalysisCacheRecords(oldCache);
    let untouchedOld = oldRecords[90_000]!;
    let tree1: Tree | null = null;
    let tree2: Tree | null = null;

    expect(oldRecords).toHaveLength(100_000);

    try {
      let transaction1 = state0.update({ changes: { from: 0, insert: "intro\n\n" } });
      tree1 = service.blockParser.parse(transaction1.state.doc);
      let front = transitionLeafAnalysisCacheLocal({
        analysisInput: { service, state: transaction1.state, tree: tree1 },
        changes: transaction1.changes,
        oldCache,
        oldDoc: state0.doc,
      });

      expect(front.fallback).toBeUndefined();
      expect(front.trace.recordsAnalyzed).toBe(1);
      expect(front.trace.fallbackCount).toBe(0);
      expect(front.trace.recordsVisited).toBeLessThan(8);
      expect(front.trace.recordsCollected).toBeLessThan(10);
      expect(front.trace.recordsMappedIndividually).toBeLessThan(10);
      expect(front.trace.cacheFullMaterializations).toBe(0);
      expect(front.trace.cacheIndexCallbacks).toBeGreaterThan(0);
      expect(front.trace.cacheIndexCallbacks).toBeLessThan(10);
      expect(front.trace.cacheIndexQueries).toBeGreaterThan(0);
      expect(front.trace.cacheIndexQueries).toBeLessThan(10);
      expect(front.trace.recordsReused).toBeGreaterThan(99_000);

      let untouchedAfterFront = onlyRecordTouching(
        front.cache,
        mapRangeForTest(untouchedOld.sourceRange, transaction1.changes),
        "untouched front insert record",
      );
      expect(untouchedAfterFront.cacheId).toBe(untouchedOld.cacheId);
      expect(untouchedAfterFront.analysis).toBe(untouchedOld.analysis);

      let doc1 = transaction1.state.doc.toString();
      let editTarget = doc1.indexOf("paragraph 50000") + "paragraph 50000".length;
      let transaction2 = transaction1.state.update({
        changes: { from: editTarget, insert: "!" },
      });
      tree2 = service.blockParser.parse(transaction2.state.doc);
      let middle = transitionLeafAnalysisCacheLocal({
        analysisInput: { service, state: transaction2.state, tree: tree2 },
        changes: transaction2.changes,
        oldCache: front.cache,
        oldDoc: transaction1.state.doc,
      });

      expect(middle.fallback).toBeUndefined();
      expect(middle.trace.recordsAnalyzed).toBe(1);
      expect(middle.trace.fallbackCount).toBe(0);
      expect(middle.trace.recordsVisited).toBeLessThan(8);
      expect(middle.trace.recordsCollected).toBeLessThan(10);
      expect(middle.trace.recordsMappedIndividually).toBeLessThan(10);
      expect(middle.trace.cacheFullMaterializations).toBe(0);
      expect(middle.trace.cacheIndexCallbacks).toBeGreaterThan(0);
      expect(middle.trace.cacheIndexCallbacks).toBeLessThan(10);
      expect(middle.trace.cacheIndexQueries).toBeGreaterThan(0);
      expect(middle.trace.cacheIndexQueries).toBeLessThan(10);
      expect(middle.trace.recordsReused).toBeGreaterThan(99_000);

      let untouchedAfterMiddle = onlyRecordTouching(
        middle.cache,
        mapRangeForTest(untouchedAfterFront.sourceRange, transaction2.changes),
        "untouched middle edit record",
      );
      expect(untouchedAfterMiddle.cacheId).toBe(untouchedOld.cacheId);
      expect(untouchedAfterMiddle.analysis).toBe(untouchedOld.analysis);
    } finally {
      deleteLiveMdTree(tree0);
      if (tree1) deleteLiveMdTree(tree1);
      if (tree2) deleteLiveMdTree(tree2);
    }
  }, 180_000);

  it("keeps repeated 10,000 paragraph cache transitions local", async () => {
    let harness = await createLocalCacheHarness(numberedPlainParagraphDoc(10_000));
    let oldRecords = materializeLeafAnalysisCacheRecords(harness.current.cache);
    let untouchedOld = oldRecords[9_000]!;
    let untouchedRange = untouchedOld.sourceRange;
    let finalFull = null as ReturnType<typeof transitionLeafAnalysisCache> | null;

    expect(oldRecords).toHaveLength(10_000);

    try {
      for (let index = 0; index < 1_000; index++) {
        let targetLine = harness.state.doc.line(5_000 * 2 + 1);
        let transaction = harness.state.update({
          changes: { from: targetLine.to, insert: "!" },
        });
        let previousCache = harness.current.cache;
        let previousDoc = harness.state.doc;
        let local = harness.apply(transaction);

        expect(local.fallback, `repeat ${index}`).toBeUndefined();
        expect(local.trace.recordsAnalyzed, `repeat ${index}`).toBe(1);
        expect(local.trace.fallbackCount, `repeat ${index}`).toBe(0);
        expect(local.trace.recordsVisited, `repeat ${index}`).toBeLessThan(8);
        expect(local.trace.recordsCollected, `repeat ${index}`).toBeLessThan(10);
        expect(local.trace.recordsMappedIndividually, `repeat ${index}`).toBeLessThan(10);
        expect(local.trace.cacheFullMaterializations, `repeat ${index}`).toBe(0);
        expect(local.trace.cacheIndexCallbacks, `repeat ${index}`).toBeLessThan(10);
        expect(local.trace.cacheIndexQueries, `repeat ${index}`).toBeLessThan(10);
        expect(local.trace.recordsReused, `repeat ${index}`).toBeGreaterThan(9_990);
        expect(leafAnalysisCacheRecordCount(local.cache), `repeat ${index}`).toBe(10_000);

        if (index == 999) {
          let fullSnapshot = walkMarkdownBlocks(harness.tree, harness.state.doc).snapshot;
          finalFull = transitionLeafAnalysisCache({
            analysisInput: { service: harness.service, state: harness.state, tree: harness.tree },
            changes: transaction.changes,
            oldCache: previousCache,
            oldDoc: previousDoc,
            snapshot: fullSnapshot,
          });
        }

        untouchedRange = mapRangeForTest(untouchedRange, transaction.changes);
      }

      let untouchedAfter = onlyRecordTouching(
        harness.current.cache,
        untouchedRange,
        "untouched repeated edit record",
      );
      expect(untouchedAfter.cacheId).toBe(untouchedOld.cacheId);
      expect(untouchedAfter.analysis).toBe(untouchedOld.analysis);
      expect(finalFull).not.toBeNull();
      expect(
        firstCanonicalMismatch(
          canonicalSemanticTransitionCache(harness.state, harness.current.cache),
          canonicalSemanticTransitionCache(harness.state, finalFull!.cache),
        ),
        "final repeated local transition must match full-walk transition with cache ids",
      ).toBeNull();

      let freshSnapshot = walkMarkdownBlocks(harness.tree, harness.state.doc).snapshot;
      let fresh = buildFreshLeafAnalysisCache({
        analysisInput: { service: harness.service, state: harness.state, tree: harness.tree },
        snapshot: freshSnapshot,
        startCacheId: harness.current.cache.nextCacheId,
      });
      expect(canonicalSemanticRecordsFromCache(harness.state, harness.current.cache)).toEqual(
        canonicalSemanticRecordsFromCache(harness.state, fresh.cache),
      );
    } finally {
      harness.destroy();
    }
  }, 180_000);

  it("keeps document-front and jumping 10,000 paragraph cache transitions local", async () => {
    let harness = await createLocalCacheHarness(numberedPlainParagraphDoc(10_000));

    try {
      for (let index = 0; index < 250; index++) {
        let local = harness.apply(harness.state.update({ changes: { from: 0, insert: "!" } }));
        expectPr75LocalTrace(local.trace, `front insert ${index}`, {
          recordsAnalyzed: 1,
          recordsReusedGreaterThan: 9_990,
        });
        expect(leafAnalysisCacheRecordCount(local.cache), `front insert ${index}`).toBe(10_000);
      }

      for (let index = 0; index < 250; index++) {
        let paragraphIndex = (index * 37) % 10_000;
        let targetLine = harness.state.doc.line(paragraphIndex * 2 + 1);
        let local = harness.apply(
          harness.state.update({ changes: { from: targetLine.to, insert: "?" } }),
        );
        expectPr75LocalTrace(local.trace, `jumping edit ${index}`, {
          recordsAnalyzed: 1,
          recordsReusedGreaterThan: 9_990,
        });
        expect(leafAnalysisCacheRecordCount(local.cache), `jumping edit ${index}`).toBe(10_000);
      }

      let freshSnapshot = walkMarkdownBlocks(harness.tree, harness.state.doc).snapshot;
      let fresh = buildFreshLeafAnalysisCache({
        analysisInput: { service: harness.service, state: harness.state, tree: harness.tree },
        snapshot: freshSnapshot,
      });
      expect(canonicalSemanticRecordsFromCache(harness.state, harness.current.cache)).toEqual(
        canonicalSemanticRecordsFromCache(harness.state, fresh.cache),
      );
    } finally {
      harness.destroy();
    }
  }, 180_000);

  it("keeps 500 undo/redo command cache transitions local", async () => {
    let harness = await createLocalCacheHarness(numberedPlainParagraphDoc(10_000), [history()]);

    try {
      let targetLine = harness.state.doc.line(5_000 * 2 + 1);
      let initial = harness.apply(
        harness.state.update({
          changes: { from: targetLine.to, insert: "!" },
          selection: { anchor: targetLine.to + 1 },
          userEvent: "input",
        }),
      );
      expectPr75LocalTrace(initial.trace, "undo/redo seed edit", {
        recordsAnalyzed: 1,
        recordsReusedGreaterThan: 9_990,
      });

      for (let index = 0; index < 500; index++) {
        let undone = commandTransaction(harness.state, undo, `undo ${index}`);
        let undoLocal = harness.apply(undone);
        expectPr75LocalTrace(undoLocal.trace, `undo ${index}`, {
          recordsAnalyzed: 1,
          recordsReusedGreaterThan: 9_990,
        });

        let redone = commandTransaction(harness.state, redo, `redo ${index}`);
        let redoLocal = harness.apply(redone);
        expectPr75LocalTrace(redoLocal.trace, `redo ${index}`, {
          recordsAnalyzed: 1,
          recordsReusedGreaterThan: 9_990,
        });
      }

      let freshSnapshot = walkMarkdownBlocks(harness.tree, harness.state.doc).snapshot;
      let fresh = buildFreshLeafAnalysisCache({
        analysisInput: { service: harness.service, state: harness.state, tree: harness.tree },
        snapshot: freshSnapshot,
      });
      expect(canonicalSemanticRecordsFromCache(harness.state, harness.current.cache)).toEqual(
        canonicalSemanticRecordsFromCache(harness.state, fresh.cache),
      );
    } finally {
      harness.destroy();
    }
  }, 180_000);

  it("does not scan source island tail leaves for zero-width removal ranges", () => {
    let count = 10_000;
    let point = 5_000;
    let state0 = EditorState.create({ doc: "x".repeat(count * 10) });
    let transaction = state0.update({ changes: { from: point, insert: "!" } });
    let reads = 0;
    let oldLeaves: LiveMdSourceIslandLeaf[] = Array.from({ length: count }, (_value, index) => {
      let sourceRange = { from: index * 10, to: (index + 1) * 10 };
      let leaf = {
        contextKey: `leaf-${index}`,
        kind: "paragraph" as const,
      } as LiveMdSourceIslandLeaf;
      Object.defineProperty(leaf, "sourceRange", {
        configurable: true,
        get() {
          reads++;
          return sourceRange;
        },
      });
      return leaf;
    });

    let transitioned = transitionSourceIslandLeavesFromLeafAnalysisRecords({
      changes: transaction.changes,
      doc: transaction.state.doc,
      localRecords: [],
      localWindows: [],
      oldChangedRanges: [{ from: point, to: point }],
      oldDoc: state0.doc,
      oldLeaves,
    });

    expect(transitioned.length).toBe(count - 2);
    expect(transitioned[499]?.contextKey).toBe("leaf-501");
    expect(reads).toBeLessThan(200);
  });
});
