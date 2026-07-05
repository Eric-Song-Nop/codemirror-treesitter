import type { RenderOptions as BeautifulMermaidRenderOptions } from "beautiful-mermaid";
import type { Mermaid } from "mermaid";
import { hashString } from "./analysis/ranges.js";
import type { LiveMdMermaidRenderResult } from "./runtime/render-cache.js";

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

export async function renderLiveMdMermaidResult(
  source: string,
): Promise<LiveMdMermaidRenderResult> {
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
