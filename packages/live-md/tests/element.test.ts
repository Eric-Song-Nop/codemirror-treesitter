// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  defineLiveMdEditor,
  LiveMdEditorElement,
  liveMarkdown,
  type LiveMdEditorElement as LiveMdEditorElementType,
} from "../src/index.js";

let tagId = 0;
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
  globalThis.localStorage?.clear();
  vi.restoreAllMocks();
  if (locationDescriptor) {
    Object.defineProperty(globalThis, "location", locationDescriptor);
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
