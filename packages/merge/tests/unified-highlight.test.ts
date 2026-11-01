// @vitest-environment happy-dom

import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  TreeSitterLanguage,
  TreeSitterParser,
  syntaxHighlighting,
  tagHighlighter,
  tags,
} from "@codemirror-treesitter/language";
import { unifiedMergeView } from "../src/index.js";

const javascriptWasm = new URL(
  "../../../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
  import.meta.url,
).pathname;

let javascriptParser: Promise<TreeSitterParser> | null = null;
let locationDescriptor: PropertyDescriptor | undefined;

// Loaded inside each test, after the location workaround below is active.
async function javascriptLanguage() {
  javascriptParser ??= TreeSitterParser.load(javascriptWasm);
  return TreeSitterLanguage.define({ name: "javascript", parser: await javascriptParser });
}

// Same workaround as packages/language/tests/highlight-plugin.test.ts:
// keep web-tree-sitter from resolving assets against happy-dom's location.
beforeEach(() => {
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: undefined });
});

afterEach(() => {
  document.body.replaceChildren();
  if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
});

const highlighter = syntaxHighlighting(
  tagHighlighter([
    { tag: tags.keyword, class: "kw" },
    { tag: tags.number, class: "num" },
  ]),
);

function deletedChunk(view: EditorView) {
  return view.dom.querySelector(".cm-deletedChunk");
}

describe("unified merge view deletion highlighting", () => {
  it("renders plain text until the language is loaded, then re-highlights", async () => {
    let javascript = await javascriptLanguage();
    // The grammar is still loading: no language is configured yet.
    let lang = new Compartment();
    let view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({
        doc: "let value = 2;\n",
        extensions: [
          lang.of([]),
          highlighter,
          unifiedMergeView({ original: "let value = 1;\n", mergeControls: false }),
        ],
      }),
    });

    let before = deletedChunk(view);
    expect(before?.textContent).toBe("let value = 1;");
    expect(before?.querySelector(".kw")).toBeNull();

    view.dispatch({ effects: lang.reconfigure(javascript.extension) });

    let after = deletedChunk(view);
    expect(after?.textContent).toBe("let value = 1;");
    expect(after?.querySelector(".kw")?.textContent).toBe("let");
    expect(after?.querySelector(".num")?.textContent).toBe("1");
    view.destroy();
  });

  it("does not highlight deletions when syntaxHighlightDeletions is off", async () => {
    let javascript = await javascriptLanguage();
    let view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({
        doc: "let value = 2;\n",
        extensions: [
          javascript.extension,
          highlighter,
          unifiedMergeView({
            original: "let value = 1;\n",
            mergeControls: false,
            syntaxHighlightDeletions: false,
          }),
        ],
      }),
    });

    expect(deletedChunk(view)?.textContent).toBe("let value = 1;");
    expect(deletedChunk(view)?.querySelector(".kw")).toBeNull();
    view.destroy();
  });
});
