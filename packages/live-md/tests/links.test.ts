// @vitest-environment happy-dom

import { EditorState, type Extension } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror-treesitter/language";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  __testFlushLiveMdAnalysis,
  __testLiveMdAnalysis,
  liveMdAnalysis,
} from "../src/core/decorations.js";
import { createLiveMdEditor, type LiveMdEditorController } from "../src/core/editor.js";
import { codeFenceLanguagesField, loadMarkdownExtension } from "../src/core/languages.js";
import { liveMdLinkOpen, type LiveMdLinkBaseUrl } from "../src/core/links.js";

let openLink: ReturnType<typeof vi.fn>;
let locationDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: undefined,
  });
  openLink = vi.fn();
  vi.stubGlobal("open", openLink);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (locationDescriptor) {
    Object.defineProperty(globalThis, "location", locationDescriptor);
  }
});

describe("LiveMD links", () => {
  it("opens inline Markdown links on Shift-click", async () => {
    let editor = await mountEditor("[Vite+](https://viteplus.dev/)");

    shiftClick(firstClickableLink(editor.view));

    expect(openLink).toHaveBeenCalledWith("https://viteplus.dev/", "_blank", "noopener,noreferrer");
  });

  it("lets host apps override Shift-click link opening", async () => {
    let handleLinkOpen = vi.fn();
    let editor = await mountEditor("[Vite+](https://viteplus.dev/)", {
      extensions: [liveMdLinkOpen(handleLinkOpen)],
    });

    shiftClick(firstClickableLink(editor.view));

    expect(handleLinkOpen).toHaveBeenCalledWith("https://viteplus.dev/");
    expect(openLink).not.toHaveBeenCalled();
  });

  it("keeps ordinary clicks available for editor selection behavior", async () => {
    let editor = await mountEditor("[Vite+](https://viteplus.dev/)");

    let click = clickLink(firstClickableLink(editor.view));

    expect(click.defaultPrevented).toBe(false);
    expect(openLink).not.toHaveBeenCalled();
  });

  it("shows the pointer cursor affordance only while Shift is held over a link", async () => {
    let editor = await mountEditor("[Vite+](https://viteplus.dev/)");
    let link = firstClickableLink(editor.view);

    moveOverLink(link);
    expect(link.classList.contains("cm-md-link-shift-hover")).toBe(false);

    dispatchShiftKey(editor.view, "keydown");
    expect(link.classList.contains("cm-md-link-shift-hover")).toBe(true);

    dispatchShiftKey(editor.view, "keyup");
    expect(link.classList.contains("cm-md-link-shift-hover")).toBe(false);

    moveOverLink(link, { shiftKey: true });
    expect(link.classList.contains("cm-md-link-shift-hover")).toBe(true);

    editor.view.contentDOM.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect(link.classList.contains("cm-md-link-shift-hover")).toBe(false);
  });

  it("opens URI autolinks without their angle brackets", async () => {
    let editor = await mountEditor("<https://viteplus.dev/>\n\nnext");
    let link = firstClickableLink(editor.view);

    expect(link.textContent).toBe("https://viteplus.dev/");

    shiftClick(link);

    expect(openLink).toHaveBeenCalledWith("https://viteplus.dev/", "_blank", "noopener,noreferrer");
  });

  it("does not open unsafe link destinations", async () => {
    let editor = await mountEditor("[bad](javascript:alert)\n\nnext");
    let link = firstStyledLink(editor.view);

    expect(link.textContent).toBe("bad");
    expect(link.hasAttribute("data-live-md-href")).toBe(false);

    shiftClick(link);

    expect(openLink).not.toHaveBeenCalled();
  });

  it("does not treat image descriptions as link jumps", async () => {
    let editor = await mountEditor("![alt](https://image.example/file.png)", { selection: 2 });
    let link = firstStyledLink(editor.view);

    expect(link.textContent).toBe("alt");
    expect(link.hasAttribute("data-live-md-href")).toBe(false);

    shiftClick(link);

    expect(openLink).not.toHaveBeenCalled();
  });

  it("does not open relative link destinations without a configured link base URL", async () => {
    let editor = await mountEditor("[docs](/guide)\n\nnext");
    let link = firstStyledLink(editor.view);

    expect(link.textContent).toBe("docs");
    expect(link.hasAttribute("data-live-md-href")).toBe(false);

    shiftClick(link);

    expect(openLink).not.toHaveBeenCalled();
  });

  it("resolves relative link destinations against the configured link base URL", async () => {
    let editor = await mountEditor("[docs](/guide)\n\nnext", {
      linkBaseUrl: "https://docs.example/current/page.md",
    });
    let link = firstClickableLink(editor.view);

    expect(link.dataset.liveMdHref).toBe("https://docs.example/guide");

    shiftClick(link);

    expect(openLink).toHaveBeenCalledWith(
      "https://docs.example/guide",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("updates clickable destinations after edits", async () => {
    let doc = "[docs](https://one.example)\n\nnext";
    let editor = await mountEditor(doc);

    expect(firstClickableLink(editor.view).dataset.liveMdHref).toBe("https://one.example");

    let hostFrom = doc.indexOf("one.example");
    editor.view.dispatch({
      changes: {
        from: hostFrom,
        to: hostFrom + "one.example".length,
        insert: "two.example",
      },
      userEvent: "input.test",
    });

    expect(__testLiveMdAnalysis(editor.view).pending).toBeTruthy();
    expect(clickableLinks(editor.view)).toHaveLength(0);
    for (let link of styledLinks(editor.view)) shiftClick(link);
    expect(openLink).not.toHaveBeenCalled();

    await __testFlushLiveMdAnalysis(editor.view);

    let link = firstClickableLink(editor.view);
    expect(link.dataset.liveMdHref).toBe("https://two.example");

    shiftClick(link);

    expect(openLink).toHaveBeenCalledWith("https://two.example", "_blank", "noopener,noreferrer");
  });

  it("clears links on the pending edit surface and restores them after commit", async () => {
    let doc = "keep **bold** and [link](https://example.com) tail";
    let editor = await mountEditor(doc);

    let editFrom = doc.indexOf("tail");
    editor.view.dispatch({
      changes: { from: editFrom, insert: "new " },
      selection: { anchor: editFrom + "new ".length },
    });

    expect(__testLiveMdAnalysis(editor.view).pending).toBeTruthy();
    expect(editor.view.dom.querySelector(".cm-md-strong")).toBeTruthy();
    expect(clickableLinks(editor.view)).toHaveLength(0);
    expect(styledLinks(editor.view)).toHaveLength(0);

    await __testFlushLiveMdAnalysis(editor.view);
    let link = firstClickableLink(editor.view);
    expect(link.dataset.liveMdHref).toBe("https://example.com");

    shiftClick(link);

    expect(openLink).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
  });

  it("removes dirty link decorations while link labels are pending", async () => {
    let doc = "[docs](https://example.com) tail";
    let editor = await mountEditor(doc);

    editor.view.dispatch({ changes: { from: doc.indexOf("docs") + 1, insert: "x" } });

    expect(__testLiveMdAnalysis(editor.view).pending).toBeTruthy();
    expect(clickableLinks(editor.view)).toHaveLength(0);
    expect(styledLinks(editor.view)).toHaveLength(0);

    await __testFlushLiveMdAnalysis(editor.view);

    expect(firstClickableLink(editor.view).dataset.liveMdHref).toBe("https://example.com");
  });

  it("removes dirty link decorations while link delimiters are pending", async () => {
    let doc = "[docs](https://example.com) tail";
    let editor = await mountEditor(doc);

    let delimiterFrom = doc.indexOf("]");
    editor.view.dispatch({ changes: { from: delimiterFrom, to: delimiterFrom + 1 } });

    expect(__testLiveMdAnalysis(editor.view).pending).toBeTruthy();
    expect(clickableLinks(editor.view)).toHaveLength(0);
    expect(styledLinks(editor.view)).toHaveLength(0);

    await __testFlushLiveMdAnalysis(editor.view);

    expect(clickableLinks(editor.view)).toHaveLength(0);
    expect(styledLinks(editor.view)).toHaveLength(0);
  });

  it("does not expose stale safe hrefs while unsafe destination edits are pending", async () => {
    let doc = "[docs](https://safe.example)\n\nnext";
    let editor = await mountEditor(doc);

    let destinationFrom = doc.indexOf("https://safe.example");
    editor.view.dispatch({
      changes: {
        from: destinationFrom,
        to: destinationFrom + "https://safe.example".length,
        insert: "javascript:alert",
      },
    });

    expect(__testLiveMdAnalysis(editor.view).pending).toBeTruthy();
    expect(clickableLinks(editor.view)).toHaveLength(0);

    await __testFlushLiveMdAnalysis(editor.view);

    expect(firstStyledLink(editor.view).hasAttribute("data-live-md-href")).toBe(false);
  });

  it("tracks dirty link ranges in interactive safety ranges", async () => {
    let doc = "[one](https://one.example) and [two](https://two.example) tail";
    let state = EditorState.create({
      doc,
      extensions: [await loadMarkdownExtension(), codeFenceLanguagesField, liveMdAnalysis],
    });
    ensureSyntaxTree(state, doc.length, 5_000);
    state = state.update({}).state;

    let destinationFrom = doc.indexOf("https://one.example");
    let pendingState = state.update({
      changes: {
        from: destinationFrom,
        to: destinationFrom + "https://one.example".length,
        insert: "javascript:alert",
      },
    }).state;
    let analysis = __testLiveMdAnalysis({ state: pendingState } as EditorView);

    expect(analysis.pending).toBeTruthy();
    expect(
      analysis.pending?.interactiveSafetyRanges.map((range) =>
        pendingState.sliceDoc(range.from, range.to),
      ),
    ).toEqual(["one"]);
  });
});

type MountOptions = {
  extensions?: Extension[];
  linkBaseUrl?: LiveMdLinkBaseUrl | null;
  selection?: number;
};

async function mountEditor(
  doc: string,
  options: MountOptions = {},
): Promise<LiveMdEditorController> {
  let parent = document.createElement("div");
  document.body.append(parent);
  let editor = createLiveMdEditor({
    parent,
    doc,
    focus: false,
    extensions: options.extensions,
    linkBaseUrl: options.linkBaseUrl,
  });
  await editor.ready;
  editor.view.dispatch({
    selection: { anchor: options.selection ?? doc.length },
  });
  return editor;
}

function firstClickableLink(view: EditorView) {
  let link = clickableLinks(view)[0];
  expect(link).toBeTruthy();
  return link!;
}

function firstStyledLink(view: EditorView) {
  let link = styledLinks(view)[0];
  expect(link).toBeTruthy();
  return link!;
}

function clickableLinks(view: EditorView) {
  return Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-md-link[data-live-md-href]"));
}

function styledLinks(view: EditorView) {
  return Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-md-link"));
}

function clickLink(link: HTMLElement, init: MouseEventInit = {}) {
  let event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  link.dispatchEvent(event);
  return event;
}

function shiftClick(link: HTMLElement) {
  clickLink(link, { shiftKey: true });
}

function moveOverLink(link: HTMLElement, init: MouseEventInit = {}) {
  link.dispatchEvent(
    new MouseEvent("mouseover", {
      bubbles: true,
      ...init,
    }),
  );
}

function dispatchShiftKey(view: EditorView, type: "keydown" | "keyup") {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent(type, {
      bubbles: true,
      key: "Shift",
    }),
  );
}
