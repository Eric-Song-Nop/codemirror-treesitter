import { EditorSelection, EditorState } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { TreeSitterLanguage, TreeSitterParser } from "@codemirror-treesitter/language";
import { closeBrackets, insertBracket } from "../src/index.js";

// Same grammar asset and loading pattern as packages/language/tests.
const javascriptWasm = new URL(
  "../../../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
  import.meta.url,
).pathname;

let javascript: TreeSitterLanguage;

beforeAll(async () => {
  javascript = TreeSitterLanguage.define({
    name: "javascript",
    parser: await TreeSitterParser.load(javascriptWasm),
    languageData: { closeBrackets: { brackets: ["(", "[", "{", "'", '"', "`"] } },
  });
});

function stateAt(doc: string, marker = "|") {
  let pos = doc.indexOf(marker);
  return EditorState.create({
    doc: doc.slice(0, pos) + doc.slice(pos + marker.length),
    selection: EditorSelection.cursor(pos),
    extensions: [javascript.extension, closeBrackets()],
  });
}

function typed(doc: string, bracket: string) {
  let tr = insertBracket(stateAt(doc), bracket);
  return tr ? tr.state.doc.toString() : null;
}

describe("close brackets with the JavaScript grammar", () => {
  it("inserts a closing quote outside a string literal", () => {
    expect(typed("let s = |;", '"')).toBe('let s = "";');
    expect(typed("f(|);", "'")).toBe("f('');");
  });

  it("does not insert a closing quote inside a string literal", () => {
    expect(typed('let s = "ab | cd";', '"')).toBeNull();
    expect(typed("let s = 'ab | cd';", "'")).toBeNull();
    expect(typed('let s = "a\\n | b";', '"')).toBeNull();
  });

  it("treats template literal text as a string but not its substitutions", () => {
    expect(typed("let t = `ab | cd`;", "`")).toBeNull();
    expect(typed("let t = `ab | cd`;", '"')).toBe('let t = `ab "" cd`;');
    expect(typed("let t = `a ${|} b`;", '"')).toBe('let t = `a ${""} b`;');
  });

  it("inserts a quote pair directly before an existing string", () => {
    expect(typed('f(|"abc");', '"')).toBe('f("""abc");');
  });

  it("steps over an auto-inserted closing quote", () => {
    let first = insertBracket(stateAt("let s = |;"), '"')!.state;
    let second = insertBracket(first, '"');
    expect(second?.state.doc.toString()).toBe('let s = "";');
    expect(second?.state.selection.main.head).toBe('let s = ""'.length);
  });
});
