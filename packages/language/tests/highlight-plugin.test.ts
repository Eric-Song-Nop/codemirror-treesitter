// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  TreeSitterLanguage,
  TreeSitterParser,
  syntaxHighlighting,
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
