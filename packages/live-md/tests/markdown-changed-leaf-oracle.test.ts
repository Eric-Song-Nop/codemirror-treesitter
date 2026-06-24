import { EditorState, type ChangeSpec, type Transaction } from "@codemirror/state";
import {
  ensureSyntaxTree,
  syntaxTree,
  syntaxTreeChangedRanges,
} from "@codemirror-treesitter/language";
import { describe, expect, it } from "vite-plus/test";
import {
  findChangedMarkdownLeaves,
  walkMarkdownLeaves,
  type MarkdownChangedLeafResult,
} from "../src/core/analysis/markdown-leaf-spike.js";
import { loadMarkdownExtension } from "../src/core/languages.js";

describe("LiveMD changed-leaf oracle", () => {
  it("classifies block leaves with a full TreeCursor walk", async () => {
    let doc = [
      "# ATX",
      "",
      "Setext",
      "======",
      "",
      "paragraph",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```ts",
      "let value = 1;",
      "```",
      "",
      "    indented",
      "",
      "<div>html</div>",
      "",
      "---",
    ].join("\n");
    let state = await markdownState(doc);
    let leaves = walkMarkdownLeaves(syntaxTree(state), state.doc).leaves;

    expect(leaves.map((leaf) => leaf.kind)).toEqual([
      "heading",
      "heading",
      "paragraph",
      "table",
      "fencedCode",
      "indentedCode",
      "html",
      "rule",
    ]);
    let setext = leaves.find((leaf) =>
      state.doc.sliceString(leaf.from, leaf.to).includes("Setext"),
    );
    expect(setext?.kind).toBe("heading");
    expect(
      leaves.filter(
        (leaf) => leaf.kind == "paragraph" && leaf.from >= setext!.from && leaf.to <= setext!.to,
      ),
    ).toEqual([]);
  });

  it("preserves the range-local leaf discovery contract across planned correctness cases", async () => {
    let cases: Array<{ changes: ChangeSpec; name: string; oldDoc: string }> = [
      {
        name: "paragraph ordinary input",
        oldDoc: "alpha\n\nbeta\n",
        changes: { from: "alpha\n\nbeta".length, insert: "!" },
      },
      {
        name: "soft line break",
        oldDoc: "alpha\nbeta\n",
        changes: { from: "alpha\nbeta".length, insert: "!" },
      },
      {
        name: "paragraph split",
        oldDoc: "alpha beta\n",
        changes: { from: "alpha".length, insert: "\n\n" },
      },
      {
        name: "paragraph merge",
        oldDoc: "alpha\n\nbeta\n",
        changes: { from: "alpha".length, to: "alpha\n\n".length, insert: " " },
      },
      {
        name: "ATX to setext heading",
        oldDoc: "# Title\n",
        changes: { from: 0, to: "# Title\n".length, insert: "Title\n=====\n" },
      },
      {
        name: "thematic break ambiguity",
        oldDoc: "---\n",
        changes: { from: 0, to: "---\n".length, insert: "not ---\n" },
      },
      {
        name: "nested task list marker",
        oldDoc: "- [ ] task\n  - child\n",
        changes: { from: "- [".length, to: "- [ ]".length, insert: "x]" },
      },
      {
        name: "lazy blockquote continuation",
        oldDoc: "> quote\ncontinued\n",
        changes: { from: "> quote\ncontinued".length, insert: "!" },
      },
      {
        name: "table break",
        oldDoc: "| A | B |\n| - | - |\n| 1 | 2 |\n",
        changes: { from: "| A | B |\n".length + 2, to: "| A | B |\n| -".length, insert: "no" },
      },
      {
        name: "fence close",
        oldDoc: "```ts\nlet value = 1;\n```\n",
        changes: {
          from: "```ts\nlet value = 1;\n".length,
          to: "```ts\nlet value = 1;\n```".length,
        },
      },
      {
        name: "unclosed fence",
        oldDoc: "```ts\nlet value = 1;\n",
        changes: { from: "```ts\n".length, insert: "let other = 2;\n" },
      },
      {
        name: "HTML block blank-line termination",
        oldDoc: "<div>\ncontent\n</div>\n\nparagraph\n",
        changes: { from: "<div>\ncontent\n</div>".length, insert: "\nextra" },
      },
      {
        name: "multiple selections",
        oldDoc: "one\n\ntwo\n\nthree\n",
        changes: [
          { from: 0, insert: "1 " },
          { from: "one\n\ntwo\n\n".length, insert: "3 " },
        ],
      },
      {
        name: "CRLF Unicode multi-change",
        oldDoc: "alpha\r\n\r\nβeta\r\n\r\nemoji 😀\r\n",
        changes: [
          { from: "alpha\n\nβ".length, insert: "λ" },
          {
            from: "alpha\n\nβeta\n\nemoji ".length,
            to: "alpha\n\nβeta\n\nemoji 😀".length,
            insert: "🚀",
          },
        ],
      },
    ];

    for (let testCase of cases) {
      expectGateBPass(await analyzeEdit(testCase.oldDoc, testCase.changes), testCase.name);
    }
  });

  it("matches the full-walk oracle for redo and undo directions", async () => {
    let state = await markdownState("alpha\n\nbeta\n");
    let redo = state.update({ changes: { from: "alpha".length, insert: "\n\nnew" } });
    expectGateBPass(await analyzeTransaction(state, redo), "redo");

    let undo = redo.state.update({
      changes: { from: "alpha".length, to: "alpha\n\nnew".length },
    });
    expectGateBPass(await analyzeTransaction(redo.state, undo), "undo");
  });

  it("does not use the diagnostic source hash as the sole leaf identity", async () => {
    let oldText = "CVq1CTQB";
    let newText = "W5WFUDaR";
    let state = await markdownState(`${oldText}\n`);
    let transaction = state.update({
      changes: { from: 0, to: oldText.length, insert: newText },
    });
    let result = await analyzeTransaction(state, transaction);
    let oldLeaf = walkMarkdownLeaves(syntaxTree(state), state.doc).leaves[0]!;
    let newLeaf = result.oracleLeaves[0]!;

    expect(oldLeaf.sourceHash).toBe(newLeaf.sourceHash);
    expect(oldLeaf.sourceText).toBe(`${oldText}\n`);
    expect(newLeaf.sourceText).toBe(`${newText}\n`);
    expectGateBPass(result, "source hash collision");
    expect(result.changedLeaves).toHaveLength(1);
  });

  it("matches the full-walk oracle for deterministic random edits", async () => {
    let doc = [
      "# Heading",
      "",
      "Paragraph with **strong** text.",
      "",
      "- [ ] task",
      "  - child",
      "",
      "> quote",
      "continued",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```js",
      "let value = 1;",
      "```",
      "",
      "<div>html</div>",
    ].join("\n");
    let random = seededRandom(67);

    for (let index = 0; index < 40; index++) {
      let state = await markdownState(doc);
      let from = Math.floor(random() * (doc.length + 1));
      let maxDelete = Math.min(4, doc.length - from);
      let deleted = Math.floor(random() * (maxDelete + 1));
      let inserts = ["", "x", "\n", "\n\n", "- ", "> ", "`", "|"];
      let insert = inserts[Math.floor(random() * inserts.length)]!;
      let transaction = state.update({ changes: { from, to: from + deleted, insert } });
      let result = await analyzeTransaction(state, transaction);

      expectGateBPass(result, `random edit ${index}`);
      doc = transaction.state.doc.toString();
    }
  });

  it("keeps a 10,000 paragraph single-character edit leaf-local", async () => {
    let doc =
      Array.from({ length: 10_000 }, (_, index) => `paragraph ${index}`).join("\n\n") + "\n";
    let target = doc.indexOf("paragraph 5000") + "paragraph 5000".length;
    let result = await analyzeEdit(doc, { from: target, insert: "!" });

    expectGateBPass(result, "10k paragraphs");
    expect(result.changedLeaves).toHaveLength(1);
    expect(result.trace.collectedLeaves).toBe(1);
    expect(result.trace.visitedBlockNodes).toBeLessThan(100);
    expect(result.trace.fallbackCount).toBe(0);
  });

  it("jumps into the middle of 10,000 list items", async () => {
    let doc = Array.from({ length: 10_000 }, (_, index) => `- item ${index}`).join("\n") + "\n";
    let target = doc.indexOf("item 5000") + "item 5000".length;
    let result = await analyzeEdit(doc, { from: target, insert: "!" });

    expectGateBPass(result, "10k list items");
    expect(result.changedLeaves).toHaveLength(1);
    expect(result.trace.visitedBlockNodes).toBeLessThan(160);
    expect(result.trace.fallbackCount).toBe(0);
  });

  it("does not process an entire 10,000 paragraph blockquote", async () => {
    let doc = Array.from({ length: 10_000 }, (_, index) => `> quote ${index}\n>`).join("\n") + "\n";
    let target = doc.indexOf("quote 5000") + "quote 5000".length;
    let result = await analyzeEdit(doc, { from: target, insert: "!" });

    expectGateBPass(result, "10k quote paragraphs");
    expect(result.changedLeaves).toHaveLength(1);
    expect(result.trace.visitedBlockNodes).toBeLessThan(180);
    expect(result.trace.fallbackCount).toBe(0);
  }, 60_000);
});

