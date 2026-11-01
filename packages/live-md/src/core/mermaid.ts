import type { RenderOptions as BeautifulMermaidRenderOptions } from "beautiful-mermaid";
import type { Mermaid } from "mermaid";
import { hashString } from "./analysis/ranges.js";
import type { LiveMdMermaidRenderResult } from "./runtime/render-cache.js";

type BeautifulMermaidModule = typeof import("beautiful-mermaid");

export type MermaidRenderResult = {
  bindFunctions?: (element: Element) => void;
  svg: string;
};

export type MermaidSvgRenderer = (source: string) => Promise<MermaidRenderResult>;

/** Upper bound for one asynchronous Mermaid render before it is reported as failed. */
export const liveMdMermaidRenderTimeout = 10_000;

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

/** Monotonic sequence shared by Mermaid render ids and widget render tokens. */
export function nextMermaidRenderSequence() {
  return ++mermaidRenderSequence;
}

export async function renderLiveMdMermaidResult(
  source: string,
  renderer: MermaidSvgRenderer = renderMermaidSvg,
  timeout = liveMdMermaidRenderTimeout,
): Promise<LiveMdMermaidRenderResult> {
  try {
    let { svg, bindFunctions } = await withRenderTimeout(renderer(source), timeout);
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
  let id = `cm-md-mermaid-${nextMermaidRenderSequence()}`;
  return mermaid.render(id, source);
}

/**
 * Hang guard: a renderer that never settles (for example a pathological diagram
 * stuck awaiting layout) resolves as a render error instead of leaving the
 * widget or HTML export waiting forever.
 */
function withRenderTimeout<T>(render: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Mermaid rendering timed out after ${timeout} ms`)),
      timeout,
    );
  });
  return Promise.race([render, expired]).finally(() => clearTimeout(timer));
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
