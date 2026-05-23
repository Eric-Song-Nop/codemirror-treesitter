import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  TreeSitterLanguage,
  TreeSitterParser,
  getIndentUnit,
  getIndentation,
  indentString,
  indentUnit,
} from "../src/index.js";

const javascriptWasm = new URL(
  "../../../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
  import.meta.url,
).pathname;

let javascriptParser: Promise<TreeSitterParser> | null = null;

async function javascriptState(doc: string) {
  javascriptParser ??= TreeSitterParser.load(javascriptWasm);
  let language = TreeSitterLanguage.define({
    name: "javascript",
    parser: await javascriptParser,
  });
  return EditorState.create({ doc, extensions: [language.extension] });
}

describe("indent helpers", () => {
  it("uses configured indentation units", () => {
    let state = EditorState.create({
      extensions: [indentUnit.of("\t")],
    });

    expect(getIndentUnit(state)).toBe(state.tabSize);
    expect(indentString(state, state.tabSize + 2)).toBe("\t  ");
  });

  it("uses the outer reference line when a node starts after a multiline sibling", async () => {
    let doc = "const value = tag`one\n  two` + [\nvalue\n];\n";
    let state = await javascriptState(doc);
    let valueLine = state.doc.lineAt(doc.indexOf("value", doc.indexOf("[")));

    expect(getIndentation(state, valueLine.from)).toBe(2);
  });
});
