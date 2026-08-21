// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { __testFlushLiveMdAnalysis } from "../src/core/decorations.js";
import { createLiveMdEditor, type LiveMdEditorController } from "../src/core/editor.js";

type BlockPreviewCase = {
  name: string;
  source: string;
  selector: string;
};

const closedBlockPreviews: BlockPreviewCase[] = [
  {
    name: "closed Mermaid",
    source: "```mermaid\nflowchart TD\n  A --> B\n```",
    selector: ".cm-md-mermaid",
  },
  {
    name: "table",
    source: "| Name | Value |\n| --- | --- |\n| alpha | 1 |",
    selector: ".cm-md-table-preview",
  },
  {
    name: "full-line image",
    source: "![Alt](image.png)",
    selector: ".cm-md-image-preview",
  },
  {
    name: "block LaTeX",
    source: "$$x^2 + y^2$$",
    selector: ".cm-md-latex-display",
  },
];

const trailingLineFeeds = [0, 1, 2, 8] as const;

const clickableBlockPreviews = closedBlockPreviews.filter((block) => block.name != "block LaTeX");

type ContainerBoundaryCase = {
  hasEmptyQuoteMarker: boolean;
  hasListMarker: boolean;
  hasQuoteMarker: boolean;
  name: string;
  closedMermaid: string;
  table: string;
  unclosedMermaid: string;
};

const containerBoundaries: ContainerBoundaryCase[] = [
  {
    closedMermaid: "> ```mermaid\n> flowchart TD\n> A --> B\n> ```\n>\n\n",
    hasEmptyQuoteMarker: true,
    hasListMarker: false,
    hasQuoteMarker: true,
    name: "blockquote",
    table: "> | A | B |\n> | - | - |\n> | x | y |\n>\n\n",
    unclosedMermaid: "> ```mermaid\n> flowchart TD\n> A --> B\n>\n\n",
  },
  {
    closedMermaid: "- ```mermaid\n  flowchart TD\n  A --> B\n  ```\n\n",
    hasEmptyQuoteMarker: false,
    hasListMarker: true,
    hasQuoteMarker: false,
    name: "list",
    table: "- | A | B |\n  | - | - |\n  | x | y |\n\n",
    unclosedMermaid: "- ```mermaid\n  flowchart TD\n  A --> B\n\n",
  },
  {
    closedMermaid: "> - ```mermaid\n>   flowchart TD\n>   A --> B\n>   ```\n>\n\n",
    hasEmptyQuoteMarker: true,
    hasListMarker: true,
    hasQuoteMarker: true,
    name: "quote and list",
    table: "> - | A | B |\n>   | - | - |\n>   | x | y |\n>\n\n",
    unclosedMermaid: "> - ```mermaid\n>   flowchart TD\n>   A --> B\n>\n\n",
  },
];

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

