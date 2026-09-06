// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { liveMarkdown } from "../src/core/extension.js";
import {
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  setCodeFenceLanguages,
} from "../src/core/languages.js";
import { __testFlushLiveMdAnalysis, __testLiveMdAnalysis } from "../src/core/runtime/field.js";

let locationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: undefined });
});
afterEach(() => {
  if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
});

describe("view-owned fence sessions", () => {
  it("includes resumed native parse work in the surface trace", async () => {
    let markdown = await loadMarkdownExtension();
    let original = (await loadCodeFenceLanguages(["ts"])).get("ts")!;
    let parser = Object.create(original) as typeof original;
    let calls = 0;
    parser.parseWith = (...args: Parameters<typeof original.parseWith>) => {
      calls++;
      if (calls == 1) return null;
      return original.parseWith(...args);
    };
    let view = new EditorView({
      state: EditorState.create({
        doc: "```ts\nlet value = 1;\n```",
        extensions: [markdown, liveMarkdown()],
      }),
    });
    try {
      view.dispatch({ effects: setCodeFenceLanguages.of(new Map([["ts", parser]])) });
      await __testFlushLiveMdAnalysis(view);
      expect(calls).toBeGreaterThan(1);
      expect(__testLiveMdAnalysis(view).trace.codeFenceParses).toBe(calls);
    } finally {
      view.destroy();
    }
  });
  it("keeps native ownership separate when two views start from the same state", async () => {
    let markdown = await loadMarkdownExtension();
    let original = (await loadCodeFenceLanguages(["ts"])).get("ts")!;
    let parser = Object.create(original) as typeof original;
    let oldTrees: unknown[] = [];
    let created = 0,
      deleted = 0;
    parser.createParser = () => {
      created++;
      let native = original.createParser();
      let destroy = native.delete.bind(native);
      native.delete = () => {
        deleted++;
        destroy();
      };
      return native;
    };
    parser.parseWith = (...args: Parameters<typeof original.parseWith>) => {
      expect(typeof args[3]).toBe("function");
      oldTrees.push(args[2]);
      return original.parseWith(...args);
    };
    let first = new EditorView({
      state: EditorState.create({
        doc: "```ts\nlet value = 1;\n```",
        extensions: [markdown, liveMarkdown()],
      }),
    });
    let second: EditorView | null = null;
    let firstDestroyed = false;
    try {
      first.dispatch({ effects: setCodeFenceLanguages.of(new Map([["ts", parser]])) });
      await __testFlushLiveMdAnalysis(first);
      second = new EditorView({ state: first.state });
      second.dispatch({ changes: { from: 18, to: 19, insert: "2" } });
      await __testFlushLiveMdAnalysis(second);
      expect(created).toBe(2);
      first.destroy();
      firstDestroyed = true;
      expect(deleted).toBe(1);
      second.dispatch({ changes: { from: 18, to: 19, insert: "3" } });
      await __testFlushLiveMdAnalysis(second);
      expect(oldTrees.at(-1)).not.toBeNull();
      expect(created).toBe(2);
    } finally {
      if (!firstDestroyed) first.destroy();
      second?.destroy();
    }
    expect(deleted).toBe(created);
  });
});
