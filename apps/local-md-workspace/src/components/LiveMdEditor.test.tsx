// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LiveMdConfig, LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import {
  LiveMdPreloadErrorProvider,
  useLiveMdPreload,
  type LiveMdPreloadState,
} from "@/lib/editor/live-md-preload";
import { ThemeProvider } from "@/theme";
import { LiveMdEditor } from "./LiveMdEditor";

class TestLiveMdEditorElement extends HTMLElement {
  configValues: LiveMdConfig[] = [];
  inputListenerAdds = 0;
  inputListenerRemoves = 0;
  markCleanCalls = 0;
  value = "";

  private editorConfig: LiveMdConfig = {};

  get config() {
    return this.editorConfig;
  }

  set config(value: LiveMdConfig) {
    this.editorConfig = value;
    this.configValues.push(value);
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ) {
    if (type == "input") this.inputListenerAdds++;
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: EventListenerOptions | boolean,
  ) {
    if (type == "input") this.inputListenerRemoves++;
    super.removeEventListener(type, listener, options);
  }

  markClean() {
    this.markCleanCalls++;
  }
}

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let preloadState: LiveMdPreloadState | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  if (!customElements.get("live-md-editor")) {
    customElements.define("live-md-editor", TestLiveMdEditorElement);
  }
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  preloadState = null;
  vi.restoreAllMocks();
});

describe("LiveMdEditor", () => {
  it("updates config without resetting the editor-ready lifecycle", () => {
    let onEditorReady = vi.fn();
    let onInput = vi.fn();
    let firstConfig: LiveMdConfig = {
      markdown: { features: [{ name: "first" }] },
    };
    let secondConfig: LiveMdConfig = {
      markdown: { features: [{ name: "second" }] },
    };

    renderLiveMdEditor({ config: firstConfig, onEditorReady, onInput });
    let editor = testEditorElement();

    expect(onEditorReady).toHaveBeenCalledOnce();
    expect(onEditorReady).toHaveBeenLastCalledWith(editor);
    expect(editor.config.markdown).toBe(firstConfig.markdown);
    expect(editor.config.plugins).toHaveLength(1);

    renderLiveMdEditor({ config: secondConfig, onEditorReady, onInput });

    expect(onEditorReady).toHaveBeenCalledOnce();
    expect(editor.config.markdown).toBe(secondConfig.markdown);
    expect(editor.config.plugins).toHaveLength(1);
    expect(editor.inputListenerAdds).toBe(1);
    expect(editor.inputListenerRemoves).toBe(0);
  });

  it("keeps one input listener while calling the latest input callback", () => {
    let firstInput = vi.fn();
    let secondInput = vi.fn();
    let onEditorReady = vi.fn();

    renderLiveMdEditor({ onEditorReady, onInput: firstInput });
    let editor = testEditorElement();
    renderLiveMdEditor({ onEditorReady, onInput: secondInput });

    editor.value = "updated";
    act(() => {
      editor.dispatchEvent(new Event("input"));
    });

    expect(firstInput).not.toHaveBeenCalled();
    expect(secondInput).toHaveBeenCalledWith("updated");
    expect(editor.inputListenerAdds).toBe(1);

    act(() => root?.unmount());
    root = null;

    expect(editor.inputListenerRemoves).toBe(1);
    expect(onEditorReady).toHaveBeenLastCalledWith(null);
    expect(editor.config).toEqual({});
  });

  it("rebinds editor input and ready callbacks after a successful preload retry", async () => {
    let preload = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary WASM failure"))
      .mockResolvedValueOnce(undefined);
    let onEditorReady = vi.fn();
    let onInput = vi.fn();

    await renderLiveMdEditorWithPreload({ onEditorReady, onInput, preload });
    await waitFor(() => currentPreloadState().error.includes("temporary WASM failure"));
    let firstEditor = testEditorElement();

    await act(async () => {
      await currentPreloadState().retry();
    });

    let secondEditor = testEditorElement();
    expect(secondEditor).not.toBe(firstEditor);
    expect(firstEditor.inputListenerRemoves).toBe(1);
    expect(secondEditor.inputListenerAdds).toBe(1);
    expect(onEditorReady.mock.calls.map(([editor]) => editor)).toEqual([
      firstEditor,
      null,
      secondEditor,
    ]);

    secondEditor.value = "saved after retry";
    act(() => {
      secondEditor.dispatchEvent(new Event("input"));
    });
    expect(onInput).toHaveBeenCalledWith("saved after retry");
  });
});

function renderLiveMdEditor({
  config = {},
  onEditorReady,
  onInput,
}: {
  config?: LiveMdConfig;
  onEditorReady?: (editor: LiveMdEditorElement | null) => void;
  onInput: (value: string) => void;
}) {
  if (!container) {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  }

  act(() => {
    root?.render(
      <ThemeProvider initialTheme="github-light">
        <LiveMdEditor
          config={config}
          documentKey="notes/today.md:1"
          initialValue="# Today"
          placeholder="Start writing"
          onEditorReady={onEditorReady}
          onInput={onInput}
        />
      </ThemeProvider>,
    );
  });
}

function testEditorElement() {
  let editor = document.querySelector("live-md-editor");
  if (!(editor instanceof TestLiveMdEditorElement)) {
    throw new Error("Test live-md-editor element was not mounted");
  }
  return editor;
}

async function renderLiveMdEditorWithPreload({
  onEditorReady,
  onInput,
  preload,
}: {
  onEditorReady: (editor: LiveMdEditorElement | null) => void;
  onInput: (value: string) => void;
  preload: () => Promise<void>;
}) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <LiveMdPreloadErrorProvider preload={preload}>
        <PreloadStateCapture />
        <ThemeProvider initialTheme="github-light">
          <LiveMdEditor
            config={{}}
            documentKey="notes/today.md:1"
            initialValue="# Today"
            placeholder="Start writing"
            onEditorReady={onEditorReady}
            onInput={onInput}
          />
        </ThemeProvider>
      </LiveMdPreloadErrorProvider>,
    );
  });
}

function PreloadStateCapture() {
  preloadState = useLiveMdPreload();
  return null;
}

function currentPreloadState() {
  if (!preloadState) throw new Error("Preload state is unavailable");
  return preloadState;
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error("Timed out waiting for preload state");
}
