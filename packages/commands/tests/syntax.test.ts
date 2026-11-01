import {
  EditorSelection,
  EditorState,
  type StateCommand,
  type Transaction,
} from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import {
  TreeSitterLanguage,
  TreeSitterParser,
  delimitedIndent,
  indentNodeProp,
} from "@codemirror-treesitter/language";
import { insertNewlineAndIndent, selectParentSyntax } from "../src/index.js";

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
    // Mirrors the block indentation props packages/language-data uses.
    props: [indentNodeProp.add({ statement_block: delimitedIndent({ closing: "}" }) })],
  });
});

function jsState(doc: string, anchor: number, head = anchor) {
  return EditorState.create({
    doc,
    selection: EditorSelection.range(anchor, head),
    extensions: [javascript.extension],
  });
}

function run(state: EditorState, command: StateCommand) {
  let next = state;
  let ran = command({
    state,
    dispatch: (tr: Transaction) => {
      next = tr.state;
    },
  });
  return { ran, state: next };
}

function selected(state: EditorState) {
  let { from, to } = state.selection.main;
  return state.sliceDoc(from, to);
}

describe("syntax-aware commands with the JavaScript grammar", () => {
  it("selectParentSyntax expands from a call argument to the call, then the statement", () => {
    let doc = "foo(bar, baz);\nnext();\n";
    let state = jsState(doc, doc.indexOf("bar") + 1);

    let steps: string[] = [];
    for (let i = 0; i < 4; i++) {
      let result = run(state, selectParentSyntax);
      if (!result.ran) break;
      state = result.state;
      steps.push(selected(state));
    }

    expect(steps.slice(0, 4)).toEqual(["bar", "(bar, baz)", "foo(bar, baz)", "foo(bar, baz);"]);
  });

  it("insertNewlineAndIndent explodes an empty block between `{` and `}`", () => {
    let doc = "function f() { }\n";
    let state = jsState(doc, doc.indexOf("{") + 1);

    let result = run(state, insertNewlineAndIndent);
    expect(result.ran).toBe(true);
    expect(result.state.doc.toString()).toBe("function f() {\n  \n}\n");
    expect(result.state.selection.main.head).toBe("function f() {\n  ".length);
  });

  it("insertNewlineAndIndent explodes adjacent brackets", () => {
    let doc = "if (x) {}\n";
    let state = jsState(doc, doc.indexOf("{") + 1);

    let result = run(state, insertNewlineAndIndent);
    expect(result.state.doc.toString()).toBe("if (x) {\n  \n}\n");
  });
});
