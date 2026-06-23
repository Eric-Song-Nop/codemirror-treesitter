// @vitest-environment happy-dom

import {
  type ChangeDesc,
  Compartment,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type StateCommand,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { history, redo, undo } from "@codemirror-treesitter/commands";
import { EditorView, type DecorationSet } from "@codemirror/view";
import {
  ensureSyntaxTree,
  HighlightStyle,
  syntaxHighlighting,
  tags as t,
  Tree,
  type DocRange,
  type Highlighter,
} from "@codemirror-treesitter/language";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  __testBuildCanonicalLiveMdAnalysis,
  __testBuildLiveMdAnalysis,
  __testFlushLiveMdAnalysis,
  __testLiveMdAnalysis,
  __testRefreshLiveMdSurface,
  liveMdAnalysis,
} from "../src/core/decorations.js";
import { emptyLiveMdLeafAnalysisTrace } from "../src/core/analysis/types.js";
import { liveMdMarkdownFeatureFacet, liveMdMarkdownFeatures } from "../src/core/features.js";
import {
  liveMdImageSource,
  liveMdImageSourceResolver,
  normalizeMarkdownImageSource,
} from "../src/core/images.js";
import { walkMarkdownBlocks } from "../src/core/analysis/markdown-block-cursor.js";
import {
  buildFreshLeafAnalysisCache,
  createLeafAnalysisCache,
  findLeafAnalysisRecordsTouchingRanges,
  leafAnalysisCacheRecordCount,
  materializeLeafAnalysisCacheRecords,
  transitionLeafAnalysisCache,
  transitionLeafAnalysisCacheLocal,
} from "../src/core/analysis/markdown-leaf-cache.js";
import {
  analyzeMarkdownLeafSemantics,
  hashDocRange,
} from "../src/core/analysis/markdown-leaf-analysis.js";
import {
  compileFullDirectLayoutProjection,
  compileFullSurfaceProjection,
  compileVisibleSurfaceProjection,
} from "../src/core/projection/compilers.js";
import {
  activeMarkdownSourceRanges,
  sourceIslandLeavesFromLeafAnalysisRecords,
  transitionSourceIslandLeavesFromLeafAnalysisRecords,
  type LiveMdSourceIslandLeaf,
} from "../src/core/analysis/markdown-source-islands.js";
import { type LeafAnalysisRecord } from "../src/core/analysis/descriptors.js";
import { type LiveMdLeafAnalysisTrace } from "../src/core/analysis/types.js";
import {
  codeFenceLanguagesField,
  codeFenceHighlighterFacet,
  deleteLiveMdTree,
  liveMdCodeFenceHighlighting,
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  liveMdMarkdownParserServiceFacet,
  setCodeFenceLanguages,
} from "../src/core/languages.js";
import { liveMdLinkBaseUrl, liveMdLinkInteractions, liveMdLinkOpen } from "../src/core/links.js";
import { loadMarkdownParserService } from "@codemirror-treesitter/language-data";

let locationDescriptor: PropertyDescriptor | undefined;

const testLightCodeFenceHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#0969da" },
]);

const testDarkCodeFenceHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#f5a97f" },
]);

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

