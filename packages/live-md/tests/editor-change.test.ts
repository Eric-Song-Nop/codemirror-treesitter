// @vitest-environment happy-dom
import { Text } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createLiveMdEditor,
  liveMdPersistDelay,
  type LiveMdEditorChange,
  type LiveMdEditorController,
} from "../src/core/editor.js";
import { defineLiveMdEditor, type LiveMdEditorElement } from "../src/element/live-md-editor.js";

let locationDescriptor: PropertyDescriptor | undefined;
let localStorageDescriptor: PropertyDescriptor | undefined;
let editors: LiveMdEditorController[] = [];
let tagId = 0;

const largeDoc = Array.from(
  { length: 4000 },
  (_, index) => `Paragraph ${index} with **strong** text and \`code\`.`,
).join("\n\n");

beforeEach(() => {
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "location", { configurable: true, value: undefined });
});

afterEach(() => {
  for (let editor of editors) editor.destroy();
  editors = [];
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
  if (localStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

describe("editor change payload", () => {
  it("does not stringify a large document while typing", async () => {
    let changes: LiveMdEditorChange[] = [];
    let editor = mountEditor({ doc: largeDoc, onChange: (change) => changes.push(change) });
    await editor.ready;
    let toString = vi.spyOn(Text.prototype, "toString");

    typeInto(editor, "abc");

    expect(changes).toHaveLength(3);
    expect(toString).not.toHaveBeenCalled();
    expect(changes.at(-1)!.value.endsWith("abc")).toBe(true);
    expect(toString).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe(changes.at(-1)!.value);
    expect(toString).toHaveBeenCalledTimes(1);
  });

  it("does not stringify a large document while typing into the web component", async () => {
    let tag = `live-md-editor-change-${++tagId}`;
    defineLiveMdEditor(tag);
    let element = document.createElement(tag) as LiveMdEditorElement;
    element.value = largeDoc;
    let inputs = 0;
    element.addEventListener("input", () => inputs++);
    document.body.append(element);
    await element.ready;
    let toString = vi.spyOn(Text.prototype, "toString");

    for (let char of "abc") {
      let end = element.view!.state.doc.length;
      element.view!.dispatch({ changes: { from: end, insert: char }, userEvent: "input.type" });
    }

    expect(inputs).toBe(3);
    expect(toString).not.toHaveBeenCalled();
    expect(element.value.endsWith("abc")).toBe(true);
    expect(element.value.length).toBe(largeDoc.length + 3);
    expect(toString).toHaveBeenCalledTimes(1);
  });
});

describe("editor persistence", () => {
  it("coalesces writes for a burst of edits into one debounced write", async () => {
    let storage = installTestLocalStorage();
    let editor = mountEditor({ defaultValue: "doc", persistKey: "live-md-burst" });
    await editor.ready;
    vi.useFakeTimers();

    typeInto(editor, "12345");
    expect(storage.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(liveMdPersistDelay - 1);
    expect(storage.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenLastCalledWith("live-md-burst", "doc12345");
  });

  it("flushes pending writes on blur, page hide, and destroy", async () => {
    let storage = installTestLocalStorage();
    let editor = mountEditor({ defaultValue: "doc", persistKey: "live-md-flush" });
    await editor.ready;

    typeInto(editor, "!");
    editor.view.contentDOM.dispatchEvent(new FocusEvent("blur"));
    expect(storage.setItem).toHaveBeenLastCalledWith("live-md-flush", "doc!");

    typeInto(editor, "?");
    setVisibilityState("hidden");
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      setVisibilityState(undefined);
    }
    expect(storage.setItem).toHaveBeenLastCalledWith("live-md-flush", "doc!?");

    typeInto(editor, "#");
    editor.destroy();
    expect(storage.setItem).toHaveBeenLastCalledWith("live-md-flush", "doc!?#");
    expect(storage.setItem).toHaveBeenCalledTimes(3);
  });

  it("writes pending edits to the previous key before switching keys", async () => {
    let storage = installTestLocalStorage();
    let editor = mountEditor({ defaultValue: "doc", persistKey: "first" });
    await editor.ready;

    typeInto(editor, "1");
    editor.setPersistKey("second");
    typeInto(editor, "2");
    editor.flushPersistence();

    expect(storage.setItem.mock.calls).toEqual([
      ["first", "doc1"],
      ["second", "doc12"],
    ]);
  });
});

describe("editor focus", () => {
  it("does not take focus by default", async () => {
    let focus = vi.spyOn(HTMLElement.prototype, "focus");
    let editor = mountEditor({ doc: "text" });
    await editor.ready;

    expect(focus).not.toHaveBeenCalled();
    expect(editor.view.hasFocus).toBe(false);
  });

  it("focuses when autofocus is requested", async () => {
    let editor = mountEditor({ autofocus: true, doc: "text" });
    await editor.ready;

    expect(editor.view.hasFocus).toBe(true);
  });
});

function mountEditor(options: Omit<Parameters<typeof createLiveMdEditor>[0], "parent">) {
  let parent = document.body.appendChild(document.createElement("div"));
  let editor = createLiveMdEditor({ ...options, parent });
  editors.push(editor);
  return editor;
}

function typeInto(editor: LiveMdEditorController, text: string) {
  for (let char of text) {
    let end = editor.view.state.doc.length;
    editor.view.dispatch({ changes: { from: end, insert: char }, userEvent: "input.type" });
  }
}

function installTestLocalStorage() {
  let values = new Map<string, string>();
  let storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  return storage;
}

function setVisibilityState(state: DocumentVisibilityState | undefined) {
  if (state) {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  } else {
    Reflect.deleteProperty(document, "visibilityState");
  }
}
