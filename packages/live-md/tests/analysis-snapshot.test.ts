// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree, Tree } from "@codemirror-treesitter/language";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  __testBuildLiveMdAnalysis,
  __testBuildVisibleLiveMdAnalysis,
  __testLiveMdAnalysis,
  liveMdAnalysis,
} from "../src/core/decorations.js";
import {
  codeFenceLanguagesField,
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  setCodeFenceLanguages,
} from "../src/core/languages.js";

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
});

async function markdownAnalysisState(doc: string, selectionText = "") {
  let selection = selectionText ? doc.indexOf(selectionText) : 0;
  let state = EditorState.create({
    doc,
    extensions: [await loadMarkdownExtension(), codeFenceLanguagesField, liveMdAnalysis],
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state.update({ selection: { anchor: selection } }).state;
}

async function markdownAnalysisView(doc: string, selectionText = "") {
  let selection = selectionText ? doc.indexOf(selectionText) : 0;
  let view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc,
      selection: { anchor: selection },
      extensions: [await loadMarkdownExtension(), codeFenceLanguagesField, liveMdAnalysis],
    }),
  });
  ensureSyntaxTree(view.state, doc.length, 5_000);
  view.dispatch({});
  await waitForLiveMdRanges(view);
  return view;
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
