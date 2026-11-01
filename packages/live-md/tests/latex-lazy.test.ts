// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let locationDescriptor: PropertyDescriptor | undefined;
let modules: Awaited<ReturnType<typeof importFreshModules>>;

async function importFreshModules() {
  return {
    editor: await import("../src/core/editor.js"),
    latex: await import("../src/core/latex.js"),
    view: await import("@codemirror/view"),
    widgets: await import("../src/core/widgets.js"),
  };
}

beforeEach(async () => {
  // Fresh module graph per test so KaTeX starts unloaded. Modules evaluate
  // before `location` is cleared (asset URLs need it); parsers load after.
  vi.resetModules();
  modules = await importFreshModules();
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: undefined });
});

afterEach(() => {
  document.body.replaceChildren();
  if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
});

const formula = { block: false, displayMode: false, source: "$x$", tex: "x" };

describe("lazy KaTeX loading", () => {
  it("does not load KaTeX for documents without math", async () => {
    let { createLiveMdEditor } = modules.editor;
    let { latex } = modules;
    let parent = document.body.appendChild(document.createElement("div"));
    let editor = createLiveMdEditor({ doc: "# Title\n\nNo math, only $5.", parent });
    await editor.ready;

    expect(latex.pendingKatexLoad()).toBeNull();
    let listener = vi.fn();
    latex.whenKatexLoaded(listener);
    expect(listener).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("loads KaTeX before ready resolves when the document has math on the active line", async () => {
    let { createLiveMdEditor } = modules.editor;
    let { latex } = modules;
    let parent = document.body.appendChild(document.createElement("div"));
    let editor = createLiveMdEditor({ doc: "$x^2$\n\nnext", parent });
    await editor.ready;

    expect(latex.renderLatexFormula(formula)).toMatchObject({ ok: true });

    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
    let widget = editor.view.contentDOM.querySelector(".cm-md-latex-inline");
    expect(widget?.querySelector(".katex")).toBeTruthy();
    editor.destroy();
  });

  it("renders a pending placeholder and swaps in KaTeX output once loaded", async () => {
    let { latex } = modules;
    let { LatexWidget } = modules.widgets;
    let { EditorView } = modules.view;
    let view = new EditorView({ parent: document.body.appendChild(document.createElement("div")) });

    let pending = latex.renderLatexFormula(formula);
    expect(pending).toMatchObject({ ok: false, pending: true });
    let element = new LatexWidget(formula, pending).toDOM(view);
    document.body.append(element);
    expect(element.classList.contains("is-pending")).toBe(true);
    expect(element.textContent).toBe("$x$");

    await latex.loadKatex();

    expect(element.classList.contains("is-pending")).toBe(false);
    expect(element.querySelector(".katex")).toBeTruthy();
    view.destroy();
  });
});
