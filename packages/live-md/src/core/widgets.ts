import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { RenderOptions as BeautifulMermaidRenderOptions } from "beautiful-mermaid";
import katex, { type KatexOptions } from "katex";
import type { Mermaid } from "mermaid";
import {
  type LiveMdMermaidRenderHandle,
  type LiveMdMermaidRenderResult,
} from "./runtime/render-cache.js";
import { hashString } from "./analysis/ranges.js";
import { isAsciiDigit } from "./util.js";

export type MarkdownTable = {
  alignments: Array<"center" | "default" | "left" | "right">;
  header: string[];
  rows: string[][];
};

const latexOptions: KatexOptions = {
  maxExpand: 1000,
  maxSize: 12,
  output: "htmlAndMathml",
  strict: "warn",
  throwOnError: false,
  trust: false,
};

export type LatexFormula = {
  block: boolean;
  displayMode: boolean;
  source: string;
  tex: string;
};

export type LatexRenderResult =
  | {
      html: string;
      ok: true;
      resultKey: string;
    }
  | {
      message: string | null;
      ok: false;
      resultKey: string;
    };

export type MermaidDiagram = {
  source: string;
};

const latexWidgetResults = new WeakMap<LatexWidget, LatexRenderResult>();

export class TaskCheckboxWidget extends WidgetType {
  private checked: boolean;

  constructor(checked: boolean) {
    super();
    this.checked = checked;
  }

  eq(other: TaskCheckboxWidget) {
    return other.checked == this.checked;
  }

  toDOM(view: EditorView) {
    let button = document.createElement("button");
    button.type = "button";
    button.className = this.checked ? "cm-md-task-toggle is-checked" : "cm-md-task-toggle";
    button.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");
    button.setAttribute("aria-checked", String(this.checked));
    button.setAttribute("role", "checkbox");
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (view.state.readOnly) return;

      let markerFrom = view.posAtDOM(button);
      view.dispatch({
        changes: {
          from: markerFrom + 1,
          to: markerFrom + 2,
          insert: this.checked ? " " : "x",
        },
        userEvent: "input.task",
      });
      view.focus();
    });
    return button;
  }

  ignoreEvent() {
    return false;
  }
}

export class LatexWidget extends WidgetType {
  private block: boolean;
  private displayMode: boolean;
  private source: string;
  private tex: string;

  constructor(formula: LatexFormula, rendered: LatexRenderResult | null = null) {
    super();
    this.block = formula.block;
    this.displayMode = formula.displayMode;
    this.source = formula.source;
    this.tex = formula.tex;
    if (rendered) latexWidgetResults.set(this, rendered);
  }

  eq(other: LatexWidget) {
    return (
      other.block == this.block &&
      other.displayMode == this.displayMode &&
      latexWidgetResults.get(other)?.resultKey == latexWidgetResults.get(this)?.resultKey &&
      other.source == this.source &&
      other.tex == this.tex
    );
  }

  toDOM() {
    let element = document.createElement(this.block ? "div" : "span");
    element.className = this.displayMode
      ? "cm-md-latex cm-md-latex-display"
      : "cm-md-latex cm-md-latex-inline";
    element.dataset.source = this.source;

    let rendered =
      latexWidgetResults.get(this) ??
      renderLatexFormula({
        block: this.block,
        displayMode: this.displayMode,
        source: this.source,
        tex: this.tex,
      });
    if (rendered.ok) {
      element.innerHTML = rendered.html;
    } else {
      element.classList.add("is-error");
      element.textContent = this.source;
      if (rendered.message) element.title = rendered.message;
    }

    return element;
  }

  ignoreEvent() {
    return false;
  }
}

export function renderLatexFormula(formula: LatexFormula): LatexRenderResult {
  try {
    let html = katex.renderToString(formula.tex, {
      ...latexOptions,
      displayMode: formula.displayMode,
    });
    return {
      html,
      ok: true,
      resultKey: hashString(html),
    };
  } catch (error) {
    let message = error instanceof Error ? error.message : null;
    return {
      message,
      ok: false,
      resultKey: hashString(`${formula.source}\0${message ?? ""}`),
    };
  }
}

type BeautifulMermaidModule = typeof import("beautiful-mermaid");

type MermaidRenderResult = {
  bindFunctions?: (element: Element) => void;
  svg: string;
};

const beautifulMermaidThemeOptions: BeautifulMermaidRenderOptions = {
  accent: "var(--live-md-mermaid-accent, var(--live-md-accent, #0f766e))",
  bg: "var(--live-md-mermaid-bg, var(--live-md-bg, #fffdfa))",
  border: "var(--live-md-mermaid-border, var(--live-md-border, #d5dcd8))",
  fg: "var(--live-md-mermaid-text, var(--live-md-text, #202523))",
  line: "var(--live-md-mermaid-line, var(--live-md-muted, #66706c))",
  muted: "var(--live-md-mermaid-muted, var(--live-md-muted, #66706c))",
  surface: "var(--live-md-mermaid-surface, var(--live-md-bg, #fffdfa))",
  transparent: true,
};

