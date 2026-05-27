// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { foldGutter, foldService } from "../src/index.js";

afterEach(() => {
  document.body.replaceChildren();
});

describe("fold gutter", () => {
  it("recomputes markers only for touched visible lines", () => {
    let queriedLines: number[] = [];
    let view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({
        doc: "first\nsecond\nthird\nfourth\n",
        extensions: [
          foldGutter(),
          foldService.of((state, lineStart, lineEnd) => {
            queriedLines.push(lineStart);
            return lineEnd < state.doc.length ? { from: lineEnd, to: lineEnd + 1 } : null;
          }),
        ],
      }),
    });
    queriedLines.length = 0;

    view.dispatch({
      changes: { from: 0, to: "first".length, insert: "FIRST!" },
    });
    view.destroy();

    expect(queriedLines).toEqual([0]);
  });

  it("recomputes markers only for selected visible lines", () => {
    let queriedLines: number[] = [];
    let doc = "first\nsecond\nthird\nfourth\n";
    let view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({
        doc,
        extensions: [
          foldGutter(),
          foldService.of((state, lineStart, lineEnd) => {
            queriedLines.push(lineStart);
            return lineEnd < state.doc.length ? { from: lineEnd, to: lineEnd + 1 } : null;
          }),
        ],
      }),
    });
    queriedLines.length = 0;

    view.dispatch({
      selection: { anchor: doc.indexOf("second") },
    });
    view.destroy();

    expect(queriedLines).toEqual([6]);
  });

  it("recomputes markers for newly visible lines when edits move the viewport", () => {
    let queriedLines: number[] = [];
    let doc = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
    let view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({
        doc,
        extensions: [
          foldGutter(),
          foldService.of((state, lineStart, lineEnd) => {
            queriedLines.push(lineStart);
            return lineEnd < state.doc.length ? { from: lineEnd, to: lineEnd + 1 } : null;
          }),
        ],
      }),
    });
    queriedLines.length = 0;

    view.dispatch({
      changes: { from: 0, insert: "inserted\n" },
      effects: EditorView.scrollIntoView(view.state.doc.line(150).from),
    });

    let visibleLineStarts = view.viewportLineBlocks.map((line) => line.from);
    view.destroy();

    expect(queriedLines).toEqual(visibleLineStarts);
  });
});