describe("block preview replacement boundaries", { timeout: 20_000 }, () => {
  for (let block of clickableBlockPreviews) {
    for (let { clientY, region } of [
      { clientY: 25, region: "upper" },
      { clientY: 75, region: "lower" },
    ] as const) {
      it(`reveals ${block.name} source from its ${region} half`, async () => {
        let doc = `${block.source}\n\nnext`;
        let editor = await mountEditor(doc, doc.indexOf("next"));
        let preview = editor.view.dom.querySelector<HTMLElement>(block.selector);

        expect(preview, block.name).toBeTruthy();
        preview!.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
        preview!.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            button: 0,
            cancelable: true,
            clientY,
          }),
        );

        expect(editor.view.state.selection.main.head, block.name).toBe(0);
        expect(editor.view.dom.querySelector(block.selector), block.name).toBeNull();
        editor.destroy();
      });
    }
  }

  for (let block of closedBlockPreviews) {
    for (let lineFeeds of trailingLineFeeds) {
      it(`keeps ${lineFeeds} trailing line feeds outside the ${block.name} preview`, async () => {
        let prefix = "before\n\n";
        let blockEnd = prefix.length + block.source.length;
        let doc = prefix + block.source + "\n".repeat(lineFeeds);
        let editor = await mountEditor(doc, 0);

        expect(editor.view.dom.querySelector(block.selector), block.name).toBeTruthy();
        expect(editor.value).toBe(doc);
        expect(blankLinePositionsAtOrAfter(editor.view, blockEnd)).toEqual(
          trailingBlankLinePositions(blockEnd, lineFeeds),
        );

        await __testFlushLiveMdAnalysis(editor.view);

        expect(editor.value).toBe(doc);
        expect(blankLinePositionsAtOrAfter(editor.view, blockEnd)).toEqual(
          trailingBlankLinePositions(blockEnd, lineFeeds),
        );
        editor.destroy();
      });
    }

    it(`keeps the blank line between a ${block.name} preview and following prose`, async () => {
      let blockEnd = block.source.length;
      let doc = block.source + "\n\nnext";
      let editor = await mountEditor(doc, doc.indexOf("next"));

      expect(editor.view.dom.querySelector(block.selector), block.name).toBeTruthy();
      expect(editor.value).toBe(doc);
      expect(blankLinePositionsAtOrAfter(editor.view, blockEnd)).toEqual([blockEnd + 1]);

      await __testFlushLiveMdAnalysis(editor.view);

      expect(editor.value).toBe(doc);
      expect(blankLinePositionsAtOrAfter(editor.view, blockEnd)).toEqual([blockEnd + 1]);
      editor.destroy();
    });
  }

  it("keeps every Enter after a closed Mermaid preview visible and editable", async () => {
    let prefix = "before\n\n";
    let source = closedBlockPreviews[0]!.source;
    let blockEnd = prefix.length + source.length;
    let initialLineFeeds = 1;
    let initial = prefix + source + "\n".repeat(initialLineFeeds);
    let editor = await mountEditor(initial, initial.length);

    expect(editor.view.dom.querySelector(".cm-md-mermaid")).toBeTruthy();

    for (let enters = 1; enters <= 8; enters++) {
      pressKey(editor.view, "Enter");
      let lineFeeds = initialLineFeeds + enters;
      let expected = prefix + source + "\n".repeat(lineFeeds);

      expect(editor.value, `document after Enter ${enters}`).toBe(expected);
      expect(editor.view.dom.querySelector(".cm-md-mermaid")).toBeTruthy();
      expect(
        blankLinePositionsAtOrAfter(editor.view, blockEnd),
        `visible blank lines after Enter ${enters}`,
      ).toEqual(trailingBlankLinePositions(blockEnd, lineFeeds));

      await __testFlushLiveMdAnalysis(editor.view);

      expect(editor.value, `committed document after Enter ${enters}`).toBe(expected);
      expect(editor.view.dom.querySelector(".cm-md-mermaid")).toBeTruthy();
      expect(
        blankLinePositionsAtOrAfter(editor.view, blockEnd),
        `committed blank lines after Enter ${enters}`,
      ).toEqual(trailingBlankLinePositions(blockEnd, lineFeeds));
    }

    editor.destroy();
  });

  it("keeps every Enter after an unclosed Mermaid fence visible and editable", async () => {
    let initial = "before\n\n```mermaid\nflowchart TD\nA --> B";
    let blockEnd = initial.length;
    let editor = await mountEditor(initial, initial.length);

    expect(editor.view.dom.querySelector(".cm-md-mermaid")).toBeNull();

    for (let lineFeeds = 1; lineFeeds <= 8; lineFeeds++) {
      pressKey(editor.view, "Enter");
      let expected = initial + "\n".repeat(lineFeeds);

      expect(editor.value, `document after Enter ${lineFeeds}`).toBe(expected);
      expect(
        editor.view.dom.querySelector(".cm-md-mermaid"),
        `preview after Enter ${lineFeeds}`,
      ).toBeNull();
      expect(
        blankLinePositionsAtOrAfter(editor.view, blockEnd),
        `visible blank lines after Enter ${lineFeeds}`,
      ).toEqual(trailingBlankLinePositions(blockEnd, lineFeeds));

      await __testFlushLiveMdAnalysis(editor.view);

      expect(editor.value, `committed document after Enter ${lineFeeds}`).toBe(expected);
      expect(
        editor.view.dom.querySelector(".cm-md-mermaid"),
        `committed preview after Enter ${lineFeeds}`,
      ).toBeNull();
      expect(
        blankLinePositionsAtOrAfter(editor.view, blockEnd),
        `committed blank lines after Enter ${lineFeeds}`,
      ).toEqual(trailingBlankLinePositions(blockEnd, lineFeeds));
    }

    editor.destroy();
  });

  for (let container of containerBoundaries) {
    it(`keeps ${container.name} ownership outside a closed Mermaid replacement`, async () => {
      let editor = await mountEditor(container.closedMermaid, container.closedMermaid.length);

      expect(editor.view.dom.querySelector(".cm-md-mermaid")).toBeTruthy();
      expectContainerMarkers(editor.view, container);
      expectTrailingBlankLines(editor.view, container.closedMermaid);

      await __testFlushLiveMdAnalysis(editor.view);

      expect(editor.view.dom.querySelector(".cm-md-mermaid")).toBeTruthy();
      expectContainerMarkers(editor.view, container);
      expectTrailingBlankLines(editor.view, container.closedMermaid);
      editor.destroy();
    });

    it(`keeps ${container.name} source and ownership for an unclosed Mermaid fence`, async () => {
      let editor = await mountEditor(container.unclosedMermaid, container.unclosedMermaid.length);

      expect(editor.view.dom.querySelector(".cm-md-mermaid")).toBeNull();
      expect(editor.view.contentDOM.textContent).toContain("```mermaid");
      expectContainerMarkers(editor.view, container);
      expectTrailingBlankLines(editor.view, container.unclosedMermaid);

      await __testFlushLiveMdAnalysis(editor.view);

      expect(editor.view.dom.querySelector(".cm-md-mermaid")).toBeNull();
      expect(editor.view.contentDOM.textContent).toContain("```mermaid");
      expectContainerMarkers(editor.view, container);
      expectTrailingBlankLines(editor.view, container.unclosedMermaid);
      editor.destroy();
    });

    it(`keeps ${container.name} ownership outside a table replacement`, async () => {
      let editor = await mountEditor(container.table, container.table.length);

      expect(editor.view.dom.querySelector(".cm-md-table-preview")).toBeTruthy();
      expectContainerMarkers(editor.view, container);
      expectTrailingBlankLines(editor.view, container.table);

      await __testFlushLiveMdAnalysis(editor.view);

      expect(editor.view.dom.querySelector(".cm-md-table-preview")).toBeTruthy();
      expectContainerMarkers(editor.view, container);
      expectTrailingBlankLines(editor.view, container.table);
      editor.destroy();
    });
  }
});

