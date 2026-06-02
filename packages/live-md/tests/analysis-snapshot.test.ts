import { Compartment, EditorState, type TransactionSpec } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { describe, expect, it } from "vite-plus/test";
import { SyntaxNode } from "../../language/src/tree.js";
import {
  __testBuildLiveMdAnalysis,
  __testLiveMdOwnerSnapshots,
  liveMdAnalysis,
} from "../src/core/decorations.js";
import {
  codeFenceLanguagesField,
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  setCodeFenceLanguages,
} from "../src/core/languages.js";

describe("LiveMD analysis snapshot", () => {
  it("records text dirty ranges while continuing to rebuild the full analysis", () => {
    let state = analysisState("first\nsecond");
    let transaction = state.update({
      changes: { from: 0, to: 5, insert: "changed" },
    });
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.dirtyRanges).toEqual([{ from: 0, reasons: ["text"], to: 7 }]);
    expect(Array.from(analysis.activeLines)).toEqual([1]);
  });

  it("records selection dirty ranges from previous and current active lines", () => {
    let state = analysisState("first\nsecond\nthird", 1);
    let transaction = state.update({
      selection: { anchor: "first\nsecond\n".length },
    });
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.dirtyRanges).toEqual([
      { from: 0, reasons: ["selection"], to: 5 },
      { from: 13, reasons: ["selection"], to: 18 },
    ]);
    expect(Array.from(analysis.activeLines)).toEqual([3]);
  });

  it("patches code fence language updates without rebuilding untouched Markdown decorations", async () => {
    let doc = "```ts\nlet a = 1;\n```\n\n- after";
    let state = await markdownAnalysisState(doc);
    let contentLine = state.doc.lineAt(doc.indexOf("let a"));
    let afterLine = state.doc.lineAt(doc.indexOf("- after"));
    let before = lineDecorations(state, afterLine.from);

    expect(before.length).toBeGreaterThan(0);

    let transaction = state.update({
      effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()),
    });
    let analysis = transaction.state.field(liveMdAnalysis);
    let after = lineDecorations(transaction.state, afterLine.from);

    expect(analysis.dirtyRanges).toEqual([
      { from: contentLine.from, reasons: ["codeFenceLanguages"], to: contentLine.to + 1 },
    ]);
    expect(analysis.expandedDirtyRanges).toEqual([
      { from: contentLine.from, reasons: ["codeFenceLanguages"], to: contentLine.to + 1 },
    ]);
    expect(after).toHaveLength(before.length);
    expect(after[0]).toBe(before[0]);
  });

  it("records expanded dirty ranges using Markdown feature scopes", async () => {
    let doc = "![alt](one.png)\nnext";
    let state = await markdownAnalysisState(doc);
    let dirtyFrom = doc.indexOf("one");
    let transaction = state.update({
      changes: { from: dirtyFrom, to: dirtyFrom + 3, insert: "two" },
    });
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.dirtyRanges).toEqual([
      { from: dirtyFrom, reasons: ["text"], to: dirtyFrom + 3 },
    ]);
    expect(analysis.expandedDirtyRanges).toEqual([
      { from: 0, reasons: ["text"], to: "![alt](two.png)".length },
    ]);
  });

  it("records syntax dirty ranges for Markdown structure changes", async () => {
    let state = await markdownAnalysisState("plain\nnext");
    let transaction = state.update({
      changes: { from: 0, insert: "# " },
    });
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.dirtyRanges.some((range) => range.reasons.includes("syntax"))).toBe(true);
  });

  it("records syntax dirty ranges when Markdown parsing becomes available", async () => {
    let markdown = new Compartment();
    let doc = "- first\n\n- second";
    let state = EditorState.create({
      doc,
      extensions: [codeFenceLanguagesField, liveMdAnalysis, markdown.of([])],
    });
    let transaction = state.update({
      effects: markdown.reconfigure(await loadMarkdownExtension()),
    });
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.dirtyRanges).toEqual([{ from: 0, reasons: ["syntax"], to: doc.length }]);
  });

  it("patches selection-only updates without rebuilding untouched line decorations", async () => {
    let doc = "- first\n- second\n- third";
    let state = await markdownAnalysisState(doc, 2);
    let untouchedLine = state.doc.line(2);
    let before = lineDecorations(state, untouchedLine.from);

    expect(before.length).toBeGreaterThan(0);

    let transaction = state.update({
      selection: { anchor: doc.indexOf("third") },
    });
    let after = lineDecorations(transaction.state, transaction.state.doc.line(2).from);
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.expandedDirtyRanges).toEqual([
      { from: 0, reasons: ["selection"], to: 7 },
      { from: 17, reasons: ["selection"], to: 24 },
    ]);
    expect(after).toHaveLength(before.length);
    expect(after[0]).toBe(before[0]);
  });

  it("matches full analysis for selection and text updates in later blockquote inline ranges", async () => {
    let doc = liveMdKitchenSinkDoc();
    let cases: Array<{ name: string; spec: TransactionSpec }> = [
      {
        name: "selection inside strong",
        spec: { selection: { anchor: doc.indexOf("bold") } },
      },
      {
        name: "insert before inline styles",
        spec: {
          changes: { from: doc.indexOf("Quote") + 2, insert: "X" },
          selection: { anchor: doc.indexOf("Quote") + 3 },
        },
      },
      {
        name: "delete before inline styles",
        spec: {
          changes: { from: doc.indexOf("Quote") + 2, to: doc.indexOf("Quote") + 3 },
          selection: { anchor: doc.indexOf("Quote") + 2 },
        },
      },
      {
        name: "paste before inline styles",
        spec: {
          changes: { from: doc.indexOf("Quote") + 2, insert: "PASTE" },
          selection: { anchor: doc.indexOf("Quote") + 7 },
        },
      },
      {
        name: "insert inside strong",
        spec: {
          changes: { from: doc.indexOf("bold") + 1, insert: "X" },
          selection: { anchor: doc.indexOf("bold") + 2 },
        },
      },
    ];

    for (let testCase of cases) {
      let state = await markdownAnalysisState(doc, doc.indexOf("After anchor"));
      let incremental = state.update(testCase.spec).state;
      let full = __testBuildLiveMdAnalysis(incremental);

      expect(canonicalAnalysis(incremental), testCase.name).toEqual(
        canonicalAnalysis(incremental, full),
      );
    }
  });

  it("matches full analysis when selection enters and leaves rendered Markdown features", async () => {
    let doc = liveMdKitchenSinkDoc();
    let after = doc.indexOf("After anchor");
    let targets = [
      ["paragraph emphasis", doc.indexOf("emphasis")],
      ["inline latex", doc.indexOf("x^2")],
      ["blockquote strong", doc.indexOf("bold")],
      ["task item", doc.indexOf("todo item")],
      ["image", doc.indexOf("Alt image")],
      ["display latex", doc.indexOf("E = mc")],
      ["table row", doc.indexOf("alpha")],
      ["code fence", doc.indexOf("const answer")],
    ] as const;

    for (let [name, target] of targets) {
      let state = await markdownAnalysisState(doc, after);
      let focused = state.update({ selection: { anchor: target } }).state;
      let fullFocused = __testBuildLiveMdAnalysis(focused);

      expect(canonicalAnalysis(focused), `${name} focused`).toEqual(
        canonicalAnalysis(focused, fullFocused),
      );

      let blurred = focused.update({ selection: { anchor: after } }).state;
      let fullBlurred = __testBuildLiveMdAnalysis(blurred);

      expect(canonicalAnalysis(blurred), `${name} blurred`).toEqual(
        canonicalAnalysis(blurred, fullBlurred),
      );
    }
  });

  it("patches document edits without rebuilding untouched mapped line decorations", async () => {
    let doc = "- first\n- second\n- third";
    let state = await markdownAnalysisState(doc, 2);
    let before = lineDecorations(state, state.doc.line(2).from);

    expect(before.length).toBeGreaterThan(0);

    let transaction = state.update({
      changes: { from: 2, to: "first".length + 2, insert: "FIRST!" },
    });
    let after = lineDecorations(transaction.state, transaction.state.doc.line(2).from);

    expect(transaction.state.doc.line(2).from).toBe(state.doc.line(2).from + 1);
    expect(after).toHaveLength(before.length);
    expect(after[0]).toBe(before[0]);
  });

  it("keeps paragraph gap analysis local to the dirty range", async () => {
    let doc = Array.from({ length: 80 }, (_, index) => `paragraph ${index}`).join("\n\n");
    let state = await markdownAnalysisState(doc);
    let editFrom = doc.indexOf("paragraph 70");
    let materializedChildren = 0;
    let descriptor = Object.getOwnPropertyDescriptor(SyntaxNode.prototype, "children")!;

    Object.defineProperty(SyntaxNode.prototype, "children", {
      configurable: true,
      get(this: SyntaxNode) {
        let children = descriptor.get!.call(this) as SyntaxNode[];
        materializedChildren += children.length;
        return children;
      },
    });
    try {
      state
        .update({
          changes: { from: editFrom, to: editFrom + "paragraph".length, insert: "section" },
        })
        .state.field(liveMdAnalysis);
    } finally {
      Object.defineProperty(SyntaxNode.prototype, "children", descriptor);
    }

    expect(materializedChildren).toBeLessThan(50);
  });

  it("patches code fence edits without rebuilding untouched mapped code highlights", async () => {
    let doc = "```ts\nlet a = 1;\n```\n\n```ts\nlet b = 2;\n```\n";
    let state = await markdownAnalysisState(doc);
    state = state.update({
      effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()),
    }).state;
    let secondFenceFrom = state.doc.toString().indexOf("let b");
    let before = decorationsFrom(state, secondFenceFrom);

    expect(before.length).toBeGreaterThan(1);

    let editFrom = doc.indexOf("a = 1");
    let transaction = state.update({
      changes: { from: editFrom, to: editFrom + 1, insert: "aa" },
    });
    let analysis = transaction.state.field(liveMdAnalysis);
    let editedLine = transaction.state.doc.lineAt(editFrom);
    let after = decorationsFrom(transaction.state, secondFenceFrom + 1);

    expect(analysis.expandedDirtyRanges).toEqual([
      { from: editedLine.from, reasons: ["text"], to: editedLine.to },
    ]);
    expect(after).toHaveLength(before.length);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it("tracks query owners and lets affected owners escape the query window", async () => {
    let rows = Array.from({ length: 40 }, (_, index) => `| row ${index} | ${index} |`);
    let doc = ["| Name | Value |", "| --- | ---: |", ...rows, "", "after"].join("\n");
    let state = await markdownAnalysisState(doc, doc.indexOf("after"));
    let editFrom = doc.indexOf("row 30");
    let transaction = state.update({
      changes: { from: editFrom, to: editFrom + "row 30".length, insert: "row thirty" },
    });
    let analysis = transaction.state.field(liveMdAnalysis);
    let tableTo = transaction.state.doc.toString().indexOf("\n\nafter") + 1;
    let snapshots = __testLiveMdOwnerSnapshots(analysis);

    expect(snapshots.owners).toContainEqual({
      from: 0,
      id: expect.any(Number),
      kind: "table",
      to: tableTo,
    });
    expect(snapshots.queryRanges[0]!.from).toBeGreaterThan(0);
    expect(snapshots.affectedRanges).toEqual([{ from: 0, reasons: ["text"], to: tableTo }]);
  });

  it("patches latex edits without rebuilding untouched mapped latex widgets", async () => {
    let doc = "$x$\n\n$y$\n\nnext";
    let state = await markdownAnalysisState(doc, doc.indexOf("next"));
    let secondLatexFrom = doc.indexOf("$y$");
    let before = decorationsFrom(state, secondLatexFrom);

    expect(before.length).toBeGreaterThan(0);

    let editFrom = doc.indexOf("x");
    let transaction = state.update({
      changes: { from: editFrom, to: editFrom + 1, insert: "xx" },
    });
    let analysis = transaction.state.field(liveMdAnalysis);
    let after = decorationsFrom(transaction.state, secondLatexFrom + 1);

    expect(analysis.expandedDirtyRanges).toEqual([{ from: 0, reasons: ["text"], to: 4 }]);
    expect(after).toHaveLength(before.length);
    expect(after[0]).toBe(before[0]);
  });

  it("patches code fence content edits without rebuilding untouched lines in the same fence", async () => {
    let doc = "```ts\nlet a = 1;\nlet b = 2;\n```\n";
    let state = await markdownAnalysisState(doc);
    state = state.update({
      effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()),
    }).state;
    let secondLineFrom = state.doc.lineAt(doc.indexOf("let b")).from;
    let before = decorationsFrom(state, secondLineFrom);

    expect(before.length).toBeGreaterThan(1);

    let editFrom = doc.indexOf("a = 1");
    let transaction = state.update({
      changes: { from: editFrom, to: editFrom + 1, insert: "aa" },
    });
    let analysis = transaction.state.field(liveMdAnalysis);
    let editedLine = transaction.state.doc.lineAt(editFrom);
    let after = decorationsFrom(transaction.state, secondLineFrom + 1);

    expect(analysis.expandedDirtyRanges).toEqual([
      { from: editedLine.from, reasons: ["text"], to: editedLine.to },
    ]);
    expect(after).toHaveLength(before.length);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it("rebuilds code fence lines affected by nested syntax changes", async () => {
    let doc = "```ts\nlet a = 1;\nlet b = 2;\n```\n";
    let state = await markdownAnalysisState(doc);
    state = state.update({
      effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()),
    }).state;
    let secondLineFrom = state.doc.lineAt(doc.indexOf("let b")).from;
    let before = decorationsFrom(state, secondLineFrom);

    expect(before.length).toBeGreaterThan(1);

    let editFrom = doc.indexOf("let a");
    let transaction = state.update({
      changes: { from: editFrom, insert: "/* " },
    });
    let analysis = transaction.state.field(liveMdAnalysis);
    let editedLine = transaction.state.doc.lineAt(editFrom);
    let secondLine = transaction.state.doc.lineAt(secondLineFrom + 3);
    let after = decorationsFrom(transaction.state, secondLineFrom + 3);

    expect(analysis.expandedDirtyRanges).toEqual([
      { from: editedLine.from, reasons: ["text", "syntax"], to: secondLine.to + 1 },
    ]);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]).not.toBe(before[0]);
  });

  it("rebuilds code fence lines affected by nested template syntax changes", async () => {
    let doc = "```ts\nconst a = `one`;\nconst b = 2;\n```\n";
    let state = await markdownAnalysisState(doc);
    state = state.update({
      effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()),
    }).state;
    let secondLineFrom = state.doc.lineAt(doc.indexOf("const b")).from;
    let before = decorationsFrom(state, secondLineFrom);

    expect(before.length).toBeGreaterThan(1);

    let editFrom = doc.indexOf("`;\n");
    let transaction = state.update({
      changes: { from: editFrom, to: editFrom + 1 },
    });
    let analysis = transaction.state.field(liveMdAnalysis);
    let firstLine = transaction.state.doc.lineAt(editFrom);
    let secondLine = transaction.state.doc.lineAt(secondLineFrom - 1);
    let after = decorationsFrom(transaction.state, secondLineFrom - 1);

    expect(analysis.expandedDirtyRanges).toEqual([
      {
        from: firstLine.from,
        reasons: ["text", "syntax"],
        to: secondLine.to,
      },
    ]);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]).not.toBe(before[0]);
  });

  it("parses edited code fences once when collecting nested syntax dirty ranges", async () => {
    let doc = "```ts\nconst a = `one`;\nconst b = 2;\n```\n";
    let parseCalls = 0;
    let state = await markdownAnalysisState(doc);
    let languages = new Map(await loadCodeFenceLanguages());
    let tsParser = languages.get("ts");
    if (!tsParser) throw new Error("TypeScript code fence parser is unavailable");
    languages.set(
      "ts",
      new Proxy(tsParser, {
        get(target, property, receiver) {
          if (property == "parse") {
            return (...args: Parameters<typeof target.parse>) => {
              parseCalls++;
              return target.parse(...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    );
    state = state.update({ effects: setCodeFenceLanguages.of(languages) }).state;
    parseCalls = 0;

    let editFrom = doc.indexOf("`;\n");
    let transaction = state.update({
      changes: { from: editFrom, to: editFrom + 1 },
    });
    transaction.state.field(liveMdAnalysis);

    expect(parseCalls).toBe(1);
  });

  it("reuses the previous code fence tree when reparsing edited code highlights", async () => {
    let doc = "```ts\nlet a = 1;\nlet b = 2;\n```\n";
    let oldTrees: unknown[] = [];
    let state = await markdownAnalysisState(doc);
    let languages = new Map(await loadCodeFenceLanguages());
    let tsParser = languages.get("ts");
    if (!tsParser) throw new Error("TypeScript code fence parser is unavailable");
    languages.set(
      "ts",
      new Proxy(tsParser, {
        get(target, property, receiver) {
          if (property == "parse") {
            return (...args: Parameters<typeof target.parse>) => {
              oldTrees.push(args[1] ?? null);
              return target.parse(...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    );
    state = state.update({ effects: setCodeFenceLanguages.of(languages) }).state;
    oldTrees.length = 0;

    let editFrom = doc.indexOf("a = 1");
    let transaction = state.update({
      changes: { from: editFrom, to: editFrom + 1, insert: "aa" },
    });
    transaction.state.field(liveMdAnalysis);

    expect(oldTrees).toHaveLength(1);
    expect(oldTrees[0]).not.toBe(null);
  });

  it("does not reparse code fence highlights for selection-only code line updates", async () => {
    let doc = "```ts\nlet a = 1;\nlet b = 2;\n```\n";
    let parseCalls = 0;
    let state = await markdownAnalysisState(doc, doc.indexOf("let a"));
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
    parseCalls = 0;
    let secondLine = state.doc.lineAt(doc.indexOf("let b"));
    let beforeSecondLineDecorations = rangeDecorationsInLine(state, secondLine);

    expect(beforeSecondLineDecorations.length).toBeGreaterThan(1);

    let transaction = state.update({
      selection: { anchor: doc.indexOf("let b") },
    });
    let analysis = transaction.state.field(liveMdAnalysis);
    let afterSecondLineDecorations = rangeDecorationsInLine(
      transaction.state,
      transaction.state.doc.lineAt(doc.indexOf("let b")),
    );

    expect(analysis.expandedDirtyRanges).toEqual([
      { from: 6, reasons: ["selection"], to: 16 },
      { from: 17, reasons: ["selection"], to: 27 },
    ]);
    expect(afterSecondLineDecorations.length).toBeGreaterThan(1);
    expect(parseCalls).toBe(0);
  });

  it("keeps code fence highlight trees across selection-only updates", async () => {
    let doc = "```ts\nlet a = 1;\nlet b = 2;\n```\n";
    let oldTrees: unknown[] = [];
    let state = await markdownAnalysisState(doc, doc.indexOf("let a"));
    let languages = new Map(await loadCodeFenceLanguages());
    let tsParser = languages.get("ts");
    if (!tsParser) throw new Error("TypeScript code fence parser is unavailable");
    languages.set(
      "ts",
      new Proxy(tsParser, {
        get(target, property, receiver) {
          if (property == "parse") {
            return (...args: Parameters<typeof target.parse>) => {
              oldTrees.push(args[1] ?? null);
              return target.parse(...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    );
    state = state.update({ effects: setCodeFenceLanguages.of(languages) }).state;
    oldTrees.length = 0;

    state = state.update({ selection: { anchor: doc.indexOf("let b") } }).state;
    state.field(liveMdAnalysis);

    let editFrom = doc.indexOf("a = 1");
    let transaction = state.update({
      changes: { from: editFrom, to: editFrom + 1, insert: "aa" },
    });
    transaction.state.field(liveMdAnalysis);

    expect(oldTrees).toHaveLength(1);
    expect(oldTrees[0]).not.toBe(null);
  });
});

function analysisState(doc: string, selection = 0) {
  return EditorState.create({
    doc,
    selection: { anchor: selection },
    extensions: [codeFenceLanguagesField, liveMdAnalysis],
  });
}

async function markdownAnalysisState(doc: string, selection = 0) {
  return EditorState.create({
    doc,
    selection: { anchor: selection },
    extensions: [codeFenceLanguagesField, liveMdAnalysis, await loadMarkdownExtension()],
  });
}

function liveMdKitchenSinkDoc() {
  return (
    "# Heading One\n\n" +
    "Paragraph with _emphasis_, **strong**, ~~strike~~, `code`, [link](https://example.com), <https://example.com>, $x^2$.\n\n" +
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

function lineDecorations(state: EditorState, pos: number) {
  let values: Decoration[] = [];
  state.field(liveMdAnalysis).decorations.between(pos, pos, (from, to, value) => {
    if (from == pos && to == pos) values.push(value);
  });
  return values;
}

function rangeDecorationsInLine(state: EditorState, line: { from: number; to: number }) {
  let values: Decoration[] = [];
  state.field(liveMdAnalysis).decorations.between(line.from, line.to, (from, to, value) => {
    if (from < to) values.push(value);
  });
  return values;
}

function decorationsFrom(state: EditorState, pos: number) {
  let values: Decoration[] = [];
  state.field(liveMdAnalysis).decorations.between(pos, state.doc.length, (from, _to, value) => {
    if (from >= pos) values.push(value);
  });
  return values;
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