async function analyzeEdit(oldDoc: string, changes: ChangeSpec) {
  let state = await markdownState(oldDoc);
  let transaction = state.update({ changes });
  return analyzeTransaction(state, transaction);
}

async function analyzeTransaction(state: EditorState, transaction: Transaction) {
  let oldTree = ensureSyntaxTree(state, state.doc.length, 30_000);
  let newTree = ensureSyntaxTree(transaction.state, transaction.state.doc.length, 30_000);
  expect(oldTree).not.toBe(null);
  expect(newTree).not.toBe(null);
  return findChangedMarkdownLeaves({
    changes: transaction.changes,
    newDoc: transaction.state.doc,
    newTree: newTree!,
    oldDoc: state.doc,
    oldTree: oldTree!,
    syntaxChangedRanges: syntaxTreeChangedRanges(transaction),
  });
}

async function markdownState(doc: string) {
  let state = EditorState.create({
    doc,
    extensions: [await loadMarkdownExtension()],
  });
  expect(ensureSyntaxTree(state, doc.length, 30_000)).not.toBe(null);
  return state;
}

function expectGateBPass(result: MarkdownChangedLeafResult, label: string) {
  expect(result.correct, `${label}: local changed leaves must match full-walk oracle`).toBe(true);
  expect(result.trace.fallbackCount, `${label}: no full-walk fallback`).toBe(0);
  expect(result.changedLeaves.map(summaryLeaf), `${label}: changed leaf summary`).toEqual(
    result.oracleChangedLeaves.map(summaryLeaf),
  );
}

function summaryLeaf(leaf: { contextKey: string; from: number; kind: string; to: number }) {
  return `${leaf.kind}:${leaf.from}-${leaf.to}:${leaf.contextKey}`;
}

function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}