async function mountEditor(doc: string, selection: number): Promise<LiveMdEditorController> {
  let parent = document.body.appendChild(document.createElement("div"));
  let editor = createLiveMdEditor({ parent, doc, focus: false });
  await editor.ready;
  editor.view.dispatch({ selection: { anchor: selection } });
  await __testFlushLiveMdAnalysis(editor.view);
  return editor;
}

function pressKey(view: EditorView, key: string, init: KeyboardEventInit = {}) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

function blankLinePositionsAtOrAfter(view: EditorView, from: number) {
  return Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-line"))
    .filter((line) => line.textContent == "")
    .map((line) => view.posAtDOM(line, 0))
    .filter((position) => position >= from);
}

function trailingBlankLinePositions(blockEnd: number, lineFeeds: number) {
  return Array.from({ length: lineFeeds }, (_, index) => blockEnd + index + 1);
}

function expectContainerMarkers(view: EditorView, container: ContainerBoundaryCase) {
  if (container.hasListMarker) {
    expect(view.contentDOM.querySelector(".cm-md-list-marker"), container.name).toBeTruthy();
  }
  if (container.hasQuoteMarker) {
    expect(lineTextAt(view, 0)).toContain(">");
  }
  if (container.hasEmptyQuoteMarker) {
    expect(lineTextAt(view, view.state.doc.length - 3)).toContain(">");
  }
}

function expectTrailingBlankLines(view: EditorView, doc: string) {
  expect(doc.endsWith("\n\n")).toBe(true);
  expect(blankLinePositionsAtOrAfter(view, doc.length - 2)).toEqual([doc.length - 1, doc.length]);
}

function lineTextAt(view: EditorView, position: number) {
  let line = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")).find(
    (element) => view.posAtDOM(element, 0) == position,
  );
  return line?.textContent ?? "";
}