describe("LiveMD analysis snapshot", () => {
  it("builds decorations through query captures without tree iteration", async () => {
    let state = await markdownAnalysisState(liveMdKitchenSinkDoc(), "After anchor");
    expect(canonicalAnalysis(state).decorations.length).toBeGreaterThan(0);
    let iterateDescriptor = Object.getOwnPropertyDescriptor(Tree.prototype, "iterate")!;

    Object.defineProperty(Tree.prototype, "iterate", {
      configurable: true,
      value: () => {
        throw new Error("LiveMD analysis should use tree-sitter queries");
      },
    });
    try {
      expect(
        canonicalAnalysis(state, __testBuildLiveMdAnalysis(state)).decorations.length,
      ).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(Tree.prototype, "iterate", iterateDescriptor);
    }
  });

  it("keeps full-document analysis equivalent after edits", async () => {
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

    expect(canonicalAnalysis(view.state, __testLiveMdAnalysis(view))).toEqual(
      canonicalAnalysis(view.state, __testBuildCanonicalLiveMdAnalysis(view.state)),
    );
    view.destroy();
  });

  it("keeps docChanged input on a source-safe pending fast path", async () => {
    let doc =
      "| Name | Value |\n" +
      "| --- | ---: |\n" +
      "| alpha | 1 |\n\n" +
      "```ts\nlet a = 1;\n```\n\n" +
      "after";
    let parseCalls = 0;
    let languages = new Map(await loadCodeFenceLanguages());
    let tsParser = languages.get("ts");
    if (!tsParser) throw new Error("TypeScript code fence parser is unavailable");
    let trackedTsParser = Object.create(tsParser) as typeof tsParser;
    trackedTsParser.parseWith = (...args: Parameters<typeof tsParser.parseWith>) => {
      parseCalls++;
      return tsParser.parseWith(...args);
    };
    languages.set("ts", trackedTsParser);

    let view = await markdownAnalysisView(doc, "after");
    view.dispatch({ effects: setCodeFenceLanguages.of(languages) });
    expect(tablePreviewTables(view.state)).toHaveLength(1);

    parseCalls = 0;
    let editFrom = doc.indexOf("alpha");
    view.dispatch({
      changes: { from: editFrom, to: editFrom + "alpha".length, insert: "bravo" },
    });

    let pending = __testLiveMdAnalysis(view);
    expect(pending.pending).toBeTruthy();
    expect(pending.trace.blockNodesVisited).toBe(0);
    expect(pending.trace.recordsVisited).toBe(0);
    expect(pending.trace.inlineParseCalls).toBe(0);
    expect(pending.trace.codeFenceParses).toBe(0);
    expect(pending.trace.directProjectionRecords).toBe(0);
    expect(pending.trace.directProjectionWindows).toEqual([]);
    expect(pending.trace.languageApplyMs).toBeGreaterThanOrEqual(0);
    expect(pending.trace.languageWorkIterations).toBe(1);
    expect(parseCalls).toBe(0);
    expect(tablePreviewTables(view.state, pending)).toHaveLength(0);

    await __testFlushLiveMdAnalysis(view);

    let committed = __testLiveMdAnalysis(view);
    expect(committed.pending).toBeNull();
    expect(committed.trace.recordsVisited).toBeGreaterThan(0);
    expect(tablePreviewTables(view.state, committed)[0]?.rows[0]?.[0]).toBe("bravo");
    view.destroy();
  });

  it("does not scan all semantic records on the docChanged pending fast path", async () => {
    let doc = Array.from({ length: 200 }, (_value, index) => `paragraph ${index}`).join("\n\n");
    let view = await markdownAnalysisView(doc, "paragraph 199");

    view.dispatch({ changes: { from: doc.length, insert: "!" } });

    let pending = __testLiveMdAnalysis(view);
    expect(pending.pending).toBeTruthy();
    expect(pending.trace.recordsVisited).toBe(0);
    expect(pending.trace.cacheFullMaterializations).toBe(0);
    view.destroy();
  });

  it("does not map all source island leaves on the docChanged pending fast path", async () => {
    let doc = Array.from({ length: 1_000 }, (_value, index) => `paragraph ${index}`).join("\n\n");
    let view = await markdownAnalysisView(doc, "paragraph 950");
    let before = __testLiveMdAnalysis(view);
    let reads = 0;
    for (let leaf of before.sourceIslandLeaves) {
      let sourceRange = leaf.sourceRange;
      Object.defineProperty(leaf, "sourceRange", {
        configurable: true,
        get() {
          reads++;
          return sourceRange;
        },
      });
    }

    view.dispatch({ changes: { from: 0, insert: "intro\n\n" } });

    let pending = __testLiveMdAnalysis(view);
    expect(pending.pending).toBeTruthy();
    expect(pending.sourceIslandLeaves).toBe(before.sourceIslandLeaves);
    expect(reads).toBeLessThan(80);
    view.destroy();
  });

  it("keeps source-safe inline marks during pending same-block edits", async () => {
    let doc = "keep **bold** and [link](https://example.com) tail";
    let view = await markdownAnalysisView(doc, "tail");

    expect(decorationClasses(view.state).has("cm-md-strong")).toBe(true);
    expect(decorationClasses(view.state).has("cm-md-link")).toBe(true);

    let editFrom = doc.indexOf("tail");
    view.dispatch({ changes: { from: editFrom, insert: "new " } });

    let pending = __testLiveMdAnalysis(view);
    expect(pending.pending).toBeTruthy();
    expect(decorationClasses(view.state, pending).has("cm-md-strong")).toBe(true);
    expect(decorationClasses(view.state, pending).has("cm-md-link")).toBe(true);

    await __testFlushLiveMdAnalysis(view);

    let committed = __testLiveMdAnalysis(view);
    expect(committed.pending).toBeNull();
    expect(decorationClasses(view.state, committed).has("cm-md-strong")).toBe(true);
    expect(decorationClasses(view.state, committed).has("cm-md-link")).toBe(true);
    view.destroy();
  });

  it("opens active source islands during pending selection-only updates", async () => {
    let doc =
      "| Name | Value |\n" +
      "| --- | ---: |\n" +
      "| **alpha** | [one](https://one.example) |\n\n" +
      "next";
    let view = await markdownAnalysisView(doc, "next");
    expect(tablePreviewTables(view.state)).toHaveLength(1);

    view.dispatch({ changes: { from: doc.indexOf("next"), insert: "new " } });
    expect(tablePreviewTables(view.state, __testLiveMdAnalysis(view))).toHaveLength(1);

    view.dispatch({ selection: { anchor: doc.indexOf("alpha") } });

    let pending = __testLiveMdAnalysis(view);
    expect(pending.pending).toBeTruthy();
    expect(pending.activeSourceRanges).toHaveLength(1);
    expect(tablePreviewTables(view.state, pending)).toHaveLength(0);
    view.destroy();
  });

  it("keeps boundary inserts inside pending active source islands", async () => {
    let view = await markdownAnalysisView("alpha\n\nbeta", "beta");

    view.dispatch({
      changes: { from: 0, insert: "new " },
      selection: { anchor: 2 },
    });

    let pending = __testLiveMdAnalysis(view);
    expect(pending.pending).toBeTruthy();
    expect(
      pending.activeSourceRanges.map((range) => view.state.sliceDoc(range.from, range.to)),
    ).toEqual(["new alpha"]);
    view.destroy();
  });

  it("keeps runtime epoch changes on the scheduled pending path", async () => {
    let view = await markdownAnalysisView("alpha\n\nbeta", "alpha");

    view.dispatch({ changes: { from: 0, insert: "new " } });
    expect(__testLiveMdAnalysis(view).pending).toBeTruthy();

    view.dispatch({ effects: setCodeFenceLanguages.of(new Map()) });

    let pending = __testLiveMdAnalysis(view);
    expect(pending.pending).toBeTruthy();
    expect(pending.trace.blockNodesVisited).toBe(0);
    expect(pending.trace.inlineParseCalls).toBe(0);
    expect(pending.trace.codeFenceParses).toBe(0);

    await __testFlushLiveMdAnalysis(view);
    expect(__testLiveMdAnalysis(view).pending).toBeNull();
    view.destroy();
  });

  it("does not start scheduled analysis before the first animation frame", async () => {
    let originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    let originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let originalRequestIdleCallback = globalThis.requestIdleCallback;
    let originalCancelIdleCallback = globalThis.cancelIdleCallback;
    let frames: FrameRequestCallback[] = [];
    let idleRequests = 0;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
    globalThis.requestIdleCallback = ((callback: IdleRequestCallback) => {
      idleRequests++;
      return setTimeout(() => {
        callback({ didTimeout: false, timeRemaining: () => 50 });
      }, 0) as unknown as number;
    }) as typeof globalThis.requestIdleCallback;
    globalThis.cancelIdleCallback = ((id: number) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    }) as typeof globalThis.cancelIdleCallback;

    let view = await markdownAnalysisView("alpha\n\nbeta", "alpha");
    try {
      frames = [];
      view.dispatch({ changes: { from: 0, insert: "new " } });

      expect(__testLiveMdAnalysis(view).pending).toBeTruthy();
      expect(idleRequests).toBe(0);
      expect(frames).toHaveLength(1);

      frames.shift()?.(0);

      expect(__testLiveMdAnalysis(view).pending).toBeTruthy();
      expect(idleRequests).toBe(0);
    } finally {
      view.destroy();
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      globalThis.requestIdleCallback = originalRequestIdleCallback;
      globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
  });

  it("reschedules scheduled analysis without starving on short idle deadlines", async () => {
    let originalRequestIdleCallback = globalThis.requestIdleCallback;
    let originalCancelIdleCallback = globalThis.cancelIdleCallback;
    let idleAttempts = 0;
    globalThis.requestIdleCallback = ((callback: IdleRequestCallback) => {
      let attempt = idleAttempts++;
      let reads = 0;
      return setTimeout(() => {
        callback({
          didTimeout: false,
          timeRemaining() {
            if (attempt >= 2) return 0;
            return reads++ == 0 ? 1 : 0;
          },
        });
      }, 0) as unknown as number;
    }) as typeof globalThis.requestIdleCallback;
    globalThis.cancelIdleCallback = ((id: number) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    }) as typeof globalThis.cancelIdleCallback;

    let view = await markdownAnalysisView("alpha\n\nbeta", "alpha");
    try {
      view.dispatch({ changes: { from: 0, insert: "new " } });
      await __testFlushLiveMdAnalysis(view);

      expect(idleAttempts).toBeGreaterThanOrEqual(3);
      expect(__testLiveMdAnalysis(view).pending).toBeNull();
    } finally {
      view.destroy();
      globalThis.requestIdleCallback = originalRequestIdleCallback;
      globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
  });

  it("coalesces rapid docChanged updates to the latest runtime revision", async () => {
    let view = await markdownAnalysisView("alpha\n\nbeta\n\ngamma", "alpha");

    view.dispatch({ changes: { from: 0, insert: "one " } });
    let firstPending = __testLiveMdAnalysis(view);
    expect(firstPending.pending?.revision).toBe(1);

    view.dispatch({ changes: { from: view.state.doc.length, insert: "\ntwo" } });
    let secondPending = __testLiveMdAnalysis(view);
    expect(secondPending.pending?.revision).toBe(2);

    await __testFlushLiveMdAnalysis(view);

    let committed = __testLiveMdAnalysis(view);
    expect(committed.pending).toBeNull();
    expect(committed.revision).toBe(2);
    expect(view.state.doc.toString()).toBe("one alpha\n\nbeta\n\ngamma\ntwo");
    view.destroy();
  });

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

  it("does not materialize old segmented records during consecutive local transitions", async () => {
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

  it("does not materialize segmented records during selection-only reprojection", async () => {
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

  it("recomputes active-dependent legacy feature decorations on selection changes", async () => {
    let doc = "# First\n\nparagraph with *one*\n\n# Second\n";
    let view = await markdownAnalysisView(doc, "First", [
      liveMdMarkdownFeatures([
        {
          name: "test-active-heading-feature",
          query: "(atx_heading) @target",
          decorate({ addLineClass, node, rangeTouchesActiveLine }) {
            let target = node("target");
            if (target && rangeTouchesActiveLine(target.from, target.to)) {
              addLineClass(target.from, target.to, "is-active");
            }
          },
        },
      ]),
    ]);

    expect(lineHasClass(view.state, "# First", "is-active")).toBe(true);
    expect(lineHasClass(view.state, "# Second", "is-active")).toBe(false);

    view.dispatch({ selection: { anchor: doc.indexOf("Second") } });

    expect(lineHasClass(view.state, "# First", "is-active")).toBe(false);
    expect(lineHasClass(view.state, "# Second", "is-active")).toBe(true);
    expect(__testLiveMdAnalysis(view).semanticTrace?.legacyFeatureFullQueryCount).toBe(1);
    expect(canonicalAnalysis(view.state, __testLiveMdAnalysis(view))).toEqual(
      canonicalAnalysis(view.state, __testBuildCanonicalLiveMdAnalysis(view.state)),
    );
    view.destroy();
  });

  it("recomputes legacy feature decorations for arbitrary StateField changes", async () => {
    let setClass = StateEffect.define<string>();
    let classField = StateField.define<string>({
      create() {
        return "cm-md-feature-first";
      },
      update(value, transaction) {
        for (let effect of transaction.effects) {
          if (effect.is(setClass)) return effect.value;
        }
        return value;
      },
    });
    let view = await markdownAnalysisView("# Dynamic\n\nbody", "body", [
      classField,
      liveMdMarkdownFeatures([
        {
          name: "test-state-field-feature",
          query: "(atx_heading) @heading",
          decorate({ addMark, node, state }) {
            let heading = node("heading");
            if (!heading) return;
            addMark(heading.from, heading.to, state.field(classField));
          },
        },
      ]),
    ]);

    expect(decorationClasses(view.state).has("cm-md-feature-first")).toBe(true);
    expect(decorationClasses(view.state).has("cm-md-feature-second")).toBe(false);

    view.dispatch({ effects: setClass.of("cm-md-feature-second") });

    expect(decorationClasses(view.state).has("cm-md-feature-first")).toBe(false);
    expect(decorationClasses(view.state).has("cm-md-feature-second")).toBe(true);
    expect(__testLiveMdAnalysis(view).semanticTrace?.legacyFeatureFullQueryCount).toBe(1);
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
      let tamperedCache = createLeafAnalysisCache(tamperedRecords, oldTransition.cache.nextCacheId);
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

  it("keeps direct layout and visible surface projections merge-equivalent", async () => {
    let doc =
      "Paragraph with **bold** and [link](https://example.com)\n\n" +
      "| Name | Value |\n" +
      "| --- | ---: |\n" +
      "| alpha | 1 |\n\n" +
      "![Alt](https://example.com/image.png)\n\n" +
      "after";
    let state = await markdownAnalysisState(doc, "after");
    let analysis = __testBuildLiveMdAnalysis(state);
    if (!analysis.semantic) throw new Error("Expected semantic cache for projection oracle");
    let canonical = __testBuildCanonicalLiveMdAnalysis(state);
    let surface = compileFullSurfaceProjection(
      projectionCompileInputForTest(state, analysis),
      analysis.semantic.cache,
    );
    let directProjection = canonicalProjectionFromSets(
      state,
      analysis.directDecorations,
      analysis.directAtomicRanges,
    );
    let canonicalDirectProjection = canonicalProjectionFromSets(
      state,
      canonical.directDecorations,
      canonical.directAtomicRanges,
    );
    let surfaceProjection = canonicalProjectionFromSets(
      state,
      surface.decorations,
      surface.atomicRanges,
    );
    let canonicalSurfaceProjection = canonicalProjectionFromSets(
      state,
      canonical.surfaceDecorations,
      canonical.surfaceAtomicRanges,
    );
    let mergedProjection = canonicalProjectionFromSets(
      state,
      RangeSet.join([analysis.directDecorations, surface.decorations]),
      RangeSet.join([analysis.directAtomicRanges, surface.atomicRanges]),
    );

    expect(directProjection).toEqual(canonicalDirectProjection);
    expect(surfaceProjection).toEqual(canonicalSurfaceProjection);
    expect(mergedProjection).toEqual(canonicalAnalysis(state, analysis));
    expect(canonicalAnalysis(state, analysis)).toEqual(canonicalAnalysis(state, canonical));
    expect(decorationClassesFromSet(state, surface.decorations).has("cm-md-strong")).toBe(true);
    expect(decorationClassesFromSet(state, surface.decorations).has("cm-md-link")).toBe(true);
    expect(decorationClassesFromSet(state, analysis.directDecorations).has("cm-md-strong")).toBe(
      false,
    );
    expect(widgetNamesFromSet(state, analysis.directDecorations)).toContain("TablePreviewWidget");
    expect(widgetNamesFromSet(state, analysis.directDecorations)).toContain("ImagePreviewWidget");
    expect(widgetNamesFromSet(state, surface.decorations)).not.toContain("TablePreviewWidget");
    expect(widgetNamesFromSet(state, surface.decorations)).not.toContain("ImagePreviewWidget");
  });

  it("patches direct layout locally after unrelated paragraph edits", async () => {
    let doc = "| Name | Value |\n" + "| --- | ---: |\n" + "| alpha | 1 |\n\n" + "after paragraph\n";
    let view = await markdownAnalysisView(doc, "after paragraph");
    let before = __testLiveMdAnalysis(view);
    let beforeWidget = widgetInstancesFromSet(
      view.state,
      before.directDecorations,
      "TablePreviewWidget",
    )[0];
    let editFrom = doc.indexOf("after paragraph") + "after paragraph".length;

    let { after, pending } = await dispatchScheduledLocalEdit(
      view,
      {
        changes: { from: editFrom, insert: "!" },
        selection: { anchor: editFrom + 1 },
      },
      "direct projection local paragraph edit",
    );

    expect(beforeWidget).toBeTruthy();
    expect(pending.trace.directProjectionRecords).toBe(0);
    expect(pending.trace.directProjectionWindows).toEqual([]);
    expect(after.semanticTrace?.directProjectionRecords).toBeGreaterThanOrEqual(0);
    expect(after.semanticTrace?.directProjectionRecords).toBeLessThan(3);
    expect(after.semanticTrace?.directProjectionWindows).not.toEqual([
      { from: 0, to: view.state.doc.length },
    ]);
    expect(
      widgetInstancesFromSet(view.state, after.directDecorations, "TablePreviewWidget")[0],
    ).toBe(beforeWidget);
    expectDirectProjectionMatchesFullOracle(view.state, after);
    view.destroy();
  });

  it("patches direct layout locally for selection-only source island changes", async () => {
    let doc = "| Name | Value |\n" + "| --- | ---: |\n" + "| alpha | 1 |\n\n" + "after paragraph\n";
    let view = await markdownAnalysisView(doc, "after paragraph");
    let before = __testLiveMdAnalysis(view);

    view.dispatch({ selection: { anchor: doc.indexOf("alpha") } });

    let after = __testLiveMdAnalysis(view);
    expect(after.semantic?.cache).toBe(before.semantic?.cache);
    expect(after.semanticTrace?.recordsVisited).toBe(0);
    expect(after.semanticTrace?.inlineParseCalls).toBe(0);
    expect(after.semanticTrace?.directProjectionRecords).toBeGreaterThan(0);
    expect(after.semanticTrace?.directProjectionRecords).toBeLessThan(3);
    expect(after.semanticTrace?.directProjectionWindows).not.toEqual([
      { from: 0, to: view.state.doc.length },
    ]);
    expect(widgetNamesFromSet(view.state, after.directDecorations)).not.toContain(
      "TablePreviewWidget",
    );
    expectDirectProjectionMatchesFullOracle(view.state, after);
    view.destroy();
  });

  it("reuses direct projection when the selection stays in the same active source island", async () => {
    let doc = "| Name | Value |\n" + "| --- | ---: |\n" + "| alpha | 1 |\n\n" + "after paragraph\n";
    let view = await markdownAnalysisView(doc, "after paragraph");

    let firstSourcePosition = doc.indexOf("alpha");
    view.dispatch({ selection: { anchor: firstSourcePosition } });
    let active = __testLiveMdAnalysis(view);
    expectNoElement(view, ".cm-md-table-preview");
    expect(active.semanticTrace?.recordsVisited).toBe(0);
    expect(active.semanticTrace?.inlineParseCalls).toBe(0);
    expect(active.semanticTrace?.codeFenceParses).toBe(0);
    expect(active.semanticTrace?.directProjectionRecords).toBeGreaterThan(0);

    let sameSourcePosition = doc.indexOf("1 |");
    view.dispatch({ selection: { anchor: sameSourcePosition } });
    let moved = __testLiveMdAnalysis(view);
    expect(moved).toBe(active);
    expectSelectionHead(view, sameSourcePosition, "same table source selection");
    expectNoElement(view, ".cm-md-table-preview");
    expectDirectProjectionMatchesFullOracle(view.state, moved);
    view.destroy();
  });

  it("keeps real direct widget DOM nodes stable across unrelated local patches", async () => {
    let doc =
      "| Name | Value |\n" +
      "| --- | ---: |\n" +
      "| alpha | 1 |\n\n" +
      "middle paragraph\n\n" +
      "![Alt](assets/one.png)\n\n" +
      "$$\n" +
      "x\n" +
      "$$\n\n" +
      "```mermaid\n" +
      "graph TD\n" +
      "A --> B\n" +
      "```\n\n" +
      "tail\n";
    let view = await markdownAnalysisView(doc, "tail");
    let table = requiredElement(view, ".cm-md-table-preview");
    let image = requiredElement(view, ".cm-md-image-preview");
    let latex = requiredElement(view, ".cm-md-latex-display");
    let mermaid = requiredElement(view, ".cm-md-mermaid");
    let editFrom = doc.indexOf("middle paragraph") + "middle paragraph".length;

    let { after, pending } = await dispatchScheduledLocalEdit(
      view,
      {
        changes: { from: editFrom, insert: "!" },
        selection: { anchor: editFrom + 1 },
      },
      "direct widget DOM stability",
    );

    expect(pending.trace.directProjectionRecords).toBe(0);
    expect(pending.trace.directProjectionWindows).toEqual([]);
    expectSelectionHead(view, editFrom + 1, "direct widget DOM stability edit");
    expect(requiredElement(view, ".cm-md-table-preview")).toBe(table);
    expect(requiredElement(view, ".cm-md-image-preview")).toBe(image);
    expect(requiredElement(view, ".cm-md-latex-display")).toBe(latex);
    expect(requiredElement(view, ".cm-md-mermaid")).toBe(mermaid);
    expectDirectPatchLocal(after.semanticTrace, view.state, [
      lineRangeBySource(view.state, "middle paragraph!"),
    ]);
    expectDirectProjectionMatchesFullOracle(view.state, after);
    view.destroy();
  });

  it("does not leave stale direct replacements when entering and leaving source islands", async () => {
    let cases = [
      {
        doc: "| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n\nTail",
        name: "table",
        selector: ".cm-md-table-preview",
        sourceText: "alpha",
        widgetName: "TablePreviewWidget",
      },
      {
        doc: "![Alt](assets/one.png)\n\nTail",
        name: "image",
        selector: ".cm-md-image-preview",
        sourceText: "one.png",
        widgetName: "ImagePreviewWidget",
      },
      {
        doc: "$$\nx\n$$\n\nTail",
        name: "latex",
        selector: ".cm-md-latex-display",
        sourceText: "x",
        widgetName: "LatexWidget",
      },
      {
        doc: "```mermaid\ngraph TD\nA --> B\n```\n\nTail",
        name: "mermaid",
        selector: ".cm-md-mermaid",
        sourceText: "A --> B",
        widgetName: "MermaidWidget",
      },
    ];

    for (let entry of cases) {
      let view = await markdownAnalysisView(entry.doc, "Tail");
      requiredElement(view, entry.selector);

      let sourcePosition = entry.doc.indexOf(entry.sourceText);
      view.dispatch({ selection: { anchor: sourcePosition } });
      let active = __testLiveMdAnalysis(view);
      expectSelectionHead(view, sourcePosition, `${entry.name} active source`);
      expectNoElement(view, entry.selector);
      expect(widgetNamesFromSet(view.state, active.directDestructiveDecorations)).not.toContain(
        entry.widgetName,
      );
      expect(active.semanticTrace?.recordsVisited).toBe(0);
      expect(active.semanticTrace?.inlineParseCalls).toBe(0);
      expect(active.semanticTrace?.codeFenceParses).toBe(0);
      expectDirectProjectionMatchesFullOracle(view.state, active);

      let tailPosition = view.state.sliceDoc().indexOf("Tail");
      view.dispatch({ selection: { anchor: tailPosition } });
      let inactive = __testLiveMdAnalysis(view);
      expectSelectionHead(view, tailPosition, `${entry.name} inactive tail`);
      requiredElement(view, entry.selector);
      expect(widgetNamesFromSet(view.state, inactive.directDestructiveDecorations)).toContain(
        entry.widgetName,
      );
      expect(inactive.semanticTrace?.codeFenceParses).toBe(0);
      expectDirectProjectionMatchesFullOracle(view.state, inactive);
      view.destroy();
    }
  });

  it("does not restore stale direct replacements after active source edits", async () => {
    let cases = [
      {
        assertCurrent(view: EditorView) {
          let table = requiredElement(view, ".cm-md-table-preview");
          expect(table.textContent).toContain("bravo");
          expect(table.textContent).not.toContain("alpha");
        },
        doc: "| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n\nTail",
        name: "table",
        oldText: "alpha",
        selector: ".cm-md-table-preview",
        widgetName: "TablePreviewWidget",
        newText: "bravo",
      },
      {
        assertCurrent(view: EditorView) {
          let image = requiredElement(view, ".cm-md-image-preview img") as HTMLImageElement;
          expect(image.src).toContain("two.png");
          expect(image.src).not.toContain("one.png");
        },
        doc: "![Alt](assets/one.png)\n\nTail",
        name: "image",
        oldText: "one.png",
        selector: ".cm-md-image-preview",
        widgetName: "ImagePreviewWidget",
        newText: "two.png",
      },
      {
        assertCurrent(view: EditorView) {
          let latex = requiredElement(view, ".cm-md-latex-display") as HTMLElement;
          expect(latex.dataset.source).toContain("y");
          expect(latex.dataset.source).not.toContain("x");
        },
        doc: "$$\nx\n$$\n\nTail",
        name: "latex",
        oldText: "x",
        selector: ".cm-md-latex-display",
        widgetName: "LatexWidget",
        newText: "y",
      },
      {
        assertCurrent(view: EditorView) {
          let mermaid = requiredElement(view, ".cm-md-mermaid") as HTMLElement;
          expect(mermaid.dataset.source).toContain("A --> C");
          expect(mermaid.dataset.source).not.toContain("A --> B");
        },
        doc: "```mermaid\ngraph TD\nA --> B\n```\n\nTail",
        name: "mermaid",
        oldText: "A --> B",
        selector: ".cm-md-mermaid",
        widgetName: "MermaidWidget",
        newText: "A --> C",
      },
    ];

    for (let entry of cases) {
      let view = await markdownAnalysisView(entry.doc, "Tail");
      requiredElement(view, entry.selector);

      let editFrom = entry.doc.indexOf(entry.oldText);
      let expectedHead = editFrom + entry.newText.length;
      view.dispatch({ selection: { anchor: editFrom } });
      expectNoElement(view, entry.selector);

      let { after, pending } = await dispatchScheduledLocalEdit(
        view,
        {
          changes: { from: editFrom, insert: entry.newText, to: editFrom + entry.oldText.length },
          selection: { anchor: expectedHead },
        },
        `${entry.name} active source edit`,
      );

      expectSelectionHead(view, expectedHead, `${entry.name} active source edit`);
      expect(widgetNamesFromSet(view.state, pending.directDestructiveDecorations)).not.toContain(
        entry.widgetName,
      );
      expect(widgetNamesFromSet(view.state, after.directDestructiveDecorations)).not.toContain(
        entry.widgetName,
      );
      expectNoElement(view, entry.selector);
      expectDirectProjectionMatchesFullOracle(view.state, after);

      let tailPosition = view.state.sliceDoc().indexOf("Tail");
      view.dispatch({ selection: { anchor: tailPosition } });
      let inactive = __testLiveMdAnalysis(view);
      expectSelectionHead(view, tailPosition, `${entry.name} inactive after edit`);
      expect(widgetNamesFromSet(view.state, inactive.directDestructiveDecorations)).toContain(
        entry.widgetName,
      );
      entry.assertCurrent(view);
      expectDirectProjectionMatchesFullOracle(view.state, inactive);
      view.destroy();
    }
  });

  it("clips visible surface projections to viewport ranges without semantic work", async () => {
    let doc = Array.from(
      { length: 240 },
      (_value, index) =>
        `paragraph ${index} [link ${index}](https://example.com/${index}) **bold**`,
    ).join("\n\n");
    let state = await markdownAnalysisState(doc, "paragraph 0");
    let analysis = __testBuildLiveMdAnalysis(state);
    if (!analysis.semantic) throw new Error("Expected semantic cache before surface clipping");
    let visibleLine = state.doc.lineAt(doc.indexOf("paragraph 220"));
    let visibleRanges = [{ from: visibleLine.from, to: visibleLine.to }];
    Object.defineProperty(analysis.semantic.cache, "records", {
      configurable: true,
      get() {
        throw new Error("viewport-only surface clipping must not materialize semantic records");
      },
    });

    let clipped = compileVisibleSurfaceProjection(
      projectionCompileInputForTest(state, analysis),
      analysis.semantic.cache,
      visibleRanges,
    );
    let clippedProjection = canonicalProjectionFromSets(
      state,
      clipped.decorations,
      clipped.atomicRanges,
    );

    expect(clippedProjection.decorations.length).toBeGreaterThan(0);
    expect(
      clippedProjection.decorations.every((range) => rangesOverlap(range, visibleRanges[0]!)),
    ).toBe(true);
    expect(
      clippedProjection.atomicRanges.every((range) => rangesOverlap(range, visibleRanges[0]!)),
    ).toBe(true);
  });

  it("keeps visible surface projection equivalent to a full clipped oracle", async () => {
    let doc =
      "outside before **one** [one](https://one.example)\n\n" +
      "visible **two** [two](https://two.example) `code`\n\n" +
      "outside after **three** [three](https://three.example)\n";
    let state = await markdownAnalysisState(doc, "visible");
    let analysis = __testBuildLiveMdAnalysis(state);
    if (!analysis.semantic) throw new Error("Expected semantic cache for visible surface oracle");
    let visibleLine = state.doc.lineAt(doc.indexOf("visible"));
    let visibleRanges = [{ from: visibleLine.from, to: visibleLine.to }];
    let input = projectionCompileInputForTest(state, analysis);

    let full = canonicalProjectionFromSets(
      state,
      compileFullSurfaceProjection(input, analysis.semantic.cache).decorations,
      RangeSet.empty,
    );
    let visible = compileVisibleSurfaceProjection(input, analysis.semantic.cache, visibleRanges);
    let visibleProjection = canonicalProjectionFromSets(
      state,
      visible.decorations,
      visible.atomicRanges,
    );

    expect(visibleProjection).toEqual(clipCanonicalProjectionToRanges(full, visibleRanges));
  });

  it("keeps pending input surface work on the map-only trace path", async () => {
    let doc =
      "intro [docs](https://docs.example) **bold**\n\n" +
      "- [ ] stable task\n\n" +
      "```ts\nconst answer = 42;\n```\n\n" +
      "tail";
    let view = await markdownAnalysisView(doc, "tail", [
      syntaxHighlighting(testLightCodeFenceHighlightStyle),
    ]);
    view.dispatch({ effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()) });

    view.dispatch({ changes: { from: doc.indexOf("tail"), insert: "new " } });

    let pending = __testLiveMdAnalysis(view);
    expect(pending.pending).toBeTruthy();
    expect(pending.trace.blockNodesVisited).toBe(0);
    expect(pending.trace.recordsVisited).toBe(0);
    expect(pending.trace.inlineParseCalls).toBe(0);
    expect(pending.trace.codeFenceParses).toBe(0);
    expect(pending.trace.cacheFullMaterializations).toBe(0);
    expect(pending.trace.surfaceCompileCalls).toBe(0);
    expect(pending.trace.surfaceRecordsVisited).toBe(0);
    expect(pending.trace.surfaceDescriptorsMapped).toBe(0);
    expect(pending.trace.directProjectionRecords).toBe(0);
    expect(pending.trace.directProjectionWindows).toEqual([]);
    expect(pending.trace.widgetConstructions).toBe(0);
    expect(pending.trace.surfaceMapOnlyUpdates).toBe(1);
    expect(pending.trace.surfaceCompileRanges).toEqual([]);
    view.destroy();
  });

  it("keeps unrelated visible code, link, and widget surface stable during pending input", async () => {
    let doc =
      "intro [docs](https://docs.example) **bold**\n\n" +
      "- [ ] stable task\n\n" +
      "```ts\nconst answer = 42;\n```\n\n" +
      "tail";
    let view = await markdownAnalysisView(doc, "tail", [
      syntaxHighlighting(testLightCodeFenceHighlightStyle),
    ]);
    view.dispatch({ effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()) });
    let keywordClass = testLightCodeFenceHighlightStyle.style([t.keyword]);
    if (!keywordClass) throw new Error("Expected keyword highlight class");

    let before = __testLiveMdAnalysis(view);
    let taskBefore = view.contentDOM.querySelector(".cm-md-task-toggle");
    let beforeHasKeywordClass = decorationClassesFromSet(view.state, before.surfaceDecorations).has(
      keywordClass,
    );
    expect(before.trace.codeFenceParses).toBe(0);
    expect(linkHrefsFromSet(view.state, before.surfaceInteractiveDecorations)).toEqual([
      "https://docs.example",
    ]);
    expect(taskBefore).toBeTruthy();

    view.dispatch({ changes: { from: doc.indexOf("tail"), insert: "new " } });

    let pending = __testLiveMdAnalysis(view);
    let taskPending = view.contentDOM.querySelector(".cm-md-task-toggle");
    expect(pending.pending).toBeTruthy();
    expect(decorationClassesFromSet(view.state, pending.surfaceDecorations).has(keywordClass)).toBe(
      beforeHasKeywordClass,
    );
    expect(pending.trace.codeFenceParses).toBe(0);
    expect(linkHrefsFromSet(view.state, pending.surfaceInteractiveDecorations)).toEqual([
      "https://docs.example",
    ]);
    expect(taskPending).toBe(taskBefore);
    view.destroy();
  });

  it("clears dirty link interaction without opening the old destination on pending input", async () => {
    let opened: string[] = [];
    let doc = "[docs](https://old.example) tail";
    let view = await markdownAnalysisView(doc, "tail", [
      liveMdLinkInteractions(),
      liveMdLinkOpen((href) => opened.push(href)),
    ]);

    expect(
      linkHrefsFromSet(view.state, __testLiveMdAnalysis(view).surfaceInteractiveDecorations),
    ).toEqual(["https://old.example"]);

    let editFrom = doc.indexOf("old");
    view.dispatch({ changes: { from: editFrom, to: editFrom + "old".length, insert: "new" } });

    let pending = __testLiveMdAnalysis(view);
    expect(pending.pending).toBeTruthy();
    expect(linkHrefsFromSet(view.state, pending.surfaceInteractiveDecorations)).toEqual([]);
    expect(view.contentDOM.querySelector("[data-live-md-href='https://old.example']")).toBeNull();

    let dirtyLink = view.contentDOM.querySelector(".cm-md-link");
    dirtyLink?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }),
    );
    expect(opened).toEqual([]);
    view.destroy();
  });

  it("keeps ViewPlugin surface refreshes viewport-only and off full materialization", async () => {
    let doc = Array.from(
      { length: 600 },
      (_value, index) => `paragraph ${index} [link ${index}](https://example.com/${index})`,
    ).join("\n\n");
    let view = await markdownAnalysisView(doc, "paragraph 0");
    let initial = __testLiveMdAnalysis(view);
    if (!initial.semantic) throw new Error("Expected semantic cache before ViewPlugin gate");
    Object.defineProperty(initial.semantic.cache, "records", {
      configurable: true,
      get() {
        throw new Error("ViewPlugin surface refresh must not materialize all semantic records");
      },
    });
    let materializationsBefore = initial.trace.cacheFullMaterializations;

    __testRefreshLiveMdSurface(view);

    let refreshed = __testLiveMdAnalysis(view);
    expect(refreshed.pending).toBeNull();
    expect(refreshed.trace.cacheFullMaterializations).toBe(materializationsBefore);
    expect(refreshed.trace.surfaceCompileCalls).toBeGreaterThan(0);
    expect(refreshed.trace.surfaceCompileRanges.length).toBeGreaterThan(0);
    expect(
      refreshed.trace.surfaceCompileRanges.every((range) =>
        view.visibleRanges.some((visibleRange) => rangesOverlap(range, visibleRange)),
      ),
    ).toBe(true);
    view.destroy();
  });

  it("keeps legacy document-query features off the pending input surface path", async () => {
    let decoratedHeadings: string[] = [];
    let doc = "# First\n\nbody\n\n# Second\n";
    let view = await markdownAnalysisView(doc, "body", [
      liveMdMarkdownFeatures([
        {
          name: "test-pending-legacy-feature",
          query: "(atx_heading) @heading",
          decorate({ addMark, node, slice }) {
            let heading = node("heading");
            if (!heading) return;
            decoratedHeadings.push(slice(heading).trimEnd());
            addMark(heading.from, heading.to, "cm-md-feature-heading");
          },
        },
      ]),
    ]);

    decoratedHeadings = [];
    view.dispatch({ changes: { from: doc.indexOf("body"), insert: "edited " } });

    let pending = __testLiveMdAnalysis(view);
    expect(pending.pending).toBeTruthy();
    expect(pending.trace.legacyFeatureFullQueryCount).toBe(0);
    expect(pending.trace.surfaceCompileCalls).toBe(0);
    expect(decoratedHeadings).toEqual([]);

    await __testFlushLiveMdAnalysis(view);

    let committed = __testLiveMdAnalysis(view);
    expect(committed.pending).toBeNull();
    expect(committed.semanticTrace?.legacyFeatureFullQueryCount).toBe(1);
    expect(decoratedHeadings).toEqual(["# First", "# Second"]);
    view.destroy();
  });

  it("balances leaf-local inline parser and tree lifetimes including table cells", async () => {
    let service = await loadMarkdownParserService();
    let created = 0;
    let deleted = 0;
    let createdTrees = 0;
    let deletedTrees = 0;
    let parsedRanges: DocRange[][] = [];
    let inlineParser = Object.create(service.inlineParser) as typeof service.inlineParser;
    inlineParser.createParser = () => {
      created++;
      let parser = service.inlineParser.createParser();
      let deleteParser = parser.delete.bind(parser);
      parser.delete = () => {
        deleted++;
        deleteParser();
      };
      return parser;
    };
    inlineParser.parseWith = (...args: Parameters<typeof service.inlineParser.parseWith>) => {
      let ranges = args[4];
      if (ranges) parsedRanges.push(ranges.map((range) => ({ from: range.from, to: range.to })));
      return service.inlineParser.parseWith(...args);
    };
    inlineParser.wrapTree = (...args: Parameters<typeof service.inlineParser.wrapTree>) => {
      let tree = service.inlineParser.wrapTree(...args);
      if (tree?.tree) {
        createdTrees++;
        let wrappedTree = tree.tree;
        let deleteTree = wrappedTree.delete.bind(wrappedTree);
        wrappedTree.delete = () => {
          deletedTrees++;
          deleteTree();
        };
      }
      return tree;
    };
    let trackedService = { ...service, inlineParser };
    let doc =
      "one **two**\n\n" +
      "| Name | Value |\n" +
      "| --- | --- |\n" +
      "| _alpha_ | **1** |\n\n" +
      "three _four_\n\n" +
      "![Alt](image.png)\n";
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(trackedService),
        codeFenceLanguagesField,
      ],
    });
    ensureSyntaxTree(state, doc.length, 5_000);

    let analysis = __testBuildLiveMdAnalysis(state);

    expect(created).toBe(1);
    expect(deleted).toBe(created);
    expect(createdTrees).toBeGreaterThan(0);
    expect(deletedTrees).toBe(createdTrees);
    expect(analysis.trace.inlineParserSessions).toBe(1);
    expect(analysis.trace.inlineParseCalls).toBe(parsedRanges.length);
    expect(analysis.trace.inlineParsedChars).toBeGreaterThan(0);
    expect(analysis.trace.recordsVisited).toBeGreaterThan(0);
    expect(analysis.trace.recordsAnalyzed).toBe(analysis.trace.recordsVisited);
    expect(analysis.trace.tableCellsParsed).toBe(4);
    expect(parsedRanges.flat().some((range) => doc.slice(range.from, range.to) == "_alpha_")).toBe(
      true,
    );
  });

  it("keeps inline range group examination linear for many paragraphs", async () => {
    let service = await loadMarkdownParserService();
    let doc =
      Array.from({ length: 10_000 }, (_value, index) => `paragraph ${index} **bold**`).join(
        "\n\n",
      ) + "\n";
    let state = EditorState.create({ doc });
    let tree = service.blockParser.parse(state.doc);
    try {
      let analysis = analyzeMarkdownLeafSemantics({ service, state, tree });
      let trace = analysis.trace as typeof analysis.trace & {
        inlineRangeGroupsExamined: number;
      };

      expect(analysis.records).toHaveLength(10_000);
      expect(trace.recordsAnalyzed).toBe(10_000);
      expect(typeof trace.inlineRangeGroupsExamined).toBe("number");
      expect(trace.inlineRangeGroupsExamined).toBeGreaterThan(0);
      expect(trace.inlineRangeGroupsExamined).toBeLessThanOrEqual(trace.recordsAnalyzed + 2);
      expect(trace.inlineHostsWithoutRanges).toBe(0);
    } finally {
      deleteLiveMdTree(tree);
    }
  }, 60_000);

  it("keeps raw inline Markdown visible when the parser service reports no inline ranges", async () => {
    let service = await loadMarkdownParserService();
    let inlineParser = Object.create(service.inlineParser) as typeof service.inlineParser;
    inlineParser.parseWith = () => {
      throw new Error("Inline parser must not parse without service-provided ranges");
    };
    let trackedService = {
      ...service,
      inlineParser,
      inlineRanges: () => [],
    };
    let doc = "paragraph **bold** [link](https://example.com) `code`\n";
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(trackedService),
        codeFenceLanguagesField,
      ],
    });
    ensureSyntaxTree(state, doc.length, 5_000);

    let analysis = __testBuildLiveMdAnalysis(state);

    expect(analysis.trace.inlineHostsWithoutRanges).toBeGreaterThan(0);
    expect(analysis.trace.inlineParseCalls).toBe(0);
    expect(canonicalAnalysis(state, analysis)).toEqual({ atomicRanges: [], decorations: [] });
  });

  it("releases inline parser and parsed tree when inline wrapping throws", async () => {
    let service = await loadMarkdownParserService();
    let created = 0;
    let deleted = 0;
    let parsedTreeDeletes = 0;
    let inlineParser = Object.create(service.inlineParser) as typeof service.inlineParser;
    inlineParser.createParser = () => {
      created++;
      let parser = service.inlineParser.createParser();
      let deleteParser = parser.delete.bind(parser);
      parser.delete = () => {
        deleted++;
        deleteParser();
      };
      return parser;
    };
    inlineParser.parseWith = (...args: Parameters<typeof service.inlineParser.parseWith>) => {
      let parsed = service.inlineParser.parseWith(...args);
      if (parsed) {
        let deleteParsed = parsed.delete.bind(parsed);
        parsed.delete = () => {
          parsedTreeDeletes++;
          deleteParsed();
        };
      }
      return parsed;
    };
    inlineParser.wrapTree = () => {
      throw new Error("inline wrap failed");
    };
    let trackedService = { ...service, inlineParser };
    let doc = "one **two**\n";
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(trackedService),
        codeFenceLanguagesField,
      ],
    });
    ensureSyntaxTree(state, doc.length, 5_000);

    expect(() => __testBuildLiveMdAnalysis(state)).toThrow("inline wrap failed");
    expect(created).toBe(1);
    expect(deleted).toBe(1);
    expect(parsedTreeDeletes).toBe(1);
  });

  it("parses setext heading inline content without parsing the underline", async () => {
    let service = await loadMarkdownParserService();
    let parsedRanges: DocRange[][] = [];
    let inlineParser = Object.create(service.inlineParser) as typeof service.inlineParser;
    inlineParser.parseWith = (...args: Parameters<typeof service.inlineParser.parseWith>) => {
      let ranges = args[4];
      if (ranges) parsedRanges.push(ranges.map((range) => ({ from: range.from, to: range.to })));
      return service.inlineParser.parseWith(...args);
    };
    let trackedService = { ...service, inlineParser };
    let doc = "Setext **Heading**\n---\n\nnext";
    let state = EditorState.create({ doc });
    let tree = service.blockParser.parse(state.doc);
    try {
      analyzeMarkdownLeafSemantics({ service: trackedService, state, tree });
    } finally {
      deleteLiveMdTree(tree);
    }

    let underline = { from: doc.indexOf("---"), to: doc.indexOf("---") + 3 };
    expect(
      parsedRanges.flat().some((range) => doc.slice(range.from, range.to).includes("**")),
    ).toBe(true);
    expect(parsedRanges.flat().some((range) => rangesOverlap(range, underline))).toBe(false);
  });

  it("skips analysis for leaves with descendant ERROR or MISSING nodes", async () => {
    let service = await loadMarkdownParserService();
    let doc = "| a | b |\n| --- | ---\n||";
    let state = EditorState.create({ doc });
    let tree = service.blockParser.parse(state.doc);
    try {
      let tableRecord = analyzeMarkdownLeafSemantics({ service, state, tree }).records.find(
        (record) => record.kind == "table",
      );

      expect(tableRecord?.analysis.descriptors).toEqual([]);
    } finally {
      deleteLiveMdTree(tree);
    }
  });

  it("renders table previews for a larger README table", async () => {
    let doc =
      "before\n\n" +
      "## Workspace Structure\n\n" +
      "| Path              | Purpose                                                                                               |\n" +
      "| ----------------- | ----------------------------------------------------------------------------------------------------- |\n" +
      "| `package.json`    | Private Bun/Vite+ workspace, catalog versions, root scripts, and engine constraints.                  |\n" +
      "| `vite.config.ts`  | Shared Vite+ config for aliases, formatting, linting, type-aware checks, and run caching.             |\n" +
      "| `vite.shared.ts`  | Workspace import aliases used by packages and apps during local development.                          |\n" +
      "| `tsconfig*.json`  | Shared TypeScript settings for package and app builds.                                                |\n" +
      "| `packages/*`      | Workspace `@codemirror-treesitter/*` implementation and experimental packages.                        |\n" +
      "| `apps/*`          | Local browser, benchmark, comparison, Grove, relay, demo, and Cloudflare collaboration apps.          |\n" +
      "| `tools/audit.mjs` | Repository audit for package names, Lezer-free boundaries, upstream parity, coverage, and app wiring. |\n" +
      "| `bun.lock`        | Bun lockfile generated by `vp install`.                                                               |\n\n" +
      "after\n";
    let state = await markdownAnalysisState(doc, "Workspace Structure");
    let tables = tablePreviewTables(state);

    expect(tables).toHaveLength(1);
    expect(tables[0]?.header).toEqual(["Path", "Purpose"]);
    expect(tables[0]?.rows).toHaveLength(8);
    expect(tables[0]?.rows.at(-1)?.[0]).toBe("`bun.lock`");
  });

  it("keeps README-style escaped pipes inside table cells", async () => {
    let doc =
      "## Element API\n\n" +
      "| Property     | Type                 | Description                                |\n" +
      "| ------------ | -------------------- | ------------------------------------------ |\n" +
      "| `persistKey` | `string \\| null`     | `localStorage` key, read/write.            |\n" +
      "| `view`       | `EditorView \\| null` | The underlying CodeMirror `EditorView`.    |\n\n" +
      "after\n";
    let state = await markdownAnalysisState(doc, "Element API");
    let tables = tablePreviewTables(state);

    expect(tables).toHaveLength(1);
    expect(tables[0]?.rows[0]).toEqual([
      "`persistKey`",
      "`string \\| null`",
      "`localStorage` key, read/write.",
    ]);
    expect(tables[0]?.rows[1]).toEqual([
      "`view`",
      "`EditorView \\| null`",
      "The underlying CodeMirror `EditorView`.",
    ]);
  });

  it("parses code fence highlights only for explicit compiler oracles", async () => {
    let doc = "```html\n<script>let a = 1;</script>\n```\n";
    let parseCalls = 0;
    let parserCreate = 0;
    let parserDelete = 0;
    let nestedOwnerMaps = 0;
    let nestedParserCreate = 0;
    let nestedParserDelete = 0;
    let treeCreate = 0;
    let treeDelete = 0;
    let languages = new Map(await loadCodeFenceLanguages());
    let htmlParser = languages.get("html");
    if (!htmlParser) throw new Error("HTML code fence parser is unavailable");
    let trackedParser = Object.create(htmlParser) as typeof htmlParser;
    trackedParser.createParser = () => {
      parserCreate++;
      let parser = htmlParser.createParser();
      let deleteParser = parser.delete.bind(parser);
      parser.delete = () => {
        parserDelete++;
        deleteParser();
      };
      return parser;
    };
    trackedParser.parseWith = (...args: Parameters<typeof htmlParser.parseWith>) => {
      parseCalls++;
      return htmlParser.parseWith(...args);
    };
    trackedParser.wrapTree = (...args: Parameters<typeof htmlParser.wrapTree>) => {
      let nestedParsers = args[4];
      if (!nestedParsers) throw new Error("Expected code fence nested parser owner map");
      let tree = htmlParser.wrapTree(...args);
      nestedOwnerMaps++;
      nestedParserCreate += nestedParsers.size;
      for (let parser of nestedParsers.values()) {
        let deleteParser = parser.delete.bind(parser);
        parser.delete = () => {
          nestedParserDelete++;
          deleteParser();
        };
      }
      if (tree) treeCreate += trackNativeTreeDeletes(tree, () => treeDelete++);
      return tree;
    };
    languages.set("html", trackedParser);

    let view = await markdownAnalysisView(doc);
    view.dispatch({ effects: setCodeFenceLanguages.of(languages) });
    let keywordClass = testLightCodeFenceHighlightStyle.style([t.keyword]);
    if (!keywordClass) throw new Error("Expected keyword highlight class");
    let initialAnalysis = __testLiveMdAnalysis(view);
    expect(parseCalls).toBe(0);
    expect(initialAnalysis.trace.codeFenceParses).toBe(0);

    let initialTrace = emptyLiveMdLeafAnalysisTrace();
    let initialSurface = explicitCodeFenceSurface(
      view.state,
      [testLightCodeFenceHighlightStyle],
      initialTrace,
    );
    expect(parseCalls).toBe(1);
    expect(parserCreate).toBe(1);
    expect(nestedOwnerMaps).toBe(1);
    expect(nestedParserCreate).toBeGreaterThan(0);
    expect(parserDelete).toBe(1);
    expect(nestedParserDelete).toBe(nestedParserCreate);
    expect(treeCreate).toBeGreaterThan(1);
    expect(treeDelete).toBe(treeCreate);
    expect(decorationClassesFromSet(view.state, initialSurface.decorations).has(keywordClass)).toBe(
      true,
    );
    expect(initialTrace.codeFenceParserSessionsCreated).toBe(parserCreate + nestedParserCreate);
    expect(initialTrace.codeFenceParserSessionsDeleted).toBe(parserDelete + nestedParserDelete);
    expect(initialTrace.codeFenceParses).toBe(1);
    expect(initialTrace.codeFenceTreesCreated).toBe(treeCreate);
    expect(initialTrace.codeFenceTreesDeleted).toBe(treeDelete);
    expect(initialAnalysis.trace.codeFenceParserSessionsCreated).toBe(0);
    expect(initialAnalysis.trace.codeFenceParserSessionsDeleted).toBe(0);
    expect(initialAnalysis.trace.codeFenceTreesCreated).toBe(0);
    expect(initialAnalysis.trace.codeFenceTreesDeleted).toBe(0);

    parseCalls = 0;
    parserCreate = 0;
    parserDelete = 0;
    nestedOwnerMaps = 0;
    nestedParserCreate = 0;
    nestedParserDelete = 0;
    treeCreate = 0;
    treeDelete = 0;
    let editFrom = doc.indexOf("a = 1");
    view.dispatch({
      changes: { from: editFrom, to: editFrom + 1, insert: "aa" },
    });
    await __testFlushLiveMdAnalysis(view);

    let editedAnalysis = __testLiveMdAnalysis(view);
    expect(parseCalls).toBe(0);
    expect(editedAnalysis.trace.codeFenceParses).toBe(0);

    let editedTrace = emptyLiveMdLeafAnalysisTrace();
    let editedSurface = explicitCodeFenceSurface(
      view.state,
      [testLightCodeFenceHighlightStyle],
      editedTrace,
    );
    expect(parseCalls).toBe(1);
    expect(parserCreate).toBe(1);
    expect(nestedOwnerMaps).toBe(1);
    expect(nestedParserCreate).toBeGreaterThan(0);
    expect(parserDelete).toBe(1);
    expect(nestedParserDelete).toBe(nestedParserCreate);
    expect(treeCreate).toBeGreaterThan(1);
    expect(treeDelete).toBe(treeCreate);
    expect(decorationClassesFromSet(view.state, editedSurface.decorations).has(keywordClass)).toBe(
      true,
    );
    expect(editedTrace.codeFenceParserSessionsCreated).toBe(parserCreate + nestedParserCreate);
    expect(editedTrace.codeFenceParserSessionsDeleted).toBe(parserDelete + nestedParserDelete);
    expect(editedTrace.codeFenceParses).toBe(1);
    expect(editedTrace.codeFenceTreesCreated).toBe(treeCreate);
    expect(editedTrace.codeFenceTreesDeleted).toBe(treeDelete);
    view.destroy();
  });

  it("keeps highlighter reconfiguration off the runtime code fence parser path", async () => {
    let highlighterCompartment = new Compartment();
    let view = await markdownAnalysisView("```ts\nlet answer = 1;\n```\n", "", [
      highlighterCompartment.of(syntaxHighlighting(testLightCodeFenceHighlightStyle)),
    ]);
    view.dispatch({ effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()) });
    let lightKeywordClass = testLightCodeFenceHighlightStyle.style([t.keyword]);
    let darkKeywordClass = testDarkCodeFenceHighlightStyle.style([t.keyword]);

    expect(lightKeywordClass).toBeTruthy();
    expect(darkKeywordClass).toBeTruthy();
    expect(codeFenceClasses(view.state).has(lightKeywordClass!)).toBe(false);
    expect(__testLiveMdAnalysis(view).trace.codeFenceParses).toBe(0);
    expect(
      explicitCodeFenceClasses(view.state, [testLightCodeFenceHighlightStyle]).has(
        lightKeywordClass!,
      ),
    ).toBe(true);

    view.dispatch({
      effects: highlighterCompartment.reconfigure(
        syntaxHighlighting(testDarkCodeFenceHighlightStyle),
      ),
    });

    expect(__testLiveMdAnalysis(view).trace.codeFenceParses).toBe(0);
    expect(codeFenceClasses(view.state).has(darkKeywordClass!)).toBe(false);
    expect(codeFenceClasses(view.state).has(lightKeywordClass!)).toBe(false);
    expect(
      explicitCodeFenceClasses(view.state, [testDarkCodeFenceHighlightStyle]).has(
        darkKeywordClass!,
      ),
    ).toBe(true);
    view.destroy();
  });

  it("keeps explicit code fence highlighter overrides off the runtime parser path", async () => {
    let view = await markdownAnalysisView("```ts\nlet answer = 1;\n```\n", "", [
      syntaxHighlighting(testLightCodeFenceHighlightStyle),
      liveMdCodeFenceHighlighting(testDarkCodeFenceHighlightStyle),
    ]);
    view.dispatch({ effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()) });
    let lightKeywordClass = testLightCodeFenceHighlightStyle.style([t.keyword]);
    let darkKeywordClass = testDarkCodeFenceHighlightStyle.style([t.keyword]);

    expect(darkKeywordClass).toBeTruthy();
    expect(codeFenceClasses(view.state).has(darkKeywordClass!)).toBe(false);
    expect(codeFenceClasses(view.state).has(lightKeywordClass!)).toBe(false);
    expect(__testLiveMdAnalysis(view).trace.codeFenceParses).toBe(0);
    expect(
      explicitCodeFenceClasses(view.state, [testDarkCodeFenceHighlightStyle]).has(
        darkKeywordClass!,
      ),
    ).toBe(true);
    view.destroy();
  });

  it("decorates inline markdown at EOF", async () => {
    let doc = "cursor here\n\nuse *emphasize* here";
    let state = await markdownAnalysisState(doc);
    let decorations = canonicalAnalysis(state).decorations;
    let emphasisFrom = doc.indexOf("*emphasize*");
    let emphasisTo = emphasisFrom + "*emphasize*".length;

    expect(
      decorations.some(
        (decoration) =>
          decoration.from == emphasisFrom &&
          decoration.to == emphasisTo &&
          (decoration.spec as { class?: string }).class == "cm-md-emphasis",
      ),
    ).toBe(true);
  });

  it("renders table previews at EOF without a trailing newline", async () => {
    let doc = "before\n\n| Name | Value |\n| --- | ---: |\n| alpha | 1 |";
    let view = await markdownAnalysisView(doc, "before");
    let table = view.contentDOM.querySelector(".cm-md-table-preview table");

    expect(table?.textContent).toContain("Name");
    expect(table?.textContent).toContain("alpha");
    view.destroy();
  });

  it("keeps table source editable on the trailing blank line", async () => {
    let doc = "| Name | Value |\n| --- | ---: |\n";
    let view = await markdownAnalysisView(doc);

    expect(view.contentDOM.querySelector(".cm-md-table-preview")).toBeNull();
    expect(view.contentDOM.textContent).toContain("| Name | Value |");
    view.destroy();
  });

  it("renders task list decorations at EOF without a trailing newline", async () => {
    let doc = "- [x] done\n- [ ] todo";
    let view = await markdownAnalysisView(doc, "done");

    expect(view.contentDOM.querySelectorAll(".cm-md-list-line")).toHaveLength(2);
    expect(view.contentDOM.querySelectorAll(".cm-md-task-line")).toHaveLength(2);
    expect(view.contentDOM.querySelectorAll(".cm-md-task-toggle")).toHaveLength(1);
    view.destroy();
  });

  it("renders task list decorations before trailing EOF blank lines", async () => {
    let doc = "- [x] done\n- [ ] todo\n\n\n";
    let state = (await markdownAnalysisState(doc)).update({
      selection: { anchor: doc.length },
    }).state;
    let decorations = canonicalAnalysis(state).decorations;

    expect(
      decorations.filter(
        (decoration) =>
          (decoration.spec as { widget?: { name?: string } }).widget?.name == "TaskCheckboxWidget",
      ),
    ).toHaveLength(2);
  });

  it("renders table previews before trailing EOF blank lines", async () => {
    let doc = "| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n\n\n";
    let state = (await markdownAnalysisState(doc)).update({
      selection: { anchor: doc.length },
    }).state;
    let decorations = canonicalAnalysis(state).decorations;

    expect(
      decorations.some(
        (decoration) =>
          (decoration.spec as { widget?: { name?: string } }).widget?.name == "TablePreviewWidget",
      ),
    ).toBe(true);
  });

  it("normalizes Markdown image destinations for preview widgets", async () => {
    expect(normalizeMarkdownImageSource("</asset/icon.svg>")).toBe("/asset/icon.svg");
    expect(normalizeMarkdownImageSource("/images/photo\\(copy\\).png")).toBe(
      "/images/photo(copy).png",
    );

    let doc =
      "![Angle](</asset/icon.svg>)\n\n" + "![Escaped](/images/photo\\(copy\\).png)\n\n" + "after";
    let state = await markdownAnalysisState(doc, "after");

    expect(imagePreviewSources(state)).toEqual(["/asset/icon.svg", "/images/photo(copy).png"]);
  });

  it("rebuilds image previews when the image source resolver changes", async () => {
    let imageSourceCompartment = new Compartment();
    let view = await markdownAnalysisView("![Local](assets/local.png)\n\nafter", "after", [
      imageSourceCompartment.of(liveMdImageSource((source) => `blob:first/${source}`)),
    ]);

    expect(imagePreviewSources(view.state)).toEqual(["blob:first/assets/local.png"]);

    view.dispatch({
      effects: imageSourceCompartment.reconfigure(
        liveMdImageSource((source) => `blob:second/${source}`),
      ),
    });

    expect(imagePreviewSources(view.state)).toEqual(["blob:second/assets/local.png"]);
    view.destroy();
  });

  it("does not reuse stale direct image previews when resolver changes before scheduled commit", async () => {
    let imageSourceCompartment = new Compartment();
    let doc = "![Local](assets/local.png)\n\nafter";
    let view = await markdownAnalysisView(doc, "after", [
      imageSourceCompartment.of(liveMdImageSource((source) => `blob:first/${source}`)),
    ]);
    let before = __testLiveMdAnalysis(view);
    expect(imagePreviewSourcesFromSet(view.state, before.directDecorations)).toEqual([
      "blob:first/assets/local.png",
    ]);

    let editFrom = doc.indexOf("after") + "after".length;
    view.dispatch({
      changes: { from: editFrom, insert: "!" },
      selection: { anchor: editFrom + 1 },
    });
    let pending = __testLiveMdAnalysis(view);
    expect(pending.pending).toBeTruthy();
    expect(pending.trace.directProjectionRecords).toBe(0);

    view.dispatch({
      effects: imageSourceCompartment.reconfigure(
        liveMdImageSource((source) => `blob:second/${source}`),
      ),
    });
    await __testFlushLiveMdAnalysis(view);

    let after = __testLiveMdAnalysis(view);
    expect(imagePreviewSourcesFromSet(view.state, after.directDecorations)).toEqual([
      "blob:second/assets/local.png",
    ]);
    expect(after.semanticTrace?.directProjectionWindows).toEqual([
      { from: 0, to: view.state.doc.length },
    ]);
    expectDirectProjectionMatchesFullOracle(view.state, after);
    view.destroy();
  });

  it("allows markdown features to add query-driven decorations", async () => {
    let state = await markdownAnalysisState("# First\n\n# Second\n", "", [
      liveMdMarkdownFeatures([
        {
          name: "test-heading",
          query: "(atx_heading) @heading",
          decorate({ addLineClass, addMark, node }) {
            let heading = node("heading");
            if (!heading) return;
            addLineClass(heading.from, heading.to, "cm-md-feature-heading-line");
            addMark(heading.from, heading.to, "cm-md-feature-heading");
          },
        },
      ]),
    ]);

    expect(decorationClasses(state).has("cm-md-feature-heading")).toBe(true);
    expect(decorationClasses(state).has("cm-md-feature-heading-line")).toBe(true);
  });

  it("counts legacy feature full-query projection after document changes", async () => {
    let decoratedHeadings: string[] = [];
    let doc = "# First\n\nbody\n\n# Second\n";
    let view = await markdownAnalysisView(doc, "body", [
      liveMdMarkdownFeatures([
        {
          name: "test-heading-feature",
          query: "(atx_heading) @heading",
          decorate({ addMark, node, slice }) {
            let heading = node("heading");
            if (!heading) return;
            decoratedHeadings.push(slice(heading).trimEnd());
            addMark(heading.from, heading.to, "cm-md-feature-heading");
          },
        },
      ]),
    ]);

    decoratedHeadings = [];
    let replaceFrom = doc.indexOf("# Second");
    let transaction = view.state.update({
      changes: {
        from: replaceFrom,
        insert: "# Updated\n\n# Third\n",
        to: doc.length,
      },
    });
    ensureSyntaxTree(transaction.state, transaction.state.doc.length, 5_000);
    view.dispatch(transaction);
    await __testFlushLiveMdAnalysis(view);

    let after = __testLiveMdAnalysis(view);
    expect(legacyFeatureFullQueryCount(after)).toBe(1);
    expect(decoratedHeadings).toEqual(["# First", "# Updated", "# Third"]);
    expect(decorationClasses(view.state).has("cm-md-feature-heading")).toBe(true);
    view.destroy();
  });

  it("rebuilds markdown feature decorations when features change", async () => {
    let featureCompartment = new Compartment();
    let view = await markdownAnalysisView("# Dynamic\n\nbody", "body", [
      featureCompartment.of(markHeadingFeature("cm-md-feature-first")),
    ]);

    expect(decorationClasses(view.state).has("cm-md-feature-first")).toBe(true);
    expect(decorationClasses(view.state).has("cm-md-feature-second")).toBe(false);

    view.dispatch({
      effects: featureCompartment.reconfigure(markHeadingFeature("cm-md-feature-second")),
    });

    expect(decorationClasses(view.state).has("cm-md-feature-first")).toBe(false);
    expect(decorationClasses(view.state).has("cm-md-feature-second")).toBe(true);
    view.destroy();
  });
});

