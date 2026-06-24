// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import {
  Compartment,
  EditorView,
  RangeSet,
  __testBuildCanonicalLiveMdAnalysis,
  __testBuildLiveMdAnalysis,
  __testFlushLiveMdAnalysis,
  __testLiveMdAnalysis,
  canonicalAnalysis,
  canonicalProjectionFromSets,
  compileFullSurfaceProjection,
  decorationClassesFromSet,
  dispatchScheduledLocalEdit,
  expectDirectPatchLocal,
  expectDirectProjectionMatchesFullOracle,
  expectNoElement,
  expectSelectionHead,
  imagePreviewSourcesFromSet,
  installAnalysisTestEnvironment,
  lineRangeBySource,
  liveMdImageSource,
  markdownAnalysisState,
  markdownAnalysisView,
  projectionCompileInputForTest,
  requiredElement,
  widgetInstancesFromSet,
  widgetNamesFromSet,
} from "./helpers/analysis.js";

installAnalysisTestEnvironment();

describe("LiveMD direct projection contract", () => {
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
});
