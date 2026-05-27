import { Compartment, EditorState } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { describe, expect, it } from "vite-plus/test";
import { liveMdAnalysis } from "../src/core/decorations.js";
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

    let transaction = state.update({
      selection: { anchor: doc.indexOf("let b") },
    });
    let analysis = transaction.state.field(liveMdAnalysis);

    expect(analysis.expandedDirtyRanges).toEqual([
      { from: 6, reasons: ["selection"], to: 16 },
      { from: 17, reasons: ["selection"], to: 27 },
    ]);
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

function lineDecorations(state: EditorState, pos: number) {
  let values: Decoration[] = [];
  state.field(liveMdAnalysis).decorations.between(pos, pos, (from, to, value) => {
    if (from == pos && to == pos) values.push(value);
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
