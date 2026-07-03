import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, type Tree } from "@codemirror-treesitter/language";
import { describe, expect, it } from "vite-plus/test";
import {
  collectMarkdownBlocksInRanges,
  walkMarkdownBlocks,
} from "../src/core/analysis/markdown-block-cursor.js";
import { loadMarkdownExtension } from "../src/core/languages.js";

describe("LiveMD Markdown block cursor", () => {
  it("classifies block leaves with production TreeCursor traversal", async () => {
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
    let snapshot = walkMarkdownBlocks(markdownTree(state), state.doc).snapshot;

    expect(snapshot.leaves.map((leaf) => leaf.kind)).toEqual([
      "heading",
      "heading",
      "paragraph",
      "table",
      "fencedCode",
      "indentedCode",
      "html",
      "rule",
    ]);
    let setext = snapshot.leaves.find((leaf) =>
      state.doc.sliceString(leaf.range.from, leaf.range.to).includes("Setext"),
    );
    expect(setext?.kind).toBe("heading");
    expect(
      snapshot.leaves.filter(
        (leaf) =>
          leaf.kind == "paragraph" &&
          leaf.range.from >= setext!.range.from &&
          leaf.range.to <= setext!.range.to,
      ),
    ).toEqual([]);
  });

  it("records marker-only edit lines without assigning blank-line ownership", async () => {
    let cases = ["-", "- ", "- [ ]", "- [ ] ", ">", "> ", "> - ", "> - [ ] "];

    for (let doc of cases) {
      let state = await markdownState(doc);
      let snapshot = walkMarkdownBlocks(markdownTree(state), state.doc).snapshot;

      expect(snapshot.markers.length, doc).toBeGreaterThan(0);
      expect(
        snapshot.markers.every((marker) => marker.lineRange.from == 0),
        doc,
      ).toBe(true);
      expect(
        snapshot.leaves.every((leaf) => leaf.sourceRange.from == 0),
        doc,
      ).toBe(true);
      expect(
        snapshot.leaves.every((leaf) => leaf.sourceRange.to <= doc.length),
        doc,
      ).toBe(true);
    }

    let blank = await markdownState("one\n\n");
    let blankSnapshot = walkMarkdownBlocks(markdownTree(blank), blank.doc).snapshot;
    expect(blankSnapshot.markers).toEqual([]);
    expect(
      blankSnapshot.leaves.map((leaf) =>
        blank.doc.sliceString(leaf.sourceRange.from, leaf.sourceRange.to),
      ),
    ).toEqual(["one"]);
  });

  it("captures structured quote, list, and task marker ownership", async () => {
    let doc = "> - [ ] parent\n>   - child\n";
    let state = await markdownState(doc);
    let snapshot = walkMarkdownBlocks(markdownTree(state), state.doc).snapshot;

    expect(
      snapshot.leaves.map((leaf) => state.sliceDoc(leaf.sourceRange.from, leaf.sourceRange.to)),
    ).toEqual(["> - [ ] parent", ">   - child"]);
    expect(snapshot.leaves.map((leaf) => leaf.context.quoteDepth)).toEqual([1, 1]);
    expect(snapshot.leaves.map((leaf) => leaf.context.quoteMarkers.length)).toEqual([1, 1]);
    expect(snapshot.leaves.map((leaf) => leaf.context.listPath.length)).toEqual([1, 2]);
    expect(snapshot.leaves[0]?.context.listPath[0]?.task?.checked).toBe(false);
    expect(snapshot.markers.map((marker) => marker.kind)).toEqual([
      "quoteMarker",
      "listMarker",
      "taskMarker",
      "continuation",
      "listMarker",
    ]);
  });

  it("keeps block marker text inside non-paragraph leaves", async () => {
    let doc = "```md\n- literal list marker\n> literal quote marker\n```\n";
    let state = await markdownState(doc);
    let snapshot = walkMarkdownBlocks(markdownTree(state), state.doc).snapshot;
    let leaf = snapshot.leaves[0]!;

    expect(leaf.kind).toBe("fencedCode");
    expect(state.sliceDoc(leaf.sourceRange.from, leaf.sourceRange.to)).toBe(doc.trimEnd());
  });

  it("walks large paragraph, list, and quote documents with sorted ownership", async () => {
    let paragraphDoc = Array.from({ length: 10_000 }, (_, index) => `paragraph ${index}`).join(
      "\n\n",
    );
    let paragraph = await markdownState(paragraphDoc);
    let paragraphWalk = walkMarkdownBlocks(markdownTree(paragraph), paragraph.doc);

    expect(paragraphWalk.snapshot.leaves).toHaveLength(10_000);
    expect(paragraphWalk.snapshot.markers).toHaveLength(0);

    let listDoc = Array.from({ length: 10_000 }, (_, index) => `- item ${index}`).join("\n");
    let list = await markdownState(listDoc);
    let listWalk = walkMarkdownBlocks(markdownTree(list), list.doc);

    expect(listWalk.snapshot.leaves).toHaveLength(10_000);
    expect(listWalk.snapshot.markers.filter((marker) => marker.kind == "listMarker")).toHaveLength(
      10_000,
    );

    let quoteDoc = Array.from({ length: 10_000 }, (_, index) => `> quote ${index}\n>`).join("\n");
    let quote = await markdownState(quoteDoc);
    let quoteWalk = walkMarkdownBlocks(markdownTree(quote), quote.doc);

    expect(quoteWalk.snapshot.leaves).toHaveLength(10_000);
    expect(
      quoteWalk.snapshot.markers.filter(
        (marker) => marker.kind == "quoteMarker" || marker.kind == "continuation",
      ),
    ).toHaveLength(20_000);
  });

  it("uses range-local cursor traversal without losing marker context", async () => {
    let doc = "- item 0\n- item 1\n- item 2\n";
    let state = await markdownState(doc);
    let target = doc.indexOf("item 1");
    let result = collectMarkdownBlocksInRanges(markdownTree(state), state.doc, [
      { from: target, to: target + "item 1".length },
    ]);

    expect(
      result.snapshot.leaves.map((leaf) =>
        state.sliceDoc(leaf.sourceRange.from, leaf.sourceRange.to),
      ),
    ).toEqual(["- item 1"]);
    expect(result.snapshot.leaves[0]?.context.listPath[0]?.markerText).toBe("-");
    expect(
      result.snapshot.markers.map((marker) => state.sliceDoc(marker.range.from, marker.range.to)),
    ).toEqual(["- "]);
    expect(result.trace.visitedBlockNodes).toBeLessThan(30);
  });

  it("collects range-local quote markers from the touched physical line", async () => {
    let doc = "> quote 0\n\n> quote 1\n\n";
    let state = await markdownState(doc);
    let target = doc.indexOf("quote 1") + 2;
    let result = collectMarkdownBlocksInRanges(markdownTree(state), state.doc, [
      { from: target, to: target + 1 },
    ]);

    expect(
      result.snapshot.leaves.map((leaf) =>
        state.sliceDoc(leaf.sourceRange.from, leaf.sourceRange.to),
      ),
    ).toEqual(["> quote 1"]);
    expect(
      result.snapshot.markers.map((marker) => ({
        depth: marker.context.quoteDepth,
        kind: marker.kind,
        line: state.sliceDoc(marker.lineRange.from, marker.lineRange.to),
        text: state.sliceDoc(marker.range.from, marker.range.to).trim(),
      })),
    ).toEqual([{ depth: 1, kind: "quoteMarker", line: "> quote 1", text: ">" }]);
    expect(result.snapshot.leaves[0]?.context.quoteDepth).toBe(1);
    expect(
      result.snapshot.leaves[0]?.context.quoteMarkers.map((range) =>
        state.sliceDoc(range.from, range.to).trim(),
      ),
    ).toEqual([">"]);
    expect(result.trace.visitedBlockNodes).toBeLessThan(40);
  });

  it("keeps nested range-local quote marker ownership scoped by depth", async () => {
    let doc = "> outer\n\n> > nested\n\n> tail\n";
    let state = await markdownState(doc);
    let target = doc.indexOf("nested") + 2;
    let result = collectMarkdownBlocksInRanges(markdownTree(state), state.doc, [
      { from: target, to: target + 1 },
    ]);

    expect(
      result.snapshot.leaves.map((leaf) =>
        state.sliceDoc(leaf.sourceRange.from, leaf.sourceRange.to),
      ),
    ).toEqual(["> > nested"]);
    expect(
      result.snapshot.markers.map((marker) => ({
        depth: marker.context.quoteDepth,
        kind: marker.kind,
        line: state.sliceDoc(marker.lineRange.from, marker.lineRange.to),
        text: state.sliceDoc(marker.range.from, marker.range.to).trim(),
      })),
    ).toEqual([
      { depth: 1, kind: "quoteMarker", line: "> > nested", text: ">" },
      { depth: 2, kind: "quoteMarker", line: "> > nested", text: ">" },
    ]);
    expect(result.snapshot.leaves[0]?.context.quoteDepth).toBe(2);
    expect(
      result.snapshot.leaves[0]?.context.quoteMarkers.map((range) =>
        state.sliceDoc(range.from, range.to).trim(),
      ),
    ).toEqual([">"]);
    expect(result.trace.visitedBlockNodes).toBeLessThan(50);
  });
});

async function markdownState(doc: string) {
  let state = EditorState.create({
    doc,
    extensions: [await loadMarkdownExtension()],
  });
  expect(ensureSyntaxTree(state, doc.length, 30_000)).not.toBe(null);
  return state;
}

function markdownTree(state: EditorState): Tree {
  let tree = ensureSyntaxTree(state, state.doc.length, 30_000);
  expect(tree).not.toBe(null);
  return tree!;
}