let beautifulMermaidPromise: Promise<BeautifulMermaidModule> | null = null;
let mermaidPromise: Promise<Mermaid> | null = null;
let mermaidRenderSequence = 0;

export class MermaidWidget extends WidgetType {
  private renderHandle: LiveMdMermaidRenderHandle | null;
  private source: string;

  constructor(diagram: MermaidDiagram | LiveMdMermaidRenderHandle) {
    super();
    this.renderHandle = isLiveMdMermaidRenderHandle(diagram) ? diagram : null;
    this.source = diagram.source;
  }

  eq(other: MermaidWidget) {
    return other.source == this.source;
  }

  toDOM(view: EditorView) {
    let element = document.createElement("div");
    element.className = "cm-md-mermaid";
    element.dataset.source = this.source;
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", "Edit Mermaid diagram");
    element.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    element.addEventListener("click", () => {
      view.dispatch({
        selection: { anchor: view.posAtDOM(element) },
        scrollIntoView: true,
        userEvent: "select.mermaidPreview",
      });
      view.focus();
    });
    renderMermaidInto(element, this.renderHandle ?? ephemeralMermaidRenderHandle(this.source));
    return element;
  }

  destroy(dom: HTMLElement) {
    delete dom.dataset.mermaidRenderToken;
  }

  ignoreEvent() {
    return false;
  }
}

export class ListMarkerWidget extends WidgetType {
  private marker: string;

  constructor(marker: string) {
    super();
    this.marker = marker;
  }

  eq(other: ListMarkerWidget) {
    return other.marker == this.marker;
  }

  toDOM() {
    let marker = document.createElement("span");
    let ordered = isAsciiDigit(this.marker.charCodeAt(0));
    marker.className = ordered ? "cm-md-list-marker is-ordered" : "cm-md-list-marker";
    marker.textContent = ordered ? this.marker : "\u2022";
    return marker;
  }
}

export class ImagePreviewWidget extends WidgetType {
  private alt: string;
  private src: string;

  constructor(alt: string, src: string) {
    super();
    this.alt = alt;
    this.src = src;
  }

  eq(other: ImagePreviewWidget) {
    return other.alt == this.alt && other.src == this.src;
  }

  toDOM(view: EditorView) {
    let figure = document.createElement("figure");
    figure.className = "cm-md-image-preview";
    figure.tabIndex = 0;
    figure.setAttribute("role", "button");
    figure.setAttribute("aria-label", "Edit Markdown image");
    figure.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    figure.addEventListener("click", () => {
      view.dispatch({
        selection: { anchor: view.posAtDOM(figure) },
        scrollIntoView: true,
        userEvent: "select.imagePreview",
      });
      view.focus();
    });

    let image = document.createElement("img");
    image.alt = this.alt;
    image.src = this.src;
    figure.append(image);

    if (this.alt) {
      let caption = document.createElement("figcaption");
      caption.textContent = this.alt;
      figure.append(caption);
    }

    return figure;
  }

  ignoreEvent() {
    return false;
  }
}

export class TablePreviewWidget extends WidgetType {
  private table: MarkdownTable;
  private tableKey: string;

  constructor(table: MarkdownTable) {
    super();
    this.table = table;
    this.tableKey = JSON.stringify(table);
  }

  eq(other: TablePreviewWidget) {
    return other.tableKey == this.tableKey;
  }

  toDOM(view: EditorView) {
    let wrapper = document.createElement("div");
    wrapper.className = "cm-md-table-preview";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "button");
    wrapper.setAttribute("aria-label", "Edit Markdown table");
    wrapper.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    wrapper.addEventListener("click", () => {
      view.dispatch({
        selection: { anchor: view.posAtDOM(wrapper) },
        scrollIntoView: true,
        userEvent: "select.tablePreview",
      });
      view.focus();
    });

    let table = document.createElement("table");
    let thead = document.createElement("thead");
    let headerRow = document.createElement("tr");
    this.table.header.forEach((cell, index) => {
      let heading = document.createElement("th");
      heading.textContent = cell;
      applyTableAlignment(heading, this.table.alignments[index]);
      headerRow.append(heading);
    });
    thead.append(headerRow);
    table.append(thead);

    let tbody = document.createElement("tbody");
    this.table.rows.forEach((row) => {
      let tableRow = document.createElement("tr");
      row.forEach((cell, index) => {
        let value = document.createElement("td");
        value.textContent = cell;
        applyTableAlignment(value, this.table.alignments[index]);
        tableRow.append(value);
      });
      tbody.append(tableRow);
    });
    table.append(tbody);
    wrapper.append(table);

    return wrapper;
  }
}

function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((module) => {
    let mermaid = module.default;
    mermaid.initialize({
      securityLevel: "strict",
      startOnLoad: false,
    });
    return mermaid;
  });
  return mermaidPromise;
}

function loadBeautifulMermaid() {
  beautifulMermaidPromise ??= import("beautiful-mermaid");
  return beautifulMermaidPromise;
}

