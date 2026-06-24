// @vitest-environment happy-dom

import { type EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { emptyLiveMdLeafAnalysisTrace } from "../src/core/analysis/types.js";
import {
  cachedLiveMdMermaidRequest,
  createLiveMdRenderCache,
} from "../src/core/runtime/render-cache.js";
import { MermaidWidget } from "../src/core/widgets.js";

const mermaidMock = vi.hoisted(() => ({
  beautifulCalls: 0,
  bindCalls: 0,
  initializeCalls: 0,
  officialCalls: 0,
}));

vi.mock("beautiful-mermaid", () => ({
  renderMermaidSVG(source: string) {
    mermaidMock.beautifulCalls++;
    if (source.includes("FAIL")) throw new Error("beautiful failed");
    return `<svg xmlns="http://www.w3.org/2000/svg"><text>${source}</text></svg>`;
  },
}));

vi.mock("mermaid", () => ({
  default: {
    initialize() {
      mermaidMock.initializeCalls++;
    },
    async render(id: string, source: string) {
      mermaidMock.officialCalls++;
      if (source.includes("FAIL")) throw new Error("official failed");
      return {
        bindFunctions() {
          mermaidMock.bindCalls++;
        },
        svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}"><text>${source}</text></svg>`,
      };
    },
  },
}));

const inertView = {
  dispatch() {},
  focus() {},
  posAtDOM() {
    return 0;
  },
} as unknown as EditorView;

beforeEach(() => {
  document.body.replaceChildren();
  mermaidMock.beautifulCalls = 0;
  mermaidMock.bindCalls = 0;
  mermaidMock.initializeCalls = 0;
  mermaidMock.officialCalls = 0;
});

describe("Mermaid render cache", () => {
  it("reuses the pending render promise and applies settled success synchronously", async () => {
    let cache = createLiveMdRenderCache();
    let trace = emptyLiveMdLeafAnalysisTrace();
    let source = "flowchart TD\nA --> B";
    let handle = cachedLiveMdMermaidRequest(cache, trace, "record-a", source);
    expect(cachedLiveMdMermaidRequest(cache, trace, "record-a", source)).toBe(handle);
    expect(trace.heavyRenderStarts).toBe(1);

    let first = new MermaidWidget(handle).toDOM(inertView);
    let pending = handle.promise;
    let second = new MermaidWidget(handle).toDOM(inertView);
    document.body.append(first, second);

    expect(handle.promise).toBe(pending);
    expect(handle.result).toBeNull();

    await waitForMermaidSvg(first);
    await waitForMermaidSvg(second);

    expect(mermaidMock.beautifulCalls).toBe(1);
    expect(handle.result?.ok).toBe(true);

    let ready = new MermaidWidget(handle).toDOM(inertView);
    expect(ready.querySelector("svg")?.textContent).toContain("A --> B");
    expect(ready.textContent).not.toContain("Rendering Mermaid diagram");
    expect(mermaidMock.beautifulCalls).toBe(1);
  });

  it("caches settled render errors and applies them synchronously", async () => {
    let cache = createLiveMdRenderCache();
    let trace = emptyLiveMdLeafAnalysisTrace();
    let handle = cachedLiveMdMermaidRequest(cache, trace, "record-b", "FAIL");
    let element = new MermaidWidget(handle).toDOM(inertView);
    document.body.append(element);

    await waitForMermaidError(element);

    expect(mermaidMock.beautifulCalls).toBe(1);
    expect(mermaidMock.officialCalls).toBe(1);
    expect(handle.result).toMatchObject({
      message: "official failed",
      ok: false,
    });

    let ready = new MermaidWidget(handle).toDOM(inertView);
    expect(ready.classList.contains("is-error")).toBe(true);
    expect(ready.title).toBe("official failed");
    expect(ready.textContent).toContain("Unable to render Mermaid diagram");
    expect(mermaidMock.beautifulCalls).toBe(1);
    expect(mermaidMock.officialCalls).toBe(1);
  });
});

async function waitForMermaidSvg(element: Element) {
  for (let attempt = 0; attempt < 20; attempt++) {
    let svg = element.querySelector("svg");
    if (svg) return svg;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Expected cached Mermaid preview to render an SVG");
}

async function waitForMermaidError(element: HTMLElement) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (element.classList.contains("is-error")) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Expected cached Mermaid preview to render an error");
}