async function markdownAnalysisState(doc: string, selectionText = "", extensions: Extension = []) {
  let selection = selectionText ? doc.indexOf(selectionText) : 0;
  let state = EditorState.create({
    doc,
    extensions: [
      await loadMarkdownExtension(),
      codeFenceLanguagesField,
      extensions,
      liveMdAnalysis,
    ],
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state.update({ selection: { anchor: selection } }).state;
}

async function markdownAnalysisView(doc: string, selectionText = "", extensions: Extension = []) {
  let selection = selectionText ? doc.indexOf(selectionText) : 0;
  let view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc,
      selection: { anchor: selection },
      extensions: [
        await loadMarkdownExtension(),
        codeFenceLanguagesField,
        extensions,
        liveMdAnalysis,
      ],
    }),
  });
  ensureSyntaxTree(view.state, doc.length, 5_000);
  view.dispatch({});
  return view;
}

type TestLiveMdAnalysis = ReturnType<typeof __testLiveMdAnalysis>;
type TestLeafAnalysisCache = NonNullable<TestLiveMdAnalysis["semantic"]>["cache"];
type ScheduledLocalOracleMode = "full" | "semantic" | false;

async function dispatchScheduledLocalEdit(
  view: EditorView,
  spec: TransactionSpec,
  label: string,
  options: { oracle?: ScheduledLocalOracleMode } = {},
) {
  let before = __testLiveMdAnalysis(view);
  if (!before.semantic) throw new Error(`${label}: expected semantic cache before edit`);
  let transaction = view.state.update(spec);

  view.dispatch(transaction);
  let pending = __testLiveMdAnalysis(view);
  expect(pending.pending, `${label}: source-first pending state`).toBeTruthy();

  await __testFlushLiveMdAnalysis(view);

  let after = __testLiveMdAnalysis(view);
  expect(after.pending, `${label}: scheduled analysis committed`).toBeNull();
  if (options.oracle !== false) {
    expectLocalFullFreshSemanticEquivalence(
      after,
      before.semantic.cache,
      transaction,
      view.state,
      label,
      options.oracle ?? "full",
    );
  }
  return { after, before, pending, transaction };
}

