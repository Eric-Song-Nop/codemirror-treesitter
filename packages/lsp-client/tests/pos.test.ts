import { Text } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { fromPosition, toPosition } from "../src/pos.js";

describe("LSP positions", () => {
  it("converts between document offsets and LSP positions", () => {
    let doc = Text.of(["alpha", "beta", "gamma"]);
    let offset = doc.line(2).from + 2;

    expect(toPosition(doc, offset)).toEqual({ line: 1, character: 2 });
    expect(fromPosition(doc, { line: 1, character: 2 })).toBe(offset);
  });
});
