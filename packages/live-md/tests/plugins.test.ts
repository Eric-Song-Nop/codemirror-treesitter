// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createLiveMdEditor, type LiveMdPlugin } from "../src/index.js";

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
});
