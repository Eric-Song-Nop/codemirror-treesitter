// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import {
  Tree,
  __testBuildCanonicalLiveMdAnalysis,
  __testBuildLiveMdAnalysis,
  __testFlushLiveMdAnalysis,
  __testLiveMdAnalysis,
  canonicalAnalysis,
  decorationClasses,
  ensureSyntaxTree,
  installAnalysisTestEnvironment,
  liveMdKitchenSinkDoc,
  loadCodeFenceLanguages,
  markdownAnalysisState,
  markdownAnalysisView,
  setCodeFenceLanguages,
  tablePreviewTables,
} from "./helpers/analysis.js";

installAnalysisTestEnvironment();

describe("LiveMD source-first runtime analysis", () => {
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
});
