import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { Chunk, getChunks, unifiedMergeView } from "../src/index.js";

describe("merge chunks", () => {
  it("enumerates changed chunks by line", () => {
    let docA = Text.of(["line 1", "line 2", "line 3", "line 4"]);
    let docB = Text.of(["line 1", "line two", "line 3", "extra", "line 4"]);
    let chunks = Chunk.build(docA, docB);

    expect(chunks).toHaveLength(2);
    expect([chunks[0]!.fromA, chunks[0]!.toA]).toEqual([docA.line(2).from, docA.line(3).from]);
    expect([chunks[0]!.fromB, chunks[0]!.toB]).toEqual([docB.line(2).from, docB.line(3).from]);
    expect([chunks[1]!.fromA, chunks[1]!.toA]).toEqual([docA.line(4).from, docA.line(4).from]);
    expect([chunks[1]!.fromB, chunks[1]!.toB]).toEqual([docB.line(4).from, docB.line(5).from]);
  });

  it("updates chunks after document edits", () => {
    let stateA = EditorState.create({ doc: "a\nb\nc\n" });
    let stateB = EditorState.create({ doc: "a\nB\nc\n" });
    let chunks = Chunk.build(stateA.doc, stateB.doc);
    let tr = stateA.update({
      changes: { from: stateA.doc.line(2).from, to: stateA.doc.line(2).to, insert: "B" },
    });

    expect(Chunk.updateA(chunks, tr.newDoc, stateB.doc, tr.changes)).toHaveLength(0);
  });

  it("initializes unified merge state with the original document", () => {
    let state = EditorState.create({
      doc: "let value = 2;\n",
      extensions: [unifiedMergeView({ original: "let value = 1;\n" })],
    });
    let info = getChunks(state);

    expect(info?.side).toBe("b");
    expect(info?.chunks.length).toBe(1);
  });
});
