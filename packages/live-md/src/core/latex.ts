import type { KatexOptions } from "katex";
import { hashString } from "./analysis/ranges.js";

type Katex = typeof import("katex").default;

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
      pending?: false;
      resultKey: string;
    }
  | {
      message: string | null;
      ok: false;
      pending?: false;
      resultKey: string;
    }
  | {
      /** KaTeX is still loading; render the source and retry once it is available. */
      message: null;
      ok: false;
      pending: true;
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

let katexModule: Katex | null = null;
let katexPromise: Promise<Katex> | null = null;
let katexLoadListeners: Array<() => void> = [];
let katexLoadDependencies: Array<() => Promise<unknown>> = [];

/**
 * Load KaTeX on demand. Documents without math never fetch it; the first math
 * node triggers this load and listeners registered through `whenKatexLoaded`
 * re-render once it resolves.
 */
export function loadKatex(): Promise<Katex> {
  if (!katexPromise) {
    let current = Promise.all([
      import("katex"),
      ...katexLoadDependencies.map((load) => load().catch(() => {})),
    ]).then(([module]) => {
      katexModule = module.default;
      let listeners = katexLoadListeners;
      katexLoadListeners = [];
      for (let listener of listeners) listener();
      return katexModule;
    });
    katexPromise = current;
    current.catch(() => {
      if (katexPromise === current) katexPromise = null;
    });
  }
  return katexPromise;
}

/**
 * Register work (such as stylesheet loading) that should finish before KaTeX is
 * reported as loaded. Runs immediately when a load has already started.
 */
export function addKatexLoadDependency(load: () => Promise<unknown>) {
  if (katexPromise || katexModule) {
    void load().catch(() => {});
    return;
  }
  katexLoadDependencies.push(load);
}

/**
 * Start loading KaTeX without waiting for it. Analysis calls this when it first
 * sees math, so the renderer is usually ready before a formula leaves the
 * active line, and the editor's `ready` promise can wait for it.
 */
export function requestKatex() {
  if (!katexModule) void loadKatex().catch(() => {});
}

/** The in-flight KaTeX load, or null when KaTeX is loaded or was never requested. */
export function pendingKatexLoad(): Promise<unknown> | null {
  return katexModule ? null : katexPromise;
}

/** Run `listener` once KaTeX is available (synchronously when it already is). */
export function whenKatexLoaded(listener: () => void) {
  if (katexModule) {
    listener();
    return;
  }
  katexLoadListeners.push(listener);
}

export function renderLatexFormula(formula: LatexFormula): LatexRenderResult {
  let katex = katexModule;
  if (!katex) {
    requestKatex();
    return {
      message: null,
      ok: false,
      pending: true,
      resultKey: hashString(`pending\0${formula.source}`),
    };
  }
  try {
    let html = renderLatexToString(katex, formula, { throwOnError: false });
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

/** Callers must `await loadKatex()` first; the HTML export path does so before rendering. */
export function renderStrictLatexFormula(formula: LatexFormula): StrictLatexRenderResult {
  if (!katexModule) return { message: "KaTeX is not loaded", ok: false };
  try {
    return {
      html: renderLatexToString(katexModule, formula, { throwOnError: true }),
      ok: true,
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : null,
      ok: false,
    };
  }
}

function renderLatexToString(
  katex: Katex,
  formula: LatexFormula,
  { throwOnError }: { throwOnError: boolean },
) {
  return katex.renderToString(formula.tex, {
    ...latexOptions,
    displayMode: formula.displayMode,
    throwOnError,
  });
}