function expectLocalFullFreshSemanticEquivalence(
  local: TestLiveMdAnalysis,
  oldCache: TestLeafAnalysisCache,
  transaction: Transaction,
  state: EditorState,
  label: string,
  mode: Exclude<ScheduledLocalOracleMode, false>,
) {
  if (!local.semantic) throw new Error(`${label}: expected local semantic cache after edit`);
  let { freshCache, fullCache } = semanticTransitionOracles(
    transaction.startState,
    state,
    transaction.changes,
    oldCache,
  );

  let localTransitionCache = canonicalSemanticTransitionCache(state, local.semantic.cache);
  let fullTransitionCache = canonicalSemanticTransitionCache(state, fullCache);
  expect(
    firstCanonicalMismatch(localTransitionCache, fullTransitionCache),
    `${label}: local transition must match full-walk transition with cache ids`,
  ).toBeNull();
  expect(
    canonicalSemanticRecordsFromCache(state, local.semantic.cache),
    `${label}: local transition must match fresh rebuild semantics`,
  ).toEqual(canonicalSemanticRecordsFromCache(state, freshCache));
  let fullSourceIslandLeaves = sourceIslandLeavesFromLeafAnalysisRecords(
    state.doc,
    materializeLeafAnalysisCacheRecords(fullCache),
  );
  expect(
    canonicalSourceIslandLeaves(local.sourceIslandLeaves),
    `${label}: local source islands vs full-walk transition`,
  ).toEqual(canonicalSourceIslandLeaves(fullSourceIslandLeaves));
  expect(local.activeSourceRanges, `${label}: local active lookup vs full-walk transition`).toEqual(
    activeMarkdownSourceRanges(state, fullSourceIslandLeaves),
  );
  if (mode == "semantic") return;

  let freshAnalysis = __testBuildLiveMdAnalysis(state);
  expect(canonicalAnalysis(state, local), `${label}: local projection vs fresh`).toEqual(
    canonicalAnalysis(state, freshAnalysis),
  );
  expect(
    canonicalAnalysis(state, local),
    `${label}: local projection vs canonical full-query projection`,
  ).toEqual(canonicalAnalysis(state, __testBuildCanonicalLiveMdAnalysis(state)));
}

