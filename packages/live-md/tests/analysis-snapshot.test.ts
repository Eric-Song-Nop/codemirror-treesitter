// @vitest-environment happy-dom

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  ensureSyntaxTree,
  HighlightStyle,
  syntaxHighlighting,
  tags as t,
  Tree,
} from "@codemirror-treesitter/language";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  __testBuildLiveMdAnalysis,
  __testBuildVisibleLiveMdAnalysis,
  __testLiveMdAnalysis,
  __testVisibleLineRanges,
  liveMdAnalysis,
} from "../src/core/decorations.js";
import { liveMdImageSource, normalizeMarkdownImageSource } from "../src/core/images.js";
import {
  codeFenceLanguagesField,
  liveMdCodeFenceHighlighting,
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  setCodeFenceLanguages,
} from "../src/core/languages.js";

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

  it("keeps visible analysis equivalent to a same-range rebuild after document edits", async () => {
    let doc = liveMdKitchenSinkDoc();
    let view = await markdownAnalysisView(doc, "After anchor");
    let editFrom = doc.indexOf("bold");
    view.dispatch({
      changes: { from: editFrom, to: editFrom + "bold".length, insert: "stronger" },
      selection: { anchor: editFrom + "stronger".length },
    });

    expect(canonicalAnalysis(view.state, __testLiveMdAnalysis(view))).toEqual(
      canonicalAnalysis(
        view.state,
        __testBuildVisibleLiveMdAnalysis(view.state, __testLiveMdAnalysis(view).ranges),
      ),
    );
    view.destroy();
  });

  it("keeps visible analysis equivalent to a same-range rebuild after selection-only updates", async () => {
    let doc = liveMdKitchenSinkDoc();
    let view = await markdownAnalysisView(doc, "After anchor");
    view.dispatch({ selection: { anchor: doc.indexOf("Alt image") } });

    expect(canonicalAnalysis(view.state, __testLiveMdAnalysis(view))).toEqual(
      canonicalAnalysis(
        view.state,
        __testBuildVisibleLiveMdAnalysis(view.state, __testLiveMdAnalysis(view).ranges),
      ),
    );
    view.destroy();
  });

  it("limits direct analysis builds to the requested range", async () => {
    let doc = "# First\n\n# Second\n\n";
    let state = await markdownAnalysisState(doc);
    let firstLine = state.doc.line(1);
    let analysis = __testBuildVisibleLiveMdAnalysis(state, [
      { from: firstLine.from, to: firstLine.to },
    ]);

    let secondHeadingFrom = doc.indexOf("# Second");
    let decorations = canonicalAnalysis(state, analysis).decorations;
    expect(decorations.some((decoration) => decoration.from >= secondHeadingFrom)).toBe(false);
  });

  it("renders table previews when visible ranges end inside a larger README table", async () => {
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
    let rangeStart = state.doc.lineAt(doc.indexOf("## Workspace Structure")).from;
    let rangeEnd = state.doc.lineAt(doc.indexOf("`vite.shared.ts`")).to;
    let tables = tablePreviewTables(
      state,
      __testBuildVisibleLiveMdAnalysis(state, [{ from: rangeStart, to: rangeEnd }]),
    );

    expect(tables).toHaveLength(1);
    expect(tables[0]?.header).toEqual(["Path", "Purpose"]);
    expect(tables[0]?.rows).toHaveLength(8);
    expect(tables[0]?.rows.at(-1)?.[0]).toBe("`bun.lock`");
  });

  it("keeps README-style escaped pipes inside table cells during visible rebuilds", async () => {
    let doc =
      "## Element API\n\n" +
      "| Property     | Type                 | Description                                |\n" +
      "| ------------ | -------------------- | ------------------------------------------ |\n" +
      "| `persistKey` | `string \\| null`     | `localStorage` key, read/write.            |\n" +
      "| `view`       | `EditorView \\| null` | The underlying CodeMirror `EditorView`.    |\n\n" +
      "after\n";
    let state = await markdownAnalysisState(doc, "Element API");
    let rangeStart = state.doc.lineAt(doc.indexOf("| Property")).from;
    let rangeEnd = state.doc.lineAt(doc.indexOf("`persistKey`")).to;
    let tables = tablePreviewTables(
      state,
      __testBuildVisibleLiveMdAnalysis(state, [{ from: rangeStart, to: rangeEnd }]),
    );

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

  it("limits editable table line decorations to the requested range", async () => {
    let rows = Array.from({ length: 24 }, (_row, index) => `| row ${index} | ${index} |`);
    let doc = `| Name | Value |\n| --- | ---: |\n${rows.join("\n")}\n`;
    let rowText = "row 12";
    let state = (await markdownAnalysisState(doc)).update({
      selection: { anchor: doc.indexOf(rowText) },
    }).state;
    let visibleLine = state.doc.lineAt(doc.indexOf(rowText));
    let analysis = __testBuildVisibleLiveMdAnalysis(state, [
      { from: visibleLine.from, to: visibleLine.to },
    ]);
    let tableLineDecorations: number[] = [];

    analysis.decorations.between(0, state.doc.length, (from, _to, value) => {
      let className = (value.spec as { class?: string }).class;
      if (className?.includes("cm-md-table-line")) tableLineDecorations.push(from);
    });

    expect(tableLineDecorations).toEqual([visibleLine.from]);
  });

  it("parses code fence highlights during visible rebuilds", async () => {
    let doc = "```ts\nlet a = 1;\n```\n";
    let parseCalls = 0;
    let languages = new Map(await loadCodeFenceLanguages());
    let tsParser = languages.get("ts");
    if (!tsParser) throw new Error("TypeScript code fence parser is unavailable");
    languages.set("ts", {
      parse(input) {
        parseCalls++;
        return tsParser.parse(input);
      },
    } as typeof tsParser);

    let view = await markdownAnalysisView(doc);
    view.dispatch({ effects: setCodeFenceLanguages.of(languages) });
    expect(__testLiveMdAnalysis(view).codeFenceHighlightTrees).toHaveLength(1);
    expect(parseCalls).toBe(1);

    parseCalls = 0;
    let editFrom = doc.indexOf("a = 1");
    view.dispatch({
      changes: { from: editFrom, to: editFrom + 1, insert: "aa" },
    });

    expect(__testLiveMdAnalysis(view).codeFenceHighlightTrees).toHaveLength(1);
    expect(parseCalls).toBe(1);
    view.destroy();
  });

  it("reuses active syntax highlighters for code fence highlights", async () => {
    let highlighterCompartment = new Compartment();
    let view = await markdownAnalysisView("```ts\nlet answer = 1;\n```\n", "", [
      highlighterCompartment.of(syntaxHighlighting(testLightCodeFenceHighlightStyle)),
    ]);
    view.dispatch({ effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()) });
    let lightKeywordClass = testLightCodeFenceHighlightStyle.style([t.keyword]);
    let darkKeywordClass = testDarkCodeFenceHighlightStyle.style([t.keyword]);

    expect(lightKeywordClass).toBeTruthy();
    expect(darkKeywordClass).toBeTruthy();
    expect(codeFenceClasses(view.state).has(lightKeywordClass!)).toBe(true);

    view.dispatch({
      effects: highlighterCompartment.reconfigure(
        syntaxHighlighting(testDarkCodeFenceHighlightStyle),
      ),
    });

    expect(codeFenceClasses(view.state).has(darkKeywordClass!)).toBe(true);
    expect(codeFenceClasses(view.state).has(lightKeywordClass!)).toBe(false);
    view.destroy();
  });

  it("allows explicit code fence highlighter overrides", async () => {
    let view = await markdownAnalysisView("```ts\nlet answer = 1;\n```\n", "", [
      syntaxHighlighting(testLightCodeFenceHighlightStyle),
      liveMdCodeFenceHighlighting(testDarkCodeFenceHighlightStyle),
    ]);
    view.dispatch({ effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()) });
    let lightKeywordClass = testLightCodeFenceHighlightStyle.style([t.keyword]);
    let darkKeywordClass = testDarkCodeFenceHighlightStyle.style([t.keyword]);

    expect(darkKeywordClass).toBeTruthy();
    expect(codeFenceClasses(view.state).has(darkKeywordClass!)).toBe(true);
    expect(codeFenceClasses(view.state).has(lightKeywordClass!)).toBe(false);
    view.destroy();
  });

  it("decorates inline markdown at EOF during visible range rebuilds", async () => {
    let doc = "cursor here\n\nuse *emphasize* here";
    let state = await markdownAnalysisState(doc);
    let tailLine = state.doc.lineAt(doc.indexOf("use"));
    let decorations = canonicalAnalysis(
      state,
      __testBuildVisibleLiveMdAnalysis(state, [{ from: tailLine.from, to: tailLine.to }]),
    ).decorations;
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
    expect(view.contentDOM.querySelectorAll(".cm-md-task-toggle")).toHaveLength(2);
    view.destroy();
  });

  it("renders task list decorations before trailing EOF blank lines", async () => {
    let doc = "- [x] done\n- [ ] todo\n\n\n";
    let state = await markdownAnalysisState(doc);
    let decorations = canonicalAnalysis(
      state,
      __testBuildVisibleLiveMdAnalysis(state, [{ from: 0, to: doc.length }]),
    ).decorations;

    expect(
      decorations.filter(
        (decoration) =>
          (decoration.spec as { widget?: { name?: string } }).widget?.name == "TaskCheckboxWidget",
      ),
    ).toHaveLength(2);
  });

  it("keeps visible line ranges open through EOF blank lines", async () => {
    let doc = "- [x] done\n- [ ] todo\n\n\n";
    let state = await markdownAnalysisState(doc);
    let view = {
      scrollDOM: { clientHeight: 100 },
      state,
      visibleRanges: [{ from: 0, to: doc.length }],
    } as unknown as EditorView;

    expect(__testVisibleLineRanges(view)).toEqual([{ from: 0, to: doc.length }]);
  });

  it("keeps the preceding task list item decorated when only EOF blank lines are visible", async () => {
    let doc = "- [x] done\n- [ ] todo\n\n\n";
    let state = (await markdownAnalysisState(doc)).update({
      selection: { anchor: doc.length },
    }).state;
    let blankLine = state.doc.line(3);
    let decorations = canonicalAnalysis(
      state,
      __testBuildVisibleLiveMdAnalysis(state, [{ from: blankLine.from, to: doc.length }]),
    ).decorations;

    expect(
      decorations.some(
        (decoration) =>
          (decoration.spec as { widget?: { name?: string } }).widget?.name == "TaskCheckboxWidget",
      ),
    ).toBe(true);
  });

  it("keeps the preceding table preview when only EOF blank lines are visible", async () => {
    let doc = "| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n\n\n";
    let state = (await markdownAnalysisState(doc)).update({
      selection: { anchor: doc.length },
    }).state;
    let blankLine = state.doc.line(4);
    let decorations = canonicalAnalysis(
      state,
      __testBuildVisibleLiveMdAnalysis(state, [{ from: blankLine.from, to: doc.length }]),
    ).decorations;

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
  await waitForLiveMdRanges(view);
  return view;
}

function imagePreviewSources(state: EditorState) {
  let sources: string[] = [];
  __testBuildLiveMdAnalysis(state).decorations.between(0, state.doc.length, (_from, _to, value) => {
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

async function waitForLiveMdRanges(view: EditorView) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (__testLiveMdAnalysis(view).ranges.length) return;
  }
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
  let decorations: Array<{ from: number; spec: unknown; to: number }> = [];
  analysis.decorations.between(0, state.doc.length, (from, to, value) => {
    decorations.push({ from, spec: canonicalDecorationSpec(value.spec), to });
  });
  decorations.sort(compareCanonicalRange);

  let atomicRanges: Array<{ from: number; to: number; value: string }> = [];
  analysis.atomicRanges.between(0, state.doc.length, (from, to, value) => {
    atomicRanges.push({ from, to, value: value.constructor.name });
  });
  atomicRanges.sort(compareCanonicalRange);

  return { atomicRanges, decorations };
}

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

function canonicalDecorationSpec(spec: Record<string, unknown>) {
  let widget = spec.widget;
  if (widget && typeof widget == "object") {
    return {
      ...spec,
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
  return spec;
}
