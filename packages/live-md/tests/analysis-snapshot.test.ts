import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, Tree } from "@codemirror-treesitter/language";
import { describe, expect, it } from "vite-plus/test";
import { __testBuildLiveMdAnalysis, liveMdAnalysis } from "../src/core/decorations.js";
import {
  codeFenceLanguagesField,
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  setCodeFenceLanguages,
} from "../src/core/languages.js";

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

  it("rebuilds the full analysis after document edits", async () => {
    let doc = liveMdKitchenSinkDoc();
    let state = await markdownAnalysisState(doc, "After anchor");
    let editFrom = doc.indexOf("bold");
    let nextState = state.update({
      changes: { from: editFrom, to: editFrom + "bold".length, insert: "stronger" },
      selection: { anchor: editFrom + "stronger".length },
    }).state;

    expect(canonicalAnalysis(nextState)).toEqual(
      canonicalAnalysis(nextState, __testBuildLiveMdAnalysis(nextState)),
    );
  });

  it("rebuilds the full analysis after selection-only updates", async () => {
    let doc = liveMdKitchenSinkDoc();
    let state = await markdownAnalysisState(doc, "After anchor");
    let nextState = state.update({ selection: { anchor: doc.indexOf("Alt image") } }).state;

    expect(canonicalAnalysis(nextState)).toEqual(
      canonicalAnalysis(nextState, __testBuildLiveMdAnalysis(nextState)),
    );
  });

  it("parses code fence highlights fresh during full rebuilds", async () => {
    let doc = "```ts\nlet a = 1;\n```\n";
    let parseCalls = 0;
    let state = await markdownAnalysisState(doc);
    let languages = new Map(await loadCodeFenceLanguages());
    let tsParser = languages.get("ts");
    if (!tsParser) throw new Error("TypeScript code fence parser is unavailable");
    languages.set("ts", {
      parse(input) {
        parseCalls++;
        return tsParser.parse(input);
      },
    } as typeof tsParser);

    state = state.update({ effects: setCodeFenceLanguages.of(languages) }).state;
    expect(state.field(liveMdAnalysis).codeFenceHighlightTrees).toHaveLength(1);
    expect(parseCalls).toBe(1);

    parseCalls = 0;
    let editFrom = doc.indexOf("a = 1");
    let nextState = state.update({
      changes: { from: editFrom, to: editFrom + 1, insert: "aa" },
    }).state;

    expect(nextState.field(liveMdAnalysis).codeFenceHighlightTrees).toHaveLength(1);
    expect(parseCalls).toBe(1);
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

function canonicalAnalysis(state: EditorState, analysis = state.field(liveMdAnalysis)) {
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