function semanticTransitionOracles(
  startState: EditorState,
  state: EditorState,
  changes: ChangeDesc,
  oldCache: TestLeafAnalysisCache,
) {
  let service = markdownParserService(state);
  let tree = service.blockParser.parse(state.doc);
  try {
    let walked = walkMarkdownBlocks(tree, state.doc);
    let analysisInput = { service, state, tree };
    let fullTransition = transitionLeafAnalysisCache({
      analysisInput,
      changes,
      oldCache,
      oldDoc: startState.doc,
      snapshot: walked.snapshot,
    });
    let freshTransition = buildFreshLeafAnalysisCache({
      analysisInput,
      snapshot: walked.snapshot,
    });
    return {
      freshCache: freshTransition.cache,
      fullCache: fullTransition.cache,
    };
  } finally {
    deleteLiveMdTree(tree);
  }
}

function markdownParserService(state: EditorState) {
  let service = state.facet(liveMdMarkdownParserServiceFacet);
  if (!service) throw new Error("Expected LiveMD Markdown parser service");
  return service;
}

async function createLocalCacheHarness(doc: string, extensions: Extension = []) {
  let service = await loadMarkdownParserService();
  let state = EditorState.create({ doc, extensions });
  let tree = service.blockParser.parse(state.doc);
  let snapshot = walkMarkdownBlocks(tree, state.doc).snapshot;
  let current = buildFreshLeafAnalysisCache({
    analysisInput: { service, state, tree },
    snapshot,
  });
  let sourceIslandLeaves: readonly LiveMdSourceIslandLeaf[] =
    sourceIslandLeavesFromLeafAnalysisRecords(
      state.doc,
      materializeLeafAnalysisCacheRecords(current.cache),
    );

  let harness = {
    current,
    service,
    sourceIslandLeaves,
    state,
    tree,
    apply(transaction: Transaction) {
      let previousTree = harness.tree;
      let editedTree = service.blockParser.editWrappedTree(
        previousTree,
        transaction.changes,
        harness.state.doc,
        transaction.state.doc,
      );
      let nextTree = service.blockParser.parse(transaction.state.doc, editedTree);
      let local = transitionLeafAnalysisCacheLocal({
        analysisInput: { service, state: transaction.state, tree: nextTree },
        changes: transaction.changes,
        oldCache: harness.current.cache,
        oldDoc: harness.state.doc,
        oldSourceIslandLeaves: harness.sourceIslandLeaves,
      });
      if (local.fallback) throw new Error("Expected range-local cache transition");
      if (!local.sourceIslandLeaves) {
        throw new Error("Expected range-local source island transition");
      }

      harness.current = local;
      harness.state = transaction.state;
      harness.tree = nextTree;
      harness.sourceIslandLeaves = local.sourceIslandLeaves;
      deleteLiveMdTree(previousTree);
      deleteLiveMdTree(editedTree);
      return local;
    },
    destroy() {
      deleteLiveMdTree(harness.tree);
    },
  };
  return harness;
}

