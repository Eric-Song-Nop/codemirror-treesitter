// @vitest-environment happy-dom

import { EditorState, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  TreeSitterLanguage,
  TreeSitterParser,
  classHighlighter,
  forceParsing,
  syntaxHighlighting,
  syntaxTree,
  syntaxTreeAvailable,
  tags,
  type Highlighter,
} from "../src/index.js";

const javascriptWasm = new URL(
  "../../../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
  import.meta.url,
).pathname;

let javascriptParser: Promise<TreeSitterParser> | null = null;
let locationDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  document.body.replaceChildren();
  if (locationDescriptor) {
    Object.defineProperty(globalThis, "location", locationDescriptor);
  }
});

describe("syntax highlighting view plugin", () => {
  it("keeps untouched highlight decorations across same-shape text edits", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    let javascript = TreeSitterLanguage.define({
      name: "javascript",
      parser: await javascriptParser,
    });
    let highlighter = changingVariableHighlighter();
    let view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({
        doc: "let first = 1;\nlet second = 2;\n",
        extensions: [javascript.extension, syntaxHighlighting(highlighter)],
      }),
    });
    let before = classNameForText(view, "second");

    view.dispatch({
      changes: { from: "let ".length, to: "let first".length, insert: "other" },
    });

    expect(classNameForText(view, "second")).toBe(before);
    view.destroy();
  });
});

describe("syntax highlighting while a reparse is in flight", () => {
  it("keeps keyword decorations while the parse misses its budget", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    let javascript = TreeSitterLanguage.define({
      name: "javascript",
      parser: await javascriptParser,
    });
    let doc = Array.from({ length: 300 }, (_, index) => `let value${index} = ${index};`).join("\n");
    let view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({
        doc,
        extensions: [javascript.extension, syntaxHighlighting(classHighlighter)],
      }),
    });
    // The initial parse budget is short; on a cold runner it may not finish in
    // time, so complete it explicitly before counting decorations.
    expect(forceParsing(view, view.state.doc.length, 5_000)).toBe(true);
    let before = view.contentDOM.querySelectorAll(".tok-keyword").length;
    expect(before).toBeGreaterThan(0);

    let parseWith = javascript.parser.parseWith.bind(javascript.parser);
    Object.defineProperty(javascript.parser, "parseWith", {
      configurable: true,
      value: (
        nativeParser: Parameters<TreeSitterParser["parseWith"]>[0],
        parseDoc: Text,
        oldTree: Parameters<TreeSitterParser["parseWith"]>[2],
        _shouldStop?: () => boolean,
        ranges?: Parameters<TreeSitterParser["parseWith"]>[4],
      ) => parseWith(nativeParser, parseDoc, oldTree, () => true, ranges),
    });
    view.dispatch({ changes: { from: 0, insert: "/*" } });

    expect(syntaxTreeAvailable(view.state)).toBe(false);
    expect(syntaxTree(view.state).type.name).toBe("program");
    expect(view.contentDOM.querySelectorAll(".tok-keyword").length).toBe(before);
    view.destroy();
  });

  it("reuses one native parser across edits and deletes it on view destroy", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    let javascript = TreeSitterLanguage.define({
      name: "javascript",
      parser: await javascriptParser,
    });
    let createParser = javascript.parser.createParser.bind(javascript.parser);
    let created = 0;
    let deleted = 0;
    Object.defineProperty(javascript.parser, "createParser", {
      configurable: true,
      value: () => {
        let parser = createParser();
        created++;
        let deleteParser = parser.delete.bind(parser);
        parser.delete = () => {
          deleted++;
          deleteParser();
        };
        return parser;
      },
    });
    let view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({ doc: "let a = 1;\n", extensions: [javascript.extension] }),
    });
    for (let index = 0; index < 5; index++) {
      view.dispatch({ changes: { from: 0, insert: `let x${index} = ${index};\n` } });
    }
    expect(syntaxTree(view.state).topNode.childCount).toBe(6);
    expect(created).toBe(1);
    expect(deleted).toBe(0);
    view.destroy();
    expect(deleted).toBe(1);
  });
});

function changingVariableHighlighter(): Highlighter {
  let calls = 0;
  return {
    style(tagSet) {
      return tagSet.includes(tags.variableName) ? `dynamic-var-${++calls}` : null;
    },
  };
}

function classNameForText(view: EditorView, text: string) {
  let span = Array.from(view.contentDOM.querySelectorAll("span")).find(
    (element) => element.textContent == text,
  );
  return span?.className;
}
