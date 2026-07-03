// @vitest-environment happy-dom

import {
  EditorSelection,
  EditorState,
  RangeSet,
  StateField,
  type Extension,
} from "@codemirror/state";
import { undo, redo } from "@codemirror-treesitter/commands";
import { ensureSyntaxTree, syntaxTree, type Tree } from "@codemirror-treesitter/language";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { loadMarkdownParserService } from "@codemirror-treesitter/language-data";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  __testBuildCanonicalLiveMdAnalysis,
  __testBuildLiveMdAnalysis,
  __testFlushLiveMdAnalysis,
  __testLiveMdAnalysis,
  liveMdAnalysis,
} from "../src/core/decorations.js";
import { createLiveMdEditor, type LiveMdEditorController } from "../src/core/editor.js";
import { liveMdMarkdownFeatures } from "../src/core/features.js";
import {
  liveMdMarkdownParserServiceFacet,
  loadMarkdownExtension,
  type LiveMdMarkdownParserService,
} from "../src/core/languages.js";
import {
  activeMarkdownSourceRanges,
  analyzeLiveMdSourceIslands,
  sourceIslandIndexFromLeaves,
  type LiveMdSourceIslandLeaf,
} from "../src/core/analysis/markdown-source-islands.js";
import { compileFullSurfaceProjection } from "../src/core/projection/compilers.js";
import { type LiveMdAnalysis } from "../src/core/runtime/types.js";

type SelectionSpec = number | { anchor: number; head: number };

let locationDescriptor: PropertyDescriptor | undefined;

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

const canonicalLiveMdAnalysisField = StateField.define<LiveMdAnalysis>({
  create: __testBuildCanonicalLiveMdAnalysis,
  update(_value, transaction) {
    return __testBuildCanonicalLiveMdAnalysis(transaction.state);
  },
  provide(field) {
    return [
      EditorView.decorations.from(field, (analysis) => analysis.decorations),
      EditorView.atomicRanges.of(
        (view) => view.state.field(field, false)?.atomicRanges ?? RangeSet.empty,
      ),
    ];
  },
});