function commandTransaction(state: EditorState, command: StateCommand, label: string) {
  let transaction: Transaction | null = null;
  let dispatched = command({
    state,
    dispatch: (next) => {
      transaction = next;
    },
  });
  expect(dispatched, label).toBe(true);
  if (!transaction) throw new Error(`${label}: command did not dispatch`);
  return transaction;
}

function expectPr75LocalTrace(
  trace: LiveMdLeafAnalysisTrace | null | undefined,
  label: string,
  options: {
    cacheIndexCallbacksLessThan?: number;
    cacheIndexQueriesLessThan?: number;
    recordsAnalyzed?: number;
    recordsCollectedLessThan?: number;
    recordsMappedLessThan?: number;
    recordsReusedGreaterThan?: number;
    recordsVisitedLessThan?: number;
  } = {},
) {
  if (!trace) throw new Error(`${label}: expected semantic trace`);
  expect(trace.recordsAnalyzed, label).toBe(options.recordsAnalyzed ?? 1);
  expect(trace.fallbackCount, label).toBe(0);
  expect(trace.recordsVisited, label).toBeLessThan(options.recordsVisitedLessThan ?? 8);
  expect(trace.recordsCollected, label).toBeLessThan(options.recordsCollectedLessThan ?? 10);
  expect(trace.recordsMappedIndividually, label).toBeLessThan(options.recordsMappedLessThan ?? 10);
  expect(trace.cacheFullMaterializations, label).toBe(0);
  expect(trace.cacheIndexCallbacks, label).toBeLessThan(options.cacheIndexCallbacksLessThan ?? 10);
  expect(trace.cacheIndexQueries, label).toBeLessThan(options.cacheIndexQueriesLessThan ?? 10);
  if (options.recordsReusedGreaterThan != null) {
    expect(trace.recordsReused, label).toBeGreaterThan(options.recordsReusedGreaterThan);
  }
}

