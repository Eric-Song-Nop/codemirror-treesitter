// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderMarkdownToHtml } from "../src/core/markdown-html.js";
import {
  liveMdMermaidRenderTimeout,
  renderLiveMdMermaidResult,
  type MermaidSvgRenderer,
} from "../src/core/mermaid.js";
import type { LiveMdMermaidRenderHandle } from "../src/core/runtime/render-cache.js";
import { MermaidWidget } from "../src/core/widgets.js";

let locationDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  // Load parser WASM from disk instead of the happy-dom origin.
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: undefined });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
});

describe("Mermaid render hang guard", () => {
  it("reports a renderer that never settles as a bounded render error", async () => {
    vi.useFakeTimers();
    let neverSettles: MermaidSvgRenderer = () => new Promise(() => {});
    let settled = false;
    let result = renderLiveMdMermaidResult("gantt\n  DoS :2025-01-01, 1d", neverSettles);
    void result.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(liveMdMermaidRenderTimeout - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({
      message: expect.stringContaining("timed out"),
      ok: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the guard timer when the renderer settles first", async () => {
    vi.useFakeTimers();
    let renderer: MermaidSvgRenderer = async () => ({ svg: "<svg></svg>" });

    await expect(renderLiveMdMermaidResult("graph TD", renderer)).resolves.toMatchObject({
      ok: true,
      svg: "<svg></svg>",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

const hostileSvg = [
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">',
  "<style>.node { fill: url(javascript:alert(1)); }</style>",
  '<g onclick="alert(2)" class="node">',
  '<rect width="10" height="10" style="fill:url(javascript:alert(3)); stroke: #000" />',
  '<a xlink:href="javascript:alert(4)"><text>Link</text></a>',
  '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">html</div></foreignObject>',
  "<script>alert(5)</script>",
  "</g>",
  "</svg>",
].join("");

describe("editor Mermaid SVG sanitization", () => {
  it("strips event handlers, scripts, and javascript URLs before inserting SVG", () => {
    let widget = mountMermaidWidget(renderedHandle(hostileSvg));
    let svg = widget.querySelector("svg");

    expect(svg).toBeTruthy();
    expect(svg!.getAttribute("onload")).toBeNull();
    expect(widget.querySelector("[onclick]")).toBeNull();
    expect(widget.querySelector("script, foreignObject, foreignobject")).toBeNull();
    expect(widget.querySelector("style")).toBeNull();
    expect(widget.querySelector("rect")?.getAttribute("style")).toBe("stroke: #000");
    expect(widget.querySelector("a")?.getAttribute("xlink:href")).toBeNull();
    expect(widget.innerHTML).not.toContain("javascript:");
    expect(widget.innerHTML).not.toContain("alert(");
    expect(widget.querySelector("text")?.textContent).toBe("Link");
  });

  it("renders the error state instead of raw markup when the SVG cannot be parsed", () => {
    let widget = mountMermaidWidget(renderedHandle('<svg><img src=x onerror="alert(1)"></svg'));

    expect(widget.classList.contains("is-error")).toBe(true);
    expect(widget.querySelector("svg, img")).toBeNull();
    expect(widget.textContent).toContain("Unable to render Mermaid diagram");
  });

  it("rejects a hostile style directive the same way in the editor and HTML export", async () => {
    let source = "flowchart TD\n  A --> B\n  style A fill:url(javascript:alert(1))";
    let handle: LiveMdMermaidRenderHandle = {
      promise: null,
      result: null,
      resultKey: "hostile-style",
      source,
    };
    let widget = mountMermaidWidget(handle);
    await handle.promise;
    await vi.waitFor(() => expect(widget.textContent).not.toContain("Rendering Mermaid diagram"));
    let html = await renderMarkdownToHtml(`\`\`\`mermaid\n${source}\n\`\`\`\n`);

    let exported = document.createElement("div");
    exported.innerHTML = html;

    // The renderer passes the hostile fill through; both insertion paths must drop it.
    expect(handle.result?.ok ? handle.result.svg : "").toContain("javascript:");
    expect(widget.querySelector(".cm-md-mermaid-render svg")).toBeTruthy();
    expect(widget.querySelector(".cm-md-mermaid-render")?.innerHTML).not.toContain("javascript:");
    expect(exported.querySelector(".cm-md-mermaid-render svg")).toBeTruthy();
    expect(exported.querySelector(".cm-md-mermaid-render")?.innerHTML).not.toContain("javascript:");
  });
});

function renderedHandle(svg: string): LiveMdMermaidRenderHandle {
  return {
    promise: null,
    result: { ok: true, resultKey: "fixture", svg },
    resultKey: "fixture",
    source: "graph TD",
  };
}

function mountMermaidWidget(handle: LiveMdMermaidRenderHandle) {
  let view = new EditorView({ parent: document.body.appendChild(document.createElement("div")) });
  let element = new MermaidWidget(handle).toDOM(view);
  document.body.append(element);
  return element;
}
