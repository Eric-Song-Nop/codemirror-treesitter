// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  defineLiveMdEditor,
  LiveMdEditorElement,
  liveMarkdown,
  type LiveMdEditorElement as LiveMdEditorElementType,
  type LiveMdPlugin,
} from "../src/index.js";

let tagId = 0;
let locationDescriptor: PropertyDescriptor | undefined;
let localStorageDescriptor: PropertyDescriptor | undefined;
let localStorageStubbed = false;

beforeEach(() => {
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  localStorageStubbed = false;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  document.body.replaceChildren();
  if (localStorageStubbed) globalThis.localStorage.clear();
  vi.restoreAllMocks();
  if (locationDescriptor) {
    Object.defineProperty(globalThis, "location", locationDescriptor);
  }
  if (localStorageStubbed) {
    if (localStorageDescriptor) {
      Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
});

describe("liveMd editor web component", () => {
  it("register entry defines the default element", async () => {
    await import("../src/register.js");

    expect(customElements.get("live-md-editor")).toBe(LiveMdEditorElement);
  });

  it("dispatches live-md-ready when async editor support is loaded", async () => {
    let tag = defineTestElement();
    let editor = document.createElement(tag) as LiveMdEditorElementType;
    let ready = vi.fn();
    editor.addEventListener("live-md-ready", ready);

    document.body.append(editor);
    await editor.ready;

    expect(ready).toHaveBeenCalledTimes(1);
    let [event] = ready.mock.calls[0] as [CustomEvent];
    expect(event.detail.view).toBe(editor.view);
  });

  it("dispatches live-md-error when async editor support fails", async () => {
    let tag = defineTestElement();
    let editor = document.createElement(tag) as LiveMdEditorElementType;
    let errorEvent = waitForEvent<CustomEvent>(editor, "live-md-error");
    vi.spyOn(EditorView.prototype, "dispatch").mockImplementationOnce(() => {
      throw new Error("language dispatch failed");
    });

    document.body.append(editor);

    await expect(editor.ready).rejects.toThrow("language dispatch failed");
    await expect(errorEvent).resolves.toMatchObject({
      detail: { error: expect.any(Error) },
    });
  });

  it("registers a custom element with an open shadow root", async () => {
    let tag = defineTestElement();
    let editor = document.createElement(tag) as LiveMdEditorElementType;
    editor.defaultValue = "# Hello";
    document.body.append(editor);

    await editor.ready;

    expect(editor).toBeInstanceOf(LiveMdEditorElement);
    expect(editor.shadowRoot).toBeTruthy();
    expect(editor.shadowRoot?.querySelector(".live-md-editor-root")).toBeTruthy();
    expect(editor.view).toBeTruthy();
    expect(editor.value).toBe("# Hello");
  });

  it("supports defaultValue and value replacement", async () => {
    let editor = mountTestEditor("initial");
    await editor.ready;

    expect(editor.value).toBe("initial");

    editor.value = "replacement";

    expect(editor.getAttribute("value")).toBeNull();
    expect(editor.value).toBe("replacement");
    expect(editor.view?.state.doc.toString()).toBe("replacement");
  });

  it("uses light DOM text as the initial default value", async () => {
    let tag = defineTestElement();
    let editor = document.createElement(tag) as LiveMdEditorElementType;
    editor.textContent = `
      # Light DOM

      Markdown starts in the element body.
    `;
    document.body.append(editor);
    await editor.ready;

    expect(editor.value).toBe("# Light DOM\n\nMarkdown starts in the element body.");
  });

  it("updates readonly state from the attribute and property", async () => {
    let editor = mountTestEditor("readonly");
    await editor.ready;

    editor.setAttribute("readonly", "");
    expect(editor.readOnly).toBe(true);
    expect(editor.view?.state.readOnly).toBe(true);

    editor.readOnly = false;
    expect(editor.hasAttribute("readonly")).toBe(false);
    expect(editor.view?.state.readOnly).toBe(false);
  });

  it("dispatches input on editor edits and change on blur", async () => {
    let editor = mountTestEditor("doc");
    let input = vi.fn();
    let change = vi.fn();
    editor.addEventListener("input", input);
    editor.addEventListener("change", change);
    await editor.ready;

    editor.view?.dispatch({
      changes: { from: editor.value.length, insert: "!" },
      userEvent: "input.test",
    });
    editor.view?.contentDOM.dispatchEvent(new FocusEvent("blur"));

    expect(input).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe("doc!");
  });

  it("exposes textarea-compatible selection properties", async () => {
    let editor = mountTestEditor("abcdef");
    let select = vi.fn();
    editor.addEventListener("select", select);
    await editor.ready;

    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(0);

    editor.setSelectionRange(1, 4);

    expect(editor.selectionStart).toBe(1);
    expect(editor.selectionEnd).toBe(4);
    expect(editor.view?.state.selection.main.from).toBe(1);
    expect(editor.view?.state.selection.main.to).toBe(4);
    expect(select).toHaveBeenCalledTimes(1);

    editor.selectionStart = 3;

    expect(editor.selectionStart).toBe(3);
    expect(editor.selectionEnd).toBe(4);
    expect(select).toHaveBeenCalledTimes(2);

    editor.selectionEnd = 2;

    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(2);
    expect(select).toHaveBeenCalledTimes(3);

    editor.setSelectionRange(-5, 999);

    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(editor.value.length);
    expect(select).toHaveBeenCalledTimes(4);

    editor.setSelectionRange(5, 2);

    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(2);
    expect(select).toHaveBeenCalledTimes(5);
  });

  it("selects the full value", async () => {
    let editor = mountTestEditor("select me");
    let select = vi.fn();
    editor.addEventListener("select", select);
    await editor.ready;

    editor.select();

    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(editor.value.length);
    expect(editor.view?.state.selection.main.from).toBe(0);
    expect(editor.view?.state.selection.main.to).toBe(editor.value.length);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("surfaces direct CodeMirror selection changes", async () => {
    let editor = mountTestEditor("abcdef");
    await editor.ready;
    let select = vi.fn();
    editor.addEventListener("select", select);

    editor.view?.dispatch({ selection: { anchor: 2, head: 5 } });

    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(5);
    expect(select).toHaveBeenCalledTimes(1);

    editor.view?.dispatch({ selection: { anchor: 2, head: 5 } });

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("does not emit select when document edits remap the cursor", async () => {
    let editor = mountTestEditor("abcdef");
    await editor.ready;
    let select = vi.fn();
    editor.addEventListener("select", select);

    editor.setSelectionRange(3, 3);
    select.mockClear();

    editor.view?.dispatch({
      changes: { from: 0, insert: "x" },
      userEvent: "input.test",
    });

    expect(editor.value).toBe("xabcdef");
    expect(editor.selectionStart).toBe(4);
    expect(editor.selectionEnd).toBe(4);
    expect(select).not.toHaveBeenCalled();
  });

  it("does not emit select when programmatic value updates reset the cursor", async () => {
    let editor = mountTestEditor("abcdef");
    await editor.ready;
    let select = vi.fn();
    editor.addEventListener("select", select);

    editor.setSelectionRange(2, 5);
    select.mockClear();

    editor.value = "xyz";

    expect(editor.value).toBe("xyz");
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });

  it("preserves pending selection across disconnects", async () => {
    let tag = defineTestElement();
    let editor = document.createElement(tag) as LiveMdEditorElementType;
    editor.defaultValue = "abcdef";
    editor.setSelectionRange(2, 5);

    document.body.append(editor);
    await editor.ready;

    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(5);

    editor.remove();
    expect(editor.view).toBeNull();

    editor.setSelectionRange(1, 3);
    document.body.append(editor);
    await editor.ready;

    expect(editor.selectionStart).toBe(1);
    expect(editor.selectionEnd).toBe(3);
  });

  it("tracks dirty by comparing against the clean value", async () => {
    let tag = defineTestElement();
    let editor = document.createElement(tag) as LiveMdEditorElementType;
    editor.value = "clean";
    document.body.append(editor);
    await editor.ready;

    expect(editor.dirty).toBe(false);

    editor.view?.dispatch({
      changes: { from: editor.value.length, insert: "!" },
      userEvent: "input.test",
    });

    expect(editor.value).toBe("clean!");
    expect(editor.dirty).toBe(true);

    editor.view?.dispatch({
      changes: { from: "clean".length, to: "clean!".length },
      userEvent: "input.test",
    });

    expect(editor.value).toBe("clean");
    expect(editor.dirty).toBe(false);

    editor.value = "programmatic";

    expect(editor.dirty).toBe(true);

    editor.markClean();

    expect(editor.dirty).toBe(false);

    editor.view?.dispatch({
      changes: { from: editor.value.length, insert: "!" },
      userEvent: "input.test",
    });

    expect(editor.dirty).toBe(true);

    editor.view?.dispatch({
      changes: { from: "programmatic".length, to: "programmatic!".length },
      userEvent: "input.test",
    });

    expect(editor.value).toBe("programmatic");
    expect(editor.dirty).toBe(false);
  });

  it("does not write localStorage unless persist-key is set", async () => {
    let setItem = vi.spyOn(Storage.prototype, "setItem");
    let editor = mountTestEditor("doc");
    await editor.ready;

    editor.view?.dispatch({
      changes: { from: editor.value.length, insert: "!" },
      userEvent: "input.test",
    });

    expect(setItem).not.toHaveBeenCalled();
  });

  it("uses a persisted empty value instead of the default value", async () => {
    let storage = installTestLocalStorage([["live-md-empty", ""]]);
    let editor = mountPersistedTestEditor("fallback", "live-md-empty");
    await editor.ready;

    expect(storage.getItem).toHaveBeenCalledWith("live-md-empty");
    expect(editor.value).toBe("");
  });

  it("uses the default value when no persisted value exists", async () => {
    let storage = installTestLocalStorage();
    let editor = mountPersistedTestEditor("fallback", "live-md-missing");
    await editor.ready;

    expect(storage.getItem).toHaveBeenCalledWith("live-md-missing");
    expect(editor.value).toBe("fallback");
  });

  it("keeps multiple editors independent", async () => {
    let first = mountTestEditor("first");
    let second = mountTestEditor("second");
    await Promise.all([first.ready, second.ready]);

    first.view?.dispatch({
      changes: { from: first.value.length, insert: "!" },
      userEvent: "input.test",
    });

    expect(first.value).toBe("first!");
    expect(second.value).toBe("second");
  });

  it("accepts optional CodeMirror extensions from a property", async () => {
    let tag = defineTestElement();
    let editor = document.createElement(tag) as LiveMdEditorElementType;
    let observed = vi.fn();
    editor.defaultValue = "doc";
    editor.extensions = [
      EditorView.updateListener.of((update) => {
        if (update.docChanged) observed(update.state.doc.toString());
      }),
    ];
    document.body.append(editor);
    await editor.ready;

    editor.view?.dispatch({
      changes: { from: editor.value.length, insert: "!" },
      userEvent: "input.test",
    });

    expect(observed).toHaveBeenCalledWith("doc!");
  });

  it("reconfigures optional CodeMirror extensions while mounted", async () => {
    let editor = mountTestEditor("doc");
    let first = vi.fn();
    let second = vi.fn();
    await editor.ready;

    editor.extensions = [
      EditorView.updateListener.of((update) => {
        if (update.docChanged) first();
      }),
    ];
    editor.view?.dispatch({
      changes: { from: editor.value.length, insert: "!" },
      userEvent: "input.test",
    });

    editor.extensions = [
      EditorView.updateListener.of((update) => {
        if (update.docChanged) second();
      }),
    ];
    editor.view?.dispatch({
      changes: { from: editor.value.length, insert: "?" },
      userEvent: "input.test",
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("accepts markdown and plugins from properties", async () => {
    let tag = defineTestElement();
    let editor = document.createElement(tag) as LiveMdEditorElementType;
    let observed = vi.fn();
    let cleanup = vi.fn();
    let plugin: LiveMdPlugin = {
      extension: EditorView.updateListener.of((update) => {
        if (update.docChanged) observed(update.state.doc.toString());
      }),
      mount({ markdown }) {
        observed(markdown.features?.[0]?.name);
        return cleanup;
      },
    };
    editor.defaultValue = "doc";
    editor.markdown = { features: [{ name: "frontmatter" }] };
    editor.plugins = [plugin];

    document.body.append(editor);
    await editor.ready;
    editor.view?.dispatch({
      changes: { from: editor.value.length, insert: "!" },
      userEvent: "input.test",
    });
    editor.plugins = [];

    expect(observed).toHaveBeenCalledWith("frontmatter");
    expect(observed).toHaveBeenCalledWith("doc!");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("accepts unified config from a property", async () => {
    let tag = defineTestElement();
    let editor = document.createElement(tag) as LiveMdEditorElementType;
    let observed = vi.fn();
    let cleanup = vi.fn();
    let plugin: LiveMdPlugin = {
      extension: EditorView.updateListener.of((update) => {
        if (update.docChanged) observed(update.state.doc.toString());
      }),
      mount({ markdown }) {
        observed(markdown.features?.[0]?.name);
        return cleanup;
      },
    };
    editor.defaultValue = "doc";
    editor.config = {
      markdown: { features: [{ name: "unified" }] },
      plugins: [plugin],
    };

    document.body.append(editor);
    await editor.ready;
    editor.view?.dispatch({
      changes: { from: editor.value.length, insert: "!" },
      userEvent: "input.test",
    });
    editor.config = { markdown: { features: [{ name: "updated" }] } };

    expect(observed).toHaveBeenCalledWith("unified");
    expect(observed).toHaveBeenCalledWith("doc!");
    expect(editor.markdown.features?.[0]?.name).toBe("updated");
    expect(editor.plugins).toHaveLength(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("remounts plugins when markdown changes after connection", async () => {
    let tag = defineTestElement();
    let editor = document.createElement(tag) as LiveMdEditorElementType;
    let observed: string[] = [];
    editor.plugins = [
      {
        mount({ markdown }) {
          observed.push(markdown.features?.[0]?.name ?? "none");
          return () => observed.push("cleanup");
        },
      },
    ];

    document.body.append(editor);
    await editor.ready;
    editor.markdown = { features: [{ name: "callouts" }] };
    editor.plugins = [];

    expect(observed).toEqual(["none", "cleanup", "callouts", "cleanup"]);
  });

  it("cleans up on disconnect and remounts with the current value", async () => {
    let editor = mountTestEditor("before");
    await editor.ready;

    editor.value = "after";
    editor.remove();
    expect(editor.view).toBeNull();

    document.body.append(editor);
    await editor.ready;

    expect(editor.value).toBe("after");
    expect(editor.view).toBeTruthy();
  });

  it("injects styles only into the shadow root", async () => {
    let editor = mountTestEditor("styled");
    await editor.ready;

    expect(document.head.querySelector("style[data-live-md-runtime]")).toBeNull();
    expect(document.querySelector(".cm-md-heading")).toBeNull();
    expect(hasShadowRuntimeStyles(editor)).toBe(true);
    expect(editor.shadowRoot?.querySelectorAll("style[data-live-md-runtime]")).toHaveLength(1);
  });

  it("exports the reusable CodeMirror extension", () => {
    expect(liveMarkdown()).toBeTruthy();
  });
});

function defineTestElement() {
  let tag = `live-md-editor-test-${++tagId}`;
  defineLiveMdEditor(tag);
  return tag;
}

function mountTestEditor(defaultValue: string) {
  let tag = defineTestElement();
  let editor = document.createElement(tag) as LiveMdEditorElementType;
  editor.defaultValue = defaultValue;
  document.body.append(editor);
  return editor;
}

function mountPersistedTestEditor(defaultValue: string, persistKey: string) {
  let tag = defineTestElement();
  let editor = document.createElement(tag) as LiveMdEditorElementType;
  editor.defaultValue = defaultValue;
  editor.persistKey = persistKey;
  document.body.append(editor);
  return editor;
}

function installTestLocalStorage(entries: [string, string][] = []) {
  let values = new Map(entries);
  let storage = {
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  } as Pick<Storage, "clear" | "getItem" | "setItem">;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  localStorageStubbed = true;
  return storage;
}

function hasShadowRuntimeStyles(editor: LiveMdEditorElementType) {
  return Boolean(
    editor.shadowRoot?.querySelector("style[data-live-md-runtime]") ||
    editor.shadowRoot?.adoptedStyleSheets.length,
  );
}

function waitForEvent<EventType extends Event>(target: EventTarget, type: string) {
  return new Promise<EventType>((resolve) => {
    target.addEventListener(type, (event) => resolve(event as EventType), { once: true });
  });
}