describe("LiveMD active source islands", () => {
  it("keeps paragraph and heading syntax visible inside the active leaf", async () => {
    let paragraph = await mountEditor("Use *emphasis* here\n\nnext", {
      selection: "Use *emphasis* here".indexOf("emphasis"),
    });
    expect(
      syntaxSpans(paragraph, "*").every((span) => span.classList.contains("cm-md-syntax-active")),
    ).toBe(true);
    paragraph.destroy();

    let heading = await mountEditor("## Heading\n\nnext", { selection: "## ".length });
    let marker = syntaxSpans(heading, "##")[0];
    expect(marker?.classList.contains("cm-md-syntax-active")).toBe(true);
    heading.destroy();
  });

  it("keeps table and fence blocks as source while their leaf is active", async () => {
    let tableDoc =
      "| Name | Value |\n" +
      "| --- | ---: |\n" +
      "| **alpha** | [one](https://one.example) |\n\n" +
      "next";
    let table = await mountEditor(tableDoc, { selection: tableDoc.indexOf("alpha") });
    let tableAnalysis = __testLiveMdAnalysis(table.view);

    expect(table.view.dom.querySelector(".cm-md-table-preview")).toBeNull();
    expect(table.view.contentDOM.textContent).toContain("| Name | Value |");
    expect(table.view.dom.querySelector(".cm-md-syntax-hidden")).toBeNull();
    expect(atomicRangeTexts(table.view.state, tableAnalysis)).toEqual([]);
    table.destroy();

    let fenceDoc = "```ts\nconst x = 1;\n```\n\nnext";
    let fence = await mountEditor(fenceDoc, { selection: fenceDoc.indexOf("const") });
    let closingFence = syntaxSpans(fence, "```").at(-1);

    expect(closingFence?.classList.contains("cm-md-syntax-active")).toBe(true);
    expect(closingFence?.classList.contains("cm-md-syntax-hidden")).toBe(false);
    fence.destroy();
  });

  it("keeps canonical active table cell inline marks and links in source", async () => {
    let doc =
      "| Name | Value |\n" +
      "| --- | ---: |\n" +
      "| **alpha** | [docs](https://docs.example) |\n\n" +
      "next";
    let view = await mountCanonicalEditor(doc, { selection: doc.indexOf("alpha") });
    let analysis = view.state.field(canonicalLiveMdAnalysisField);
    let classes = decorationClasses(view.state, analysis);
    let strong = view.dom.querySelector<HTMLElement>(".cm-md-strong");
    let link = view.dom.querySelector<HTMLElement>(".cm-md-link[data-live-md-href]");

    expect(view.dom.querySelector(".cm-md-table-preview")).toBeNull();
    expect(strong?.textContent).toContain("alpha");
    expect(link?.textContent).toContain("docs");
    expect(link?.dataset.liveMdHref).toBe("https://docs.example");
    expect(classes.has("cm-md-strong")).toBe(true);
    expect(classes.has("cm-md-link")).toBe(true);
    expect(view.dom.querySelector(".cm-md-syntax-hidden")).toBeNull();
    expect(
      syntaxSpans(view, "**").every((span) => span.classList.contains("cm-md-syntax-active")),
    ).toBe(true);
    expect(atomicRangeTexts(view.state, analysis)).toEqual([]);
    view.destroy();
  });

  it("keeps active table inline source marks in the visible surface layer", async () => {
    let doc =
      "| Name | Value |\n" +
      "| --- | ---: |\n" +
      "| **alpha** | [docs](https://docs.example) |\n\n" +
      "next";
    let state = await markdownState(doc, {
      selection: EditorSelection.create([EditorSelection.cursor(doc.indexOf("alpha"))]),
    });
    let analysis = __testBuildLiveMdAnalysis(state);
    if (!analysis.semantic) throw new Error("Expected semantic cache for active table");
    let surface = compileFullSurfaceProjection(
      projectionCompileInputForTest(state, analysis),
      analysis.semantic.cache,
    );
    let directClasses = decorationClassesFromSet(state, analysis.directDecorations);
    let surfaceClasses = decorationClassesFromSet(state, surface.decorations);

    expect(directClasses.has("cm-md-table-line")).toBe(true);
    expect(directClasses.has("cm-md-strong")).toBe(false);
    expect(directClasses.has("cm-md-link")).toBe(false);
    expect(surfaceClasses.has("cm-md-strong")).toBe(true);
    expect(surfaceClasses.has("cm-md-link")).toBe(true);
    expect(widgetNamesFromSet(state, analysis.directDecorations)).not.toContain(
      "TablePreviewWidget",
    );
    expect(widgetNamesFromSet(state, surface.decorations)).not.toContain("TablePreviewWidget");
  });

  it("does not layer canonical cell inline marks over inactive table previews", async () => {
    let doc =
      "| Name | Value |\n" +
      "| --- | ---: |\n" +
      "| **alpha** | [docs](https://docs.example) |\n\n" +
      "next";
    let view = await mountCanonicalEditor(doc, { selection: doc.indexOf("next") });
    let analysis = view.state.field(canonicalLiveMdAnalysisField);
    let classes = decorationClasses(view.state, analysis);

    expect(view.dom.querySelector(".cm-md-table-preview")).toBeTruthy();
    expect(view.dom.querySelector(".cm-md-strong")).toBeNull();
    expect(view.dom.querySelector(".cm-md-link")).toBeNull();
    expect(classes.has("cm-md-strong")).toBe(false);
    expect(classes.has("cm-md-link")).toBe(false);
    view.destroy();
  });

  it("expands only the active leaf inside list and quote containers", async () => {
    let listDoc = "- [ ] first\n- [ ] second\n\nnext";
    let list = await mountEditor(listDoc, { selection: listDoc.indexOf("first") });

    expect(list.view.dom.querySelectorAll(".cm-md-task-toggle")).toHaveLength(1);
    expect(
      syntaxSpans(list, "[ ]").some((span) => span.classList.contains("cm-md-syntax-active")),
    ).toBe(true);
    list.destroy();

    let quoteDoc = "> *first*\n\n> *second*\n\nnext";
    let quote = await mountEditor(quoteDoc, { selection: quoteDoc.indexOf("first") });
    let quoteSyntax = syntaxSpans(quote, "*");
    let quoteSourceRanges = __testLiveMdAnalysis(quote.view).activeSourceRanges.map((range) =>
      quote.view.state.sliceDoc(range.from, range.to),
    );

    expect(quoteSourceRanges).toEqual(["> *first*"]);
    expect(quoteSyntax.some((span) => span.classList.contains("cm-md-syntax-active"))).toBe(true);
    expect(quoteSyntax.some((span) => span.classList.contains("cm-md-syntax-hidden"))).toBe(true);
    quote.destroy();
  });

  it("does not expand a neighboring block when the selection is on a blank line", async () => {
    let doc = "| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n\nnext";
    let editor = await mountEditor(doc, { selection: doc.indexOf("\n\n") + 1 });

    expect(editor.view.dom.querySelector(".cm-md-table-preview")).toBeTruthy();
    editor.destroy();
  });

  it("does not expand a header-only table from the following blank line", async () => {
    let doc = "| A | B |\n| - | - |\n\nnext";
    let editor = await mountEditor(doc, { selection: doc.indexOf("\n\n") + 1 });

    expect(editor.view.dom.querySelector(".cm-md-table-preview")).toBeTruthy();
    editor.destroy();
  });

  it("keeps marker-only edit states as source islands", async () => {
    let cases = [
      { doc: "-", forbiddenWidget: ".cm-md-list-marker" },
      { doc: "- ", forbiddenWidget: ".cm-md-list-marker" },
      { doc: "- [ ]", forbiddenWidget: ".cm-md-task-toggle" },
      { doc: "- [ ] ", forbiddenWidget: ".cm-md-task-toggle" },
      { doc: ">", forbiddenWidget: ".cm-md-syntax-hidden" },
      { doc: "> ", forbiddenWidget: ".cm-md-syntax-hidden" },
      { doc: "> - ", forbiddenWidget: ".cm-md-list-marker" },
      { doc: "> - [ ] ", forbiddenWidget: ".cm-md-task-toggle" },
    ];

    for (let testCase of cases) {
      let editor = await mountEditor(testCase.doc, { selection: testCase.doc.length });

      expectMarkerOnlySource(editor, testCase.doc);
      expect(editor.view.dom.querySelector(testCase.forbiddenWidget)).toBeNull();
      editor.destroy();
    }

    let blankLine = await mountEditor("before\n\nnext", { selection: "before\n".length });
    expect(sourceTexts(blankLine.view.state, __testLiveMdAnalysis(blankLine.view))).toEqual([]);
    blankLine.destroy();
  });

  it("indexes marker-only source islands by physical line", async () => {
    let cases = [
      { doc: "- \n- item", leaf: "- item", marker: "- " },
      { doc: "> - [ ] \n> - item", leaf: "> - item", marker: "> - [ ] " },
    ];

    for (let testCase of cases) {
      let state = await markdownState(testCase.doc);
      let analysis = analyzeLiveMdSourceIslands({ state, tree: syntaxTree(state) });
      let texts = analysis.leaves
        .toArray()
        .map((leaf) => state.sliceDoc(leaf.sourceRange.from, leaf.sourceRange.to));
      let leafFrom = testCase.doc.indexOf(testCase.leaf);
      let leafCursor = leafFrom + testCase.leaf.indexOf("item");

      expect(texts, testCase.doc).toEqual([testCase.marker, testCase.leaf]);
      expect(
        activeTexts(state, EditorSelection.cursor(testCase.marker.length)),
        testCase.doc,
      ).toEqual([testCase.marker]);
      expect(activeTexts(state, EditorSelection.cursor(leafCursor)), testCase.doc).toEqual([
        testCase.leaf,
      ]);
    }
  });

  it("does not split marker source islands from leaf lines", async () => {
    let cases = ["- item", "- [ ] item", "> - [ ] item"];

    for (let doc of cases) {
      let state = await markdownState(doc);
      let analysis = analyzeLiveMdSourceIslands({ state, tree: syntaxTree(state) });

      expect(
        analysis.leaves
          .toArray()
          .map((leaf) => state.sliceDoc(leaf.sourceRange.from, leaf.sourceRange.to)),
        doc,
      ).toEqual([doc]);
    }
  });

  it("keeps marker-only source islands reachable after edit commands", async () => {
    let entered = await mountEditor("- item", { selection: "- item".length });
    pressKey(entered.view, "Enter");
    expect(entered.value).toBe("- item\n- ");
    await __testFlushLiveMdAnalysis(entered.view);
    expectMarkerOnlySource(entered, "- ");
    entered.destroy();

    let deleted = await mountEditor("- ", { selection: "- ".length });
    pressKey(deleted.view, "Backspace");
    expect(deleted.value).toBe("-");
    await __testFlushLiveMdAnalysis(deleted.view);
    expectMarkerOnlySource(deleted, "-");
    deleted.destroy();

    let history = await mountEditor("-", { selection: "-".length });
    history.view.dispatch({
      changes: { from: "-".length, insert: " " },
      selection: { anchor: "- ".length },
      userEvent: "input",
    });
    await __testFlushLiveMdAnalysis(history.view);
    expectMarkerOnlySource(history, "- ");

    expect(undo(history.view)).toBe(true);
    expect(history.value).toBe("-");
    await __testFlushLiveMdAnalysis(history.view);
    expectMarkerOnlySource(history, "-");

    expect(redo(history.view)).toBe(true);
    expect(history.value).toBe("- ");
    await __testFlushLiveMdAnalysis(history.view);
    expectMarkerOnlySource(history, "- ");
    history.destroy();
  });

  it("does not turn Select All into a document-wide source island", async () => {
    let doc =
      "[one](https://one.example)\n\n" +
      "| Name | Value |\n" +
      "| --- | ---: |\n" +
      "| alpha | 1 |\n\n" +
      "end";
    let editor = await mountEditor(doc, { selection: { anchor: 0, head: doc.length } });
    let analysis = __testLiveMdAnalysis(editor.view);

    expect(analysis.activeSourceRanges).toHaveLength(1);
    expect(editor.view.dom.querySelector(".cm-md-link[data-live-md-href]")).toBeTruthy();
    expect(editor.view.dom.querySelector(".cm-md-table-preview")).toBeTruthy();
    editor.destroy();
  });

  it("keeps the same projection when selection crosses physical lines inside one leaf", async () => {
    let doc = "cursor is here\n![Alt](image.png)\n\nnext";
    let editor = await mountEditor(doc, { selection: doc.indexOf("cursor") });
    let before = __testLiveMdAnalysis(editor.view);

    expect(editor.view.dom.querySelector(".cm-md-image-preview")).toBeNull();

    editor.view.dispatch({ selection: { anchor: doc.indexOf("Alt") } });

    expect(__testLiveMdAnalysis(editor.view)).toBe(before);
    expect(editor.view.dom.querySelector(".cm-md-image-preview")).toBeNull();
    editor.destroy();
  });

  it("turns a full-line image preview back into source when clicked", async () => {
    let doc = "![Alt](image.png)\n\nnext";
    let editor = await mountEditor(doc, { selection: doc.indexOf("next") });
    let preview = editor.view.dom.querySelector<HTMLElement>(".cm-md-image-preview");

    expect(preview).toBeTruthy();
    preview!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(__testLiveMdAnalysis(editor.view).activeSourceRanges).toEqual([
      { from: 0, to: "![Alt](image.png)".length },
    ]);
    expect(editor.view.dom.querySelector(".cm-md-image-preview")).toBeNull();
    editor.destroy();
  });

  it("tracks every cursor leaf in a multi-cursor selection", async () => {
    let doc = "*one*\n\n*two*\n\n*three*";
    let state = await markdownState(doc);
    state = state.update({
      selection: EditorSelection.create(
        [EditorSelection.cursor(doc.indexOf("one")), EditorSelection.cursor(doc.indexOf("three"))],
        0,
      ),
    }).state;
    let analysis = __testBuildLiveMdAnalysis(state);

    expect(
      analysis.activeSourceRanges.map((range) => state.sliceDoc(range.from, range.to)),
    ).toEqual(["*one*", "*three*"]);
  });

  it("keeps analyze markdown feature decorations active inside source islands", async () => {
    let state = await markdownState("# Active\n\n# Inactive", {
      extensions: liveMdMarkdownFeatures([
        {
          name: "mark-heading",
          query: "(atx_heading) @heading",
          analyze({ node }) {
            let heading = node("heading");
            if (!heading) return [];
            return [
              {
                className: "cm-md-test-heading",
                kind: "mark",
                range: { from: heading.from, to: heading.to },
              },
            ];
          },
        },
      ]),
    });

    expect(decorationClasses(state).has("cm-md-test-heading")).toBe(true);
  });

  it("balances transient inline parser and tree resources", async () => {
    let doc = "Use *one* and **two**";
    let counts = { parserCreate: 0, parserDelete: 0, treeCreate: 0, treeDelete: 0 };
    let service = trackInlineResources(await loadMarkdownParserService(), counts);
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(service),
        liveMdAnalysis,
      ],
    });
    ensureSyntaxTree(state, doc.length, 5_000);
    state = state.update({}).state;

    __testBuildLiveMdAnalysis(state);

    expect(counts.parserCreate).toBe(counts.parserDelete);
    expect(counts.treeCreate).toBeGreaterThan(0);
    expect(counts.treeCreate).toBe(counts.treeDelete);
  });

  it("keeps source island ownership linear for many paragraphs", async () => {
    let doc = Array.from({ length: 10_000 }, (_value, index) => `paragraph ${index}`).join("\n\n");
    let state = EditorState.create({
      doc,
      extensions: [await loadMarkdownExtension()],
    });
    ensureSyntaxTree(state, doc.length, 5_000);
    state = state.update({}).state;
    let analysis = analyzeLiveMdSourceIslands({ state, tree: syntaxTree(state) });

    expect(analysis.leaves).toHaveLength(10_000);
    expect(
      analysis.leaves
        .toArray()
        .slice(0, 2)
        .map((leaf) => state.sliceDoc(leaf.sourceRange.from, leaf.sourceRange.to)),
    ).toEqual(["paragraph 0", "paragraph 1"]);
  });

  it("uses binary lookup for selection-only active source range updates", () => {
    let ranges: Array<{ from: number; to: number }> = [];
    let parts: string[] = [];
    let position = 0;
    for (let index = 0; index < 10_000; index++) {
      let text = `paragraph ${index}`;
      parts.push(text);
      ranges.push({ from: position, to: position + text.length });
      position += text.length + 2;
    }

    let reads = 0;
    let leaves = sourceIslandIndexFromLeaves(
      ranges.map((range) => countedSourceIslandLeaf(range, () => reads++)),
    );
    let target = ranges[9_500]!;
    let state = EditorState.create({
      doc: parts.join("\n\n"),
      selection: EditorSelection.cursor(target.from + "paragraph ".length),
    });

    expect(activeMarkdownSourceRanges(state, leaves)).toEqual([target]);
    expect(reads).toBeLessThan(80);
  });

  it("uses explicit caret ownership at source island boundaries", async () => {
    let paragraphDoc = "one\n\ntwo";
    let paragraphState = await markdownState(paragraphDoc);
    expect(activeTexts(paragraphState, EditorSelection.cursor(0, -1))).toEqual([]);
    expect(activeTexts(paragraphState, EditorSelection.cursor(0, 0))).toEqual(["one"]);
    expect(activeTexts(paragraphState, EditorSelection.cursor(3, -1))).toEqual(["one"]);
    expect(activeTexts(paragraphState, EditorSelection.cursor(3, 0))).toEqual(["one"]);
    expect(activeTexts(paragraphState, EditorSelection.cursor(3, 1))).toEqual([]);
    expect(activeTexts(paragraphState, EditorSelection.cursor(4, 0))).toEqual([]);
    expect(activeTexts(paragraphState, EditorSelection.cursor(5, 0))).toEqual(["two"]);
    expect(activeTexts(paragraphState, EditorSelection.cursor(paragraphDoc.length, 0))).toEqual([
      "two",
    ]);
    expect(activeTexts(paragraphState, EditorSelection.cursor(paragraphDoc.length, 1))).toEqual([]);

    let tableDoc = "| A | B |\n| - | - |\n\nnext";
    let tableState = await markdownState(tableDoc);
    let tableEnd = tableDoc.indexOf("\n\n");
    expect(activeTexts(tableState, EditorSelection.cursor(tableEnd, -1))).toEqual([
      "| A | B |\n| - | - |",
    ]);
    expect(activeTexts(tableState, EditorSelection.cursor(tableEnd, 0))).toEqual([
      "| A | B |\n| - | - |",
    ]);
    expect(activeTexts(tableState, EditorSelection.cursor(tableEnd, 1))).toEqual([]);
    expect(activeTexts(tableState, EditorSelection.cursor(tableEnd + 1, 0))).toEqual([]);

    let fenceDoc = "```ts\ncode\n\n";
    let fenceState = await markdownState(fenceDoc);
    expect(activeTexts(fenceState, EditorSelection.cursor(fenceDoc.length, 0))).toEqual([]);
  });

  it("does not assign Enter-created line starts to the previous committed island", async () => {
    let fenceDoc = "```ts\n";
    let fenceState = await markdownState(fenceDoc);
    expect(activeTexts(fenceState, EditorSelection.cursor(fenceDoc.length, 0))).toEqual([]);

    let tableCandidateDoc = "| A | B |\n";
    let tableCandidateState = await markdownState(tableCandidateDoc);
    expect(
      activeTexts(tableCandidateState, EditorSelection.cursor(tableCandidateDoc.length, 0)),
    ).toEqual([]);
  });
});

