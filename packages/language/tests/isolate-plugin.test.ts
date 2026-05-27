// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  NodeProp,
  Tree,
  TreeSitterLanguage,
  TreeSitterParser,
  bidiIsolates,
} from "../src/index.js";
import type { IterateSpec } from "../src/tree.js";

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

describe("bidi isolate view plugin", () => {
  it("recomputes isolate decorations only for touched visible ranges", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    let javascript = TreeSitterLanguage.define({
      name: "javascript",
      parser: await javascriptParser,
      props: [NodeProp.isolate.add({ identifier: "ltr" })],
    });
    let doc = "let first = 1;\nlet second = 2;\n";
    let view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({
        doc,
        extensions: [javascript.extension, bidiIsolates({ alwaysIsolate: true })],
      }),
    });
    let iterated: Array<{ from: number; to: number }> = [];
    let originalIterate = Object.getOwnPropertyDescriptor(Tree.prototype, "iterate")!
      .value as Tree["iterate"];

    Tree.prototype.iterate = function (spec: IterateSpec) {
      iterated.push({ from: spec.from ?? 0, to: spec.to ?? this.length });
      return originalIterate.call(this, spec);
    };
    try {
      view.dispatch({
        changes: { from: "let ".length, to: "let first".length, insert: "other" },
      });
    } finally {
      Tree.prototype.iterate = originalIterate;
      view.destroy();
    }

    let firstLineTo = "let other = 1;".length;
    expect(iterated).toContainEqual({ from: 0, to: firstLineTo });
    expect(iterated.some((range) => range.to > firstLineTo)).toBe(false);
  });
});