function projectionCompileInputForTest(
  state: EditorState,
  analysis: ReturnType<typeof __testBuildLiveMdAnalysis>,
  options: {
    codeFenceHighlighters?: readonly Highlighter[];
    trace?: ReturnType<typeof emptyLiveMdLeafAnalysisTrace>;
  } = {},
) {
  return {
    activeLines: new Set(analysis.activeLines),
    activeSourceRanges: analysis.activeSourceRanges,
    codeFenceHighlighters:
      options.codeFenceHighlighters ?? state.facet(codeFenceHighlighterFacet) ?? [],
    codeFenceLanguages: state.field(codeFenceLanguagesField, false) ?? new Map(),
    imageSourceResolver: state.facet(liveMdImageSourceResolver),
    linkBaseUrl: state.facet(liveMdLinkBaseUrl),
    markdownFeatures: state.facet(liveMdMarkdownFeatureFacet),
    sourceIslandMode: true,
    state,
    trace: options.trace ?? emptyLiveMdLeafAnalysisTrace(),
  };
}

function expectDirectProjectionMatchesFullOracle(
  state: EditorState,
  analysis: ReturnType<typeof __testLiveMdAnalysis>,
) {
  if (!analysis.semantic) throw new Error("Expected semantic cache for direct projection oracle");
  let direct = compileFullDirectLayoutProjection(
    projectionCompileInputForTest(state, analysis),
    analysis.semantic.cache,
  );
  expect(
    canonicalProjectionFromSets(state, analysis.directDecorations, analysis.directAtomicRanges),
  ).toEqual(canonicalProjectionFromSets(state, direct.decorations, direct.atomicRanges));
  expect(canonicalDecorationsFromSet(state, analysis.directSourceSafeDecorations)).toEqual(
    canonicalDecorationsFromSet(state, direct.sourceSafeDecorations),
  );
  expect(canonicalDecorationsFromSet(state, analysis.directDestructiveDecorations)).toEqual(
    canonicalDecorationsFromSet(state, direct.destructiveDecorations),
  );
}

function explicitCodeFenceSurface(
  state: EditorState,
  highlighters: readonly Highlighter[],
  trace = emptyLiveMdLeafAnalysisTrace(),
) {
  let analysis = __testBuildLiveMdAnalysis(state);
  if (!analysis.semantic) throw new Error("Expected semantic cache for code fence oracle");
  return compileVisibleSurfaceProjection(
    projectionCompileInputForTest(state, analysis, {
      codeFenceHighlighters: highlighters,
      trace,
    }),
    analysis.semantic.cache,
    state.doc.length ? [{ from: 0, to: state.doc.length }] : [],
    { codeFenceHighlights: true },
  );
}

function explicitCodeFenceClasses(state: EditorState, highlighters: readonly Highlighter[]) {
  return decorationClassesFromSet(state, explicitCodeFenceSurface(state, highlighters).decorations);
}

function imagePreviewSources(state: EditorState) {
  return imagePreviewSourcesFromSet(state, __testBuildLiveMdAnalysis(state).decorations);
}

function imagePreviewSourcesFromSet(state: EditorState, decorations: DecorationSet) {
  let sources: string[] = [];
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    let widget = (value.spec as { widget?: unknown }).widget;
    if (widget && widget.constructor.name == "ImagePreviewWidget") {
      sources.push((widget as { src: string }).src);
    }
  });
  return sources;
}

type TestMarkdownTable = {
  alignments: string[];
  header: string[];
  rows: string[][];
};

function tablePreviewTables(
  state: EditorState,
  analysis = __testBuildLiveMdAnalysis(state),
): TestMarkdownTable[] {
  let tables: TestMarkdownTable[] = [];
  analysis.decorations.between(0, state.doc.length, (_from, _to, value) => {
    let widget = (value.spec as { widget?: unknown }).widget;
    if (widget && widget.constructor.name == "TablePreviewWidget") {
      tables.push((widget as { table: TestMarkdownTable }).table);
    }
  });
  return tables;
}

function codeFenceClasses(state: EditorState) {
  let classes = new Set<string>();
  __testLiveMdAnalysis({ state } as EditorView).decorations.between(
    0,
    state.doc.length,
    (_from, _to, value) => {
      let className = (value.spec as { class?: string }).class;
      if (className) classes.add(className);
    },
  );
  return classes;
}

function trackNativeTreeDeletes(tree: Tree, onDelete: () => void): number {
  let count = 0;
  if (tree.tree) {
    count++;
    let wrappedTree = tree.tree;
    let deleteTree = wrappedTree.delete.bind(wrappedTree);
    wrappedTree.delete = () => {
      onDelete();
      deleteTree();
    };
  }
  for (let nested of tree.nested) {
    count += trackNativeTreeDeletes(nested.tree, onDelete);
  }
  return count;
}

function recordBySource(
  state: EditorState,
  analysis: ReturnType<typeof __testLiveMdAnalysis>,
  source: string,
) {
  let record = analysis.semantic
    ? materializeLeafAnalysisCacheRecords(analysis.semantic.cache).find(
        (candidate) =>
          state.sliceDoc(candidate.sourceRange.from, candidate.sourceRange.to) == source,
      )
    : undefined;
  if (!record) throw new Error(`Missing semantic record for source: ${source}`);
  return record;
}

function markerRecordBySource(
  state: EditorState,
  analysis: ReturnType<typeof __testLiveMdAnalysis>,
  source: string,
  markerKind: "listMarker" | "taskMarker",
) {
  let record = analysis.semantic
    ? materializeLeafAnalysisCacheRecords(analysis.semantic.cache).find(
        (candidate) =>
          candidate.kind == "marker" &&
          state.sliceDoc(candidate.sourceRange.from, candidate.sourceRange.to) == source &&
          candidate.analysis.structuralEffects.some((descriptor) => descriptor.kind == markerKind),
      )
    : undefined;
  if (!record) throw new Error(`Missing ${markerKind} semantic record for source: ${source}`);
  return record;
}

function taskMarkerChecked(record: ReturnType<typeof recordBySource>) {
  let taskMarker = record.analysis.structuralEffects.find(
    (descriptor) => descriptor.kind == "taskMarker",
  );
  if (!taskMarker || taskMarker.kind != "taskMarker") {
    throw new Error("Missing task marker descriptor");
  }
  return taskMarker.checked;
}

function expectRelativeLineClassRange(
  record: ReturnType<typeof recordBySource>,
  className: string,
  range: DocRange,
) {
  let lineClass = record.analysis.structuralEffects.find(
    (descriptor) => descriptor.kind == "lineClass" && descriptor.className == className,
  );
  if (!lineClass || lineClass.kind != "lineClass") {
    throw new Error(`Missing ${className} line class descriptor`);
  }
  expect(lineClass.range).toEqual(range);
}

function legacyFeatureFullQueryCount(analysis: ReturnType<typeof __testLiveMdAnalysis>) {
  return analysis.semanticTrace?.legacyFeatureFullQueryCount;
}

function decorationClasses(
  state: EditorState,
  analysis = __testLiveMdAnalysis({ state } as EditorView),
) {
  return decorationClassesFromSet(state, analysis.decorations);
}

function decorationClassesFromSet(state: EditorState, decorations: DecorationSet) {
  let classes = new Set<string>();
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    let className = (value.spec as { class?: string }).class;
    for (let name of className?.split(/\s+/) ?? []) {
      if (name) classes.add(name);
    }
  });
  return classes;
}

function linkHrefsFromSet(state: EditorState, decorations: DecorationSet) {
  let hrefs: string[] = [];
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    let href = (value.spec as { attributes?: { "data-live-md-href"?: string } }).attributes?.[
      "data-live-md-href"
    ];
    if (href) hrefs.push(href);
  });
  return hrefs.sort();
}

function widgetNamesFromSet(state: EditorState, decorations: DecorationSet) {
  let names: string[] = [];
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    let widget = (value.spec as { widget?: unknown }).widget;
    if (widget && typeof widget == "object") names.push(widget.constructor.name);
  });
  return names;
}

function widgetInstancesFromSet(state: EditorState, decorations: DecorationSet, name: string) {
  let widgets: unknown[] = [];
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    let widget = (value.spec as { widget?: unknown }).widget;
    if (widget && typeof widget == "object" && widget.constructor.name == name) {
      widgets.push(widget);
    }
  });
  return widgets;
}

function requiredElement(view: EditorView, selector: string) {
  let element = view.dom.querySelector(selector);
  if (!element) throw new Error(`Missing element for selector ${selector}`);
  return element;
}

function expectNoElement(view: EditorView, selector: string) {
  expect(view.dom.querySelector(selector)).toBeNull();
}

function expectSelectionHead(view: EditorView, position: number, label: string) {
  expect(view.state.selection.main.head, label).toBe(position);
}

function lineRangeBySource(state: EditorState, lineText: string): DocRange {
  let line = lineBySource(state, lineText);
  return { from: line.from, to: line.to };
}

function expectDirectPatchLocal(
  trace: LiveMdLeafAnalysisTrace | null | undefined,
  state: EditorState,
  allowedRanges: readonly DocRange[],
) {
  expect(trace?.directProjectionWindows).toBeTruthy();
  let windows = trace?.directProjectionWindows ?? [];
  expect(windows).not.toEqual([{ from: 0, to: state.doc.length }]);
  for (let window of windows) {
    expect(allowedRanges.some((range) => containsDocRange(range, window))).toBe(true);
  }
  let coveredWidth = windows.reduce((sum, window) => sum + (window.to - window.from), 0);
  expect(coveredWidth).toBeLessThan(state.doc.length);
}

function lineBySource(state: EditorState, lineText: string) {
  let from = state.sliceDoc().indexOf(lineText);
  if (from < 0) throw new Error(`Missing test line text: ${lineText}`);
  return state.doc.lineAt(from);
}

function lineHasClass(
  state: EditorState,
  lineText: string,
  className: string,
  analysis = __testLiveMdAnalysis({ state } as EditorView),
) {
  let from = state.sliceDoc().indexOf(lineText);
  if (from < 0) throw new Error(`Missing test line text: ${lineText}`);
  let line = state.doc.lineAt(from);
  return lineClasses(state, analysis).get(line.from)?.has(className) ?? false;
}

function lineClasses(state: EditorState, analysis = __testLiveMdAnalysis({ state } as EditorView)) {
  let classes = new Map<number, Set<string>>();
  analysis.decorations.between(0, state.doc.length, (from, to, value) => {
    if (from != to) return;
    let className = (value.spec as { class?: string }).class;
    if (!className) return;
    let lineFrom = state.doc.lineAt(from).from;
    let lineClasses = classes.get(lineFrom);
    if (!lineClasses) classes.set(lineFrom, (lineClasses = new Set()));
    for (let name of className.split(/\s+/)) {
      if (name) lineClasses.add(name);
    }
  });
  return classes;
}

function markHeadingFeature(className: string) {
  return liveMdMarkdownFeatures([
    {
      name: className,
      query: "(atx_heading) @heading",
      decorate({ addMark, node }) {
        let heading = node("heading");
        if (!heading) return;
        addMark(heading.from, heading.to, className);
      },
    },
  ]);
}

function numberedParagraphDoc(count: number) {
  return Array.from({ length: count }, (_value, index) => `paragraph ${index} **bold**`).join(
    "\n\n",
  );
}

function numberedPlainParagraphDoc(count: number) {
  return Array.from({ length: count }, (_value, index) => `paragraph ${index}`).join("\n\n");
}

