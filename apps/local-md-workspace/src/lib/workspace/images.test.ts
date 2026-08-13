// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { WorkspaceImageAsset } from "@/lib/workspace/types";
import { insertImageMarkdown } from "./images";

type InsertedImageAsset = WorkspaceImageAsset & { markdownReference: string };

let mountedViews: EditorView[] = [];

afterEach(() => {
  for (let view of mountedViews) {
    let parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  }
  mountedViews = [];
});

describe("insertImageMarkdown", () => {
  for (let testCase of [
    {
      name: "at the start of the document",
      doc: "Existing paragraph",
      position: 0,
      prefix: "",
      suffix: "\n\n",
    },
    {
      name: "in the middle of a paragraph",
      doc: "BeforeAfter",
      position: "Before".length,
      prefix: "\n\n",
      suffix: "\n\n",
    },
    {
      name: "at the end of the document",
      doc: "Existing paragraph",
      position: "Existing paragraph".length,
      prefix: "\n\n",
      suffix: "",
    },
  ]) {
    for (let assets of [
      [testImage("photo.png", "assets/photo.png")],
      [
        testImage("first-image.png", "assets/first-image.png"),
        testImage("second_image.webp", "assets/second_image.webp"),
      ],
    ]) {
      let assetCount = assets.length == 1 ? "one image" : "multiple images";

      it(`keeps the selection at the end of ${assetCount} inserted ${testCase.name}`, () => {
        let view = mountEditor(testCase.doc);
        let markdown = assets.map(expectedImageMarkdown).join("\n\n");

        insertImageMarkdown(view, assets, testCase.position);

        expect(view.state.doc.toString()).toBe(
          `${testCase.doc.slice(0, testCase.position)}${testCase.prefix}${markdown}${testCase.suffix}${testCase.doc.slice(testCase.position)}`,
        );
        expect(view.state.selection.main).toMatchObject({
          anchor: testCase.position + testCase.prefix.length + markdown.length,
          head: testCase.position + testCase.prefix.length + markdown.length,
        });
      });
    }
  }
});

function mountEditor(doc: string) {
  let parent = document.body.appendChild(document.createElement("div"));
  let view = new EditorView({
    parent,
    state: EditorState.create({ doc }),
  });
  mountedViews.push(view);
  return view;
}

function testImage(name: string, markdownReference: string): InsertedImageAsset {
  return {
    file: new File([], name, { type: name.endsWith(".webp") ? "image/webp" : "image/png" }),
    markdownReference,
    name,
    path: markdownReference,
    url: `blob:${name}`,
  };
}

function expectedImageMarkdown(asset: InsertedImageAsset) {
  let alt = asset.name
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return `![${alt}](${asset.markdownReference})`;
}
