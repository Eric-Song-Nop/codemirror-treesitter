import katex, { type KatexOptions } from "katex";
import { hashString } from "./analysis/ranges.js";

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

export type StrictLatexRenderResult =
  | {
      html: string;
      ok: true;
    }
  | {
      message: string | null;
      ok: false;
    };

const latexOptions: KatexOptions = {
  maxExpand: 1000,
  maxSize: 12,
  output: "htmlAndMathml",
  strict: "warn",
  throwOnError: false,
  trust: false,
};

export function renderLatexFormula(formula: LatexFormula): LatexRenderResult {
  try {
    let html = renderLatexToString(formula, { throwOnError: false });
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

export function renderStrictLatexFormula(formula: LatexFormula): StrictLatexRenderResult {
  try {
    return {
      html: renderLatexToString(formula, { throwOnError: true }),
      ok: true,
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : null,
      ok: false,
    };
  }
}

function renderLatexToString(formula: LatexFormula, { throwOnError }: { throwOnError: boolean }) {
  return katex.renderToString(formula.tex, {
    ...latexOptions,
    displayMode: formula.displayMode,
    throwOnError,
  });
}