function renderMermaidInto(element: HTMLElement, handle: LiveMdMermaidRenderHandle) {
  let renderToken = String(++mermaidRenderSequence);
  element.dataset.mermaidRenderToken = renderToken;
  element.classList.remove("is-error");
  element.removeAttribute("title");

  if (handle.result) {
    applyMermaidResult(element, handle.result);
    return;
  }

  element.replaceChildren(mermaidMessage("Rendering Mermaid diagram"));

  void cachedMermaidRenderResult(handle).then((result) => {
    if (!isCurrentMermaidRender(element, renderToken)) return;
    applyMermaidResult(element, result);
  });
}

function cachedMermaidRenderResult(handle: LiveMdMermaidRenderHandle) {
  if (handle.result) return Promise.resolve(handle.result);
  handle.promise ??= renderLiveMdMermaidResult(handle.source).then((result) => {
    handle.result = result;
    return result;
  });
  return handle.promise;
}

async function renderLiveMdMermaidResult(source: string): Promise<LiveMdMermaidRenderResult> {
  try {
    let { svg, bindFunctions } = await renderMermaidSvg(source);
    return {
      bindFunctions,
      ok: true,
      resultKey: hashString(svg),
      svg,
    };
  } catch (error) {
    let message = error instanceof Error ? error.message : null;
    return {
      message,
      ok: false,
      resultKey: hashString(`${source}\0${message ?? ""}`),
    };
  }
}

function applyMermaidResult(element: HTMLElement, result: LiveMdMermaidRenderResult) {
  if (result.ok) {
    let render = document.createElement("div");
    render.className = "cm-md-mermaid-render";
    appendSvg(render, result.svg);
    element.replaceChildren(render);
    result.bindFunctions?.(render);
  } else {
    element.classList.add("is-error");
    element.replaceChildren(mermaidMessage("Unable to render Mermaid diagram"));
    if (result.message) element.title = result.message;
  }
}

async function renderMermaidSvg(source: string): Promise<MermaidRenderResult> {
  try {
    let { renderMermaidSVG } = await loadBeautifulMermaid();
    let svg = prepareBeautifulMermaidSvg(renderMermaidSVG(source, beautifulMermaidThemeOptions));
    if (!svg.trim()) throw new Error("beautiful-mermaid returned an empty SVG");
    return { svg };
  } catch {
    return renderMermaidSvgWithOfficialRenderer(source);
  }
}

async function renderMermaidSvgWithOfficialRenderer(source: string): Promise<MermaidRenderResult> {
  let mermaid = await loadMermaid();
  let id = `cm-md-mermaid-${++mermaidRenderSequence}`;
  return mermaid.render(id, source);
}

function prepareBeautifulMermaidSvg(svg: string) {
  return stripCssImports(svg)
    .replace(
      /text\s*\{\s*font-family:\s*'[^']+',\s*system-ui,\s*sans-serif;\s*\}/,
      "text { font-family: var(--live-md-mermaid-font, var(--live-md-font-ui)); }",
    )
    .replace(
      /\.mono\s*\{\s*font-family:\s*'JetBrains Mono',\s*'SF Mono',\s*'Fira Code',\s*ui-monospace,\s*monospace;\s*\}/,
      ".mono { font-family: var(--live-md-mermaid-mono-font, var(--live-md-font-code)); }",
    );
}

function stripCssImports(svg: string) {
  return svg.replace(/^\s*@import\s+url\(['"][^'"]+['"]\);\s*/gm, "");
}

function appendSvg(parent: HTMLElement, svg: string) {
  let svgElement = parseSvg(svg);
  if (svgElement) {
    parent.append(svgElement);
  } else {
    parent.innerHTML = svg;
  }
}

function parseSvg(svg: string) {
  if (typeof DOMParser == "undefined") return null;
  let parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror")) return null;
  if (parsed.documentElement.localName.toLowerCase() != "svg") return null;
  return document.importNode(parsed.documentElement, true);
}

function isCurrentMermaidRender(element: HTMLElement, renderToken: string) {
  return element.isConnected && element.dataset.mermaidRenderToken == renderToken;
}

function mermaidMessage(text: string) {
  let message = document.createElement("span");
  message.className = "cm-md-mermaid-message";
  message.textContent = text;
  return message;
}

function isLiveMdMermaidRenderHandle(
  diagram: MermaidDiagram | LiveMdMermaidRenderHandle,
): diagram is LiveMdMermaidRenderHandle {
  return "promise" in diagram && "result" in diagram;
}

function ephemeralMermaidRenderHandle(source: string): LiveMdMermaidRenderHandle {
  return {
    promise: null,
    result: null,
    resultKey: hashString(source),
    source,
  };
}

export function replaceWithWidget(from: number, to: number, widget: WidgetType, block = false) {
  return {
    decoration: Decoration.replace({ block, widget }),
    from,
    to,
  };
}

function applyTableAlignment(
  element: HTMLTableCellElement,
  alignment: "center" | "default" | "left" | "right" = "default",
) {
  if (alignment != "default") element.style.textAlign = alignment;
}
