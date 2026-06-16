// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createLiveMdEditor,
  liveMdLinkBehavior,
  liveMdTheme,
  type LiveMdMarkdownFeature,
  type LiveMdPlugin,
} from "../src/index.js";

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
  vi.restoreAllMocks();
  if (locationDescriptor) {
    Object.defineProperty(globalThis, "location", locationDescriptor);
  }
});

describe("LiveMD plugins", () => {
  it("applies plugin CodeMirror extensions", () => {
    let parent = document.createElement("div");
    let pluginObserved = vi.fn();
    let extensionObserved = vi.fn();
    let editor = createLiveMdEditor({
      doc: "doc",
      extensions: [
        EditorView.updateListener.of((update) => {
          if (update.docChanged) extensionObserved(update.state.doc.toString());
        }),
      ],
      focus: false,
      parent,
      plugins: [
        {
          extension: EditorView.updateListener.of((update) => {
            if (update.docChanged) pluginObserved(update.state.doc.toString());
          }),
        },
      ],
    });

    try {
      editor.view.dispatch({
        changes: { from: editor.value.length, insert: "!" },
        userEvent: "input.test",
      });

      expect(pluginObserved).toHaveBeenCalledWith("doc!");
      expect(extensionObserved).toHaveBeenCalledWith("doc!");
    } finally {
      editor.destroy();
    }
  });

  it("cleans plugin mounts on setPlugins and destroy", () => {
    let parent = document.createElement("div");
    let events: string[] = [];
    let first: LiveMdPlugin = {
      mount({ markdown, view }) {
        events.push(
          `first mount ${view.state.doc.toString()} ${markdown.features?.[0]?.name} ${view.dom.classList.contains("cm-editor")}`,
        );
        return () => events.push("first cleanup");
      },
    };
    let second: LiveMdPlugin = {
      mount() {
        events.push("second mount");
        return () => events.push("second cleanup");
      },
    };
    let editor = createLiveMdEditor({
      doc: "doc",
      focus: false,
      markdown: { features: [{ name: "future-query-feature", query: "(paragraph) @node" }] },
      parent,
      plugins: [first],
    });

    editor.setPlugins([second]);
    editor.destroy();

    expect(events).toEqual([
      "first mount doc future-query-feature true",
      "first cleanup",
      "second mount",
      "second cleanup",
    ]);
  });

  it("remounts plugins when markdown config changes", () => {
    let parent = document.createElement("div");
    let events: string[] = [];
    let plugin: LiveMdPlugin = {
      mount({ markdown }) {
        events.push(`mount ${markdown.features?.[0]?.name ?? "none"}`);
        return () => events.push("cleanup");
      },
    };
    let editor = createLiveMdEditor({
      doc: "doc",
      focus: false,
      markdown: { features: [{ name: "first" }] },
      parent,
      plugins: [plugin],
    });

    editor.setMarkdown({ features: [{ name: "second" }] });
    editor.destroy();

    expect(events).toEqual(["mount first", "cleanup", "mount second", "cleanup"]);
  });

  it("applies and cleans theme variables through a plugin", () => {
    let parent = document.createElement("div");
    let editor = createLiveMdEditor({
      doc: "doc",
      focus: false,
      parent,
      plugins: [
        liveMdTheme({
          theme: {
            appearance: "light",
            id: "test-theme",
            variables: {
              "--live-md-bg": "#ffffff",
              "--live-md-text": "#111111",
            },
          },
        }),
      ],
    });

    expect(parent.style.getPropertyValue("--live-md-bg")).toBe("#ffffff");
    expect(parent.style.getPropertyValue("--live-md-text")).toBe("#111111");

    editor.destroy();

    expect(parent.style.getPropertyValue("--live-md-bg")).toBe("");
    expect(parent.style.getPropertyValue("--live-md-text")).toBe("");
  });

  it("allows link behavior to be installed as a plugin", async () => {
    let parent = document.body.appendChild(document.createElement("div"));
    let editor = createLiveMdEditor({
      doc: "[Guide](guide)",
      focus: false,
      parent,
      plugins: [liveMdLinkBehavior({ baseUrl: "https://docs.example/current.md" })],
    });

    await editor.ready;
    let link = parent.querySelector<HTMLElement>(".cm-md-link[data-live-md-href]");
    expect(link?.dataset.liveMdHref).toBe("https://docs.example/guide");
    editor.destroy();
  });

  it("reconfigures markdown features through setMarkdown", async () => {
    let parent = document.body.appendChild(document.createElement("div"));
    let editor = createLiveMdEditor({
      doc: "# Dynamic",
      focus: false,
      markdown: { features: [headingClassFeature("cm-md-set-markdown-first")] },
      parent,
    });

    await editor.ready;
    expect(parent.querySelector(".cm-md-set-markdown-first")).toBeTruthy();

    editor.setMarkdown({ features: [headingClassFeature("cm-md-set-markdown-second")] });

    expect(parent.querySelector(".cm-md-set-markdown-first")).toBeNull();
    expect(parent.querySelector(".cm-md-set-markdown-second")).toBeTruthy();
    editor.destroy();
  });
});

function headingClassFeature(className: string): LiveMdMarkdownFeature {
  return {
    name: className,
    query: "(atx_heading) @heading",
    decorate({ addMark, node }) {
      let heading = node("heading");
      if (!heading) return;
      addMark(heading.from, heading.to, className);
    },
  };
}
