// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import {
  RangeSet,
  __testBuildLiveMdAnalysis,
  __testFlushLiveMdAnalysis,
  __testLiveMdAnalysis,
  __testRefreshLiveMdSurface,
  canonicalProjectionFromSets,
  clipCanonicalProjectionToRanges,
  compileFullSurfaceProjection,
  compileVisibleSurfaceProjection,
  decorationClassesFromSet,
  installAnalysisTestEnvironment,
  linkHrefsFromSet,
  liveMdLinkInteractions,
  liveMdLinkOpen,
  liveMdMarkdownFeatures,
  loadCodeFenceLanguages,
  markdownAnalysisState,
  markdownAnalysisView,
  projectionCompileInputForTest,
  rangesOverlap,
  setCodeFenceLanguages,
  syntaxHighlighting,
  t,
  testLightCodeFenceHighlightStyle,
} from "./helpers/analysis.js";

installAnalysisTestEnvironment();

describe("LiveMD surface projection gates", () => {
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
    expect(beforeHasKeywordClass).toBe(true);
    expect(before.trace.codeFenceParses).toBe(1);
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
});