function onlyRecordTouching(cache: TestLeafAnalysisCache, range: DocRange, label: string) {
  let records = findLeafAnalysisRecordsTouchingRanges(cache, [range]);
  let exact = records.filter(
    (record) => record.sourceRange.from == range.from && record.sourceRange.to == range.to,
  );
  expect(exact, label).toHaveLength(1);
  return exact[0]!;
}

function mapRangeForTest(range: DocRange, changes: ChangeDesc): DocRange {
  let from = changes.mapPos(range.from, 1);
  let to = changes.mapPos(range.to, -1);
  return from <= to ? { from, to } : { from: to, to: from };
}

function numberedListDoc(count: number) {
  return Array.from({ length: count }, (_value, index) => `- item ${index} body **bold**`).join(
    "\n",
  );
}

function numberedQuoteParagraphDoc(count: number) {
  return Array.from({ length: count }, (_value, index) => `> quote ${index} body **bold**`).join(
    "\n>\n",
  );
}

function randomEditSeedDoc() {
  return (
    "# Random Seed\n\n" +
    "alpha **one** and [link](https://example.com)\n\n" +
    "- [ ] todo item\n" +
    "- item two\n\n" +
    "> quote **bold**\n>\n> next quote\n\n" +
    "| Name | Value |\n" +
    "| --- | --- |\n" +
    "| alpha | 1 |\n\n" +
    "```ts\n" +
    "let answer = 1;\n" +
    "```\n\n" +
    "tail\n"
  );
}

function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function randomTextEdit(doc: string, random: () => number): TransactionSpec["changes"] {
  let operation = Math.floor(random() * 3);
  let insertions = ["!", " more", "\nnew line", " 中", " `code`", " **x**"];
  if (operation == 0 || doc.length == 0) {
    let from = randomPosition(doc, random);
    return { from, insert: insertions[Math.floor(random() * insertions.length)]! };
  }

  let from = Math.floor(random() * doc.length);
  let maxDelete = Math.min(8, doc.length - from);
  let to = from + 1 + Math.floor(random() * maxDelete);
  if (operation == 1) return { from, to };
  return {
    from,
    insert: insertions[Math.floor(random() * insertions.length)]!,
    to,
  };
}

function randomPosition(doc: string, random: () => number) {
  return Math.floor(random() * (doc.length + 1));
}

function liveMdKitchenSinkDoc() {
  return (
    "# Heading One\n\n" +
    "Paragraph with _emphasis_, **bold**, ~~strike~~, `code`, [link](https://example.com), <https://example.com>, $x^2$.\n\n" +
    "> Quote line with **bold** and $y$.\n" +
    "> second quote line\n\n" +
    "- item one\n" +
    "- [x] done item\n" +
    "- [ ] todo item\n\n" +
    "![Alt image](https://example.com/image.png)\n\n" +
    "$$\n" +
    "E = mc^2\n" +
    "$$\n\n" +
    "| Name | Value |\n" +
    "| --- | ---: |\n" +
    "| alpha | 1 |\n" +
    "| beta | 2 |\n\n" +
    "```ts\n" +
    "type Note = { title: string; done: boolean };\n" +
    "const answer = 42;\n" +
    "console.log(answer);\n" +
    "```\n\n" +
    "After anchor line\n"
  );
}

function canonicalAnalysis(state: EditorState, analysis = __testBuildLiveMdAnalysis(state)) {
  return canonicalProjectionFromSets(state, analysis.decorations, analysis.atomicRanges);
}

function canonicalProjectionFromSets(
  state: EditorState,
  decorationsSet: DecorationSet,
  atomicRangesSet: ReturnType<typeof __testBuildLiveMdAnalysis>["atomicRanges"],
) {
  let decorations: Array<{ from: number; spec: unknown; to: number }> = [];
  decorationsSet.between(0, state.doc.length, (from, to, value) => {
    decorations.push({ from, spec: canonicalDecorationSpec(value.spec), to });
  });
  decorations.sort(compareCanonicalRange);
  decorations = mergeCanonicalLineClassDecorations(decorations);

  let atomicRanges: Array<{ from: number; to: number; value: string }> = [];
  atomicRangesSet.between(0, state.doc.length, (from, to, value) => {
    atomicRanges.push({ from, to, value: value.constructor.name });
  });
  atomicRanges.sort(compareCanonicalRange);

  return { atomicRanges, decorations };
}

function canonicalDecorationsFromSet(state: EditorState, decorationsSet: DecorationSet) {
  return canonicalProjectionFromSets(state, decorationsSet, RangeSet.empty).decorations;
}

function mergeCanonicalLineClassDecorations(
  decorations: Array<{ from: number; spec: unknown; to: number }>,
) {
  let merged: Array<{ from: number; spec: unknown; to: number }> = [];
  for (let decoration of decorations) {
    let previous = merged[merged.length - 1];
    let previousClass = canonicalLineClass(previous);
    let currentClass = canonicalLineClass(decoration);
    if (
      previous &&
      previous.from == decoration.from &&
      previous.to == decoration.to &&
      previousClass &&
      currentClass
    ) {
      previous.spec = {
        class: [...new Set([...previousClass.split(" "), ...currentClass.split(" ")])]
          .filter(Boolean)
          .sort()
          .join(" "),
      };
      continue;
    }
    merged.push(decoration);
  }
  return merged;
}

function canonicalLineClass(decoration: { from: number; spec: unknown; to: number } | undefined) {
  if (!decoration || decoration.from != decoration.to) return null;
  let spec = decoration.spec as { class?: unknown };
  if (!spec || typeof spec.class != "string" || Object.keys(spec).length != 1) return null;
  return spec.class;
}

function canonicalSemanticCache(
  state: EditorState,
  analysis: ReturnType<typeof __testLiveMdAnalysis>,
): CanonicalSemanticRecord[] {
  return analysis.semantic ? canonicalSemanticRecordsFromCache(state, analysis.semantic.cache) : [];
}

function canonicalSemanticRecordsFromCache(
  state: EditorState,
  cache: TestLeafAnalysisCache,
): CanonicalSemanticRecord[] {
  let records = materializeLeafAnalysisCacheRecords(cache).map((record) =>
    canonicalSemanticRecord(state, record),
  );
  return records.sort(compareCanonicalSemanticRecord);
}

function canonicalSemanticTransitionCache(
  state: EditorState,
  cache: TestLeafAnalysisCache,
): CanonicalSemanticTransitionRecord[] {
  let records = materializeLeafAnalysisCacheRecords(cache).map((record) => ({
    ...canonicalSemanticRecord(state, record),
    cacheId: record.cacheId,
  }));
  return records.sort(compareCanonicalSemanticTransitionRecord);
}

function canonicalSourceIslandLeaves(leaves: readonly LiveMdSourceIslandLeaf[]) {
  return leaves
    .map((leaf) => ({
      contextKey: leaf.contextKey,
      kind: leaf.kind,
      sourceRange: leaf.sourceRange,
    }))
    .sort(
      (left, right) =>
        left.sourceRange.from - right.sourceRange.from ||
        left.sourceRange.to - right.sourceRange.to ||
        left.kind.localeCompare(right.kind) ||
        left.contextKey.localeCompare(right.contextKey),
    );
}

function canonicalSemanticRecord(
  state: EditorState,
  record: LeafAnalysisRecord,
): CanonicalSemanticRecord {
  return {
    analysis: {
      analysisKey: record.analysis.analysisKey,
      descriptors: record.analysis.descriptors,
      renderKey: record.analysis.renderKey,
      structuralEffects: record.analysis.structuralEffects,
    },
    context: canonicalMarkdownBlockContext(record.context),
    contextKey: record.contextKey,
    effectRange: record.effectRange,
    kind: record.kind,
    range: record.range,
    source: state.sliceDoc(record.sourceRange.from, record.sourceRange.to),
    sourceHash: record.sourceHash.toString(16),
    sourceRange: record.sourceRange,
  };
}

function canonicalMarkdownBlockContext(context: LeafAnalysisRecord["context"]) {
  return {
    listPath: context.listPath.map((item) => ({
      itemRange: item.itemRange,
      markerRange: item.markerRange,
      markerText: item.markerText,
      task: item.task
        ? {
            checked: item.task.checked,
            range: item.task.range,
          }
        : null,
    })),
    quoteDepth: context.quoteDepth,
    quoteMarkers: context.quoteMarkers.map((range) => ({ from: range.from, to: range.to })),
  };
}

function compareCanonicalSemanticRecord(
  left: CanonicalSemanticRecord,
  right: CanonicalSemanticRecord,
) {
  return (
    left.range.from - right.range.from ||
    left.range.to - right.range.to ||
    left.sourceRange.from - right.sourceRange.from ||
    left.sourceRange.to - right.sourceRange.to ||
    left.effectRange.from - right.effectRange.from ||
    left.effectRange.to - right.effectRange.to ||
    left.kind.localeCompare(right.kind) ||
    left.contextKey.localeCompare(right.contextKey) ||
    left.source.localeCompare(right.source) ||
    JSON.stringify(left.analysis).localeCompare(JSON.stringify(right.analysis))
  );
}

function compareCanonicalSemanticTransitionRecord(
  left: CanonicalSemanticTransitionRecord,
  right: CanonicalSemanticTransitionRecord,
) {
  return compareCanonicalSemanticRecord(left, right) || left.cacheId - right.cacheId;
}

function firstCanonicalMismatch(
  left: readonly CanonicalSemanticTransitionRecord[],
  right: readonly CanonicalSemanticTransitionRecord[],
) {
  if (left.length != right.length) {
    return { leftLength: left.length, rightLength: right.length };
  }
  for (let index = 0; index < left.length; index++) {
    let leftRecord = left[index]!;
    let rightRecord = right[index]!;
    if (JSON.stringify(leftRecord) != JSON.stringify(rightRecord)) {
      return { index, left: leftRecord, right: rightRecord };
    }
  }
  return null;
}

type CanonicalSemanticRecord = {
  analysis: {
    analysisKey: string;
    descriptors: unknown;
    renderKey: string;
    structuralEffects: unknown;
  };
  context: ReturnType<typeof canonicalMarkdownBlockContext>;
  contextKey: string;
  effectRange: DocRange;
  kind: string;
  range: DocRange;
  source: string;
  sourceHash: string;
  sourceRange: DocRange;
};

type CanonicalSemanticTransitionRecord = CanonicalSemanticRecord & {
  cacheId: number;
};

function compareCanonicalRange(
  left: { from: number; spec?: unknown; to: number; value?: string },
  right: { from: number; spec?: unknown; to: number; value?: string },
) {
  return (
    left.from - right.from ||
    left.to - right.to ||
    JSON.stringify(left.spec ?? left.value).localeCompare(JSON.stringify(right.spec ?? right.value))
  );
}

function rangesOverlap(left: DocRange, right: DocRange) {
  return left.from < right.to && right.from < left.to;
}

function containsDocRange(outer: DocRange, inner: DocRange) {
  return outer.from <= inner.from && inner.to <= outer.to;
}

function clipCanonicalProjectionToRanges(
  projection: ReturnType<typeof canonicalProjectionFromSets>,
  ranges: readonly DocRange[],
): ReturnType<typeof canonicalProjectionFromSets> {
  let decorations = projection.decorations.flatMap((decoration) => {
    if (canonicalSpecHasWidget(decoration.spec)) {
      return ranges.some((range) => rangesOverlap(decoration, range)) ? [decoration] : [];
    }
    return intersectCanonicalRange(decoration, ranges).map((range) => ({
      ...decoration,
      ...range,
    }));
  });
  let atomicRanges = projection.atomicRanges.flatMap((atomicRange) =>
    intersectCanonicalRange(atomicRange, ranges).map((range) => ({
      ...atomicRange,
      ...range,
    })),
  );
  decorations.sort(compareCanonicalRange);
  atomicRanges.sort(compareCanonicalRange);
  return { atomicRanges, decorations };
}

function canonicalSpecHasWidget(spec: unknown) {
  return Boolean(spec && typeof spec == "object" && "widget" in spec);
}

function intersectCanonicalRange<T extends { from: number; to: number }>(
  target: T,
  ranges: readonly DocRange[],
) {
  let clipped: DocRange[] = [];
  for (let range of ranges) {
    let from = Math.max(target.from, range.from);
    let to = Math.min(target.to, range.to);
    if (from < to) clipped.push({ from, to });
  }
  return clipped;
}

function canonicalDecorationSpec(spec: Record<string, unknown>) {
  let normalized = { ...spec };
  if (typeof normalized.class == "string") {
    normalized.class = normalized.class.split(/\s+/).filter(Boolean).sort().join(" ");
  }
  let widget = spec.widget;
  if (widget && typeof widget == "object") {
    return {
      ...normalized,
      widget: {
        name: widget.constructor.name,
        props: Object.fromEntries(
          Object.getOwnPropertyNames(widget)
            .sort()
            .map((name) => [name, (widget as Record<string, unknown>)[name]]),
        ),
      },
    };
  }
  return normalized;
}