async function mountEditor(
  doc: string,
  options: { selection: SelectionSpec } = { selection: 0 },
): Promise<LiveMdEditorController> {
  let parent = document.body.appendChild(document.createElement("div"));
  let editor = createLiveMdEditor({ parent, doc, focus: false });
  await editor.ready;
  editor.view.dispatch({
    selection:
      typeof options.selection == "number"
        ? { anchor: options.selection }
        : { anchor: options.selection.anchor, head: options.selection.head },
  });
  return editor;
}

async function mountCanonicalEditor(
  doc: string,
  options: { selection: SelectionSpec } = { selection: 0 },
): Promise<EditorView> {
  let parent = document.body.appendChild(document.createElement("div"));
  let view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: selectionFromSpec(options.selection),
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        await loadMarkdownExtension(),
        canonicalLiveMdAnalysisField,
      ],
    }),
  });
  ensureSyntaxTree(view.state, doc.length, 5_000);
  view.dispatch({});
  return view;
}

async function markdownState(
  doc: string,
  options: { extensions?: Extension; selection?: EditorSelection } = {},
) {
  let state = EditorState.create({
    doc,
    selection: options.selection ?? EditorSelection.cursor(0),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      await loadMarkdownExtension(),
      options.extensions ?? [],
      liveMdAnalysis,
    ],
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state.update({}).state;
}

function projectionCompileInputForTest(
  state: EditorState,
  analysis: ReturnType<typeof __testBuildLiveMdAnalysis>,
) {
  return {
    activeLines: new Set(analysis.activeLines),
    activeSourceRanges: analysis.activeSourceRanges,
    codeFenceHighlighters: [],
    codeFenceLanguages: new Map(),
    imageSourceResolver: null,
    linkBaseUrl: null,
    markdownFeatures: [],
    sourceIslandMode: true,
    state,
    trace: analysis.trace,
  };
}

function selectionFromSpec(selection: SelectionSpec) {
  return typeof selection == "number"
    ? EditorSelection.cursor(selection)
    : EditorSelection.range(selection.anchor, selection.head);
}

function syntaxSpans(editor: EditorView | LiveMdEditorController, text: string) {
  let contentDOM = editor instanceof EditorView ? editor.contentDOM : editor.view.contentDOM;
  return Array.from(contentDOM.querySelectorAll<HTMLElement>(".cm-md-syntax")).filter(
    (span) => span.textContent == text,
  );
}

function activeTexts(state: EditorState, range: ReturnType<typeof EditorSelection.cursor>) {
  let nextState = state.update({ selection: EditorSelection.create([range]) }).state;
  return sourceTexts(nextState, __testBuildLiveMdAnalysis(nextState));
}

function sourceTexts(state: EditorState, analysis: LiveMdAnalysis) {
  return analysis.activeSourceRanges.map((range) => state.sliceDoc(range.from, range.to));
}

function expectMarkerOnlySource(editor: LiveMdEditorController, expected: string) {
  let analysis = __testLiveMdAnalysis(editor.view);
  expect(sourceTexts(editor.view.state, analysis)).toEqual([expected]);

  let sourceRange = analysis.activeSourceRanges[0]!;
  let sourceLine = editor.view.state.doc.lineAt(sourceRange.from);
  let lineElement = editor.view.contentDOM.querySelectorAll(".cm-line").item(sourceLine.number - 1);
  expect(lineElement.querySelector(".cm-md-list-marker")).toBeNull();
  expect(lineElement.querySelector(".cm-md-task-toggle")).toBeNull();
  expect(editor.view.contentDOM.textContent).toContain(expected.trimEnd());
}

function pressKey(view: EditorView, key: string, init: KeyboardEventInit = {}) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key.length == 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

function decorationClasses(state: EditorState, analysis = __testBuildLiveMdAnalysis(state)) {
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

function widgetNamesFromSet(state: EditorState, decorations: DecorationSet) {
  let names: string[] = [];
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    let widget = (value.spec as { widget?: unknown }).widget;
    if (widget && typeof widget == "object") names.push(widget.constructor.name);
  });
  return names;
}

function atomicRangeTexts(state: EditorState, analysis = __testBuildLiveMdAnalysis(state)) {
  let texts: string[] = [];
  analysis.atomicRanges.between(0, state.doc.length, (from, to) => {
    texts.push(state.sliceDoc(from, to));
  });
  return texts;
}

function trackInlineResources(
  service: LiveMdMarkdownParserService,
  counts: { parserCreate: number; parserDelete: number; treeCreate: number; treeDelete: number },
): LiveMdMarkdownParserService {
  let inlineParser = Object.create(
    service.inlineParser,
  ) as LiveMdMarkdownParserService["inlineParser"];
  inlineParser.createParser = () => {
    counts.parserCreate++;
    let parser = service.inlineParser.createParser();
    let nativeParser = parser as { delete: () => void };
    let deleteParser = nativeParser.delete.bind(parser);
    nativeParser.delete = () => {
      counts.parserDelete++;
      deleteParser();
    };
    return parser;
  };
  inlineParser.wrapTree = (...args: Parameters<typeof service.inlineParser.wrapTree>) => {
    let tree = service.inlineParser.wrapTree(...args);
    if (tree?.tree) trackTreeDelete(tree, counts);
    return tree;
  };
  return { ...service, inlineParser };
}

function trackTreeDelete(tree: Tree, counts: { treeCreate: number; treeDelete: number }) {
  counts.treeCreate++;
  let nativeTree = tree.tree as { delete: () => void };
  let deleteTree = nativeTree.delete.bind(nativeTree);
  nativeTree.delete = () => {
    counts.treeDelete++;
    deleteTree();
  };
}

function countedSourceIslandLeaf(range: { from: number; to: number }, onRead: () => void) {
  let leaf = {
    contextKey: "q0|",
    kind: "paragraph",
  } as LiveMdSourceIslandLeaf;
  Object.defineProperty(leaf, "sourceRange", {
    get() {
      onRead();
      return range;
    },
  });
  return leaf;
}
