// @vitest-environment happy-dom

import { act, lazy } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { SharedFileRoute } from "./App";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe("shared file route chunk loading", () => {
  it("shows a visible route shell while the editor chunk is loading", async () => {
    let PendingEditor = lazy(() => new Promise<{ default: () => null }>(() => {}));

    await renderRoute(PendingEditor);

    expect(document.querySelector('[role="status"]')?.textContent).toContain("Loading shared file");
    expect(document.querySelector("main")?.getAttribute("aria-busy")).toBe("true");
  });

  it("shows a recoverable error instead of a blank page when the editor chunk fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let FailedEditor = lazy(() => Promise.reject(new Error("offline chunk miss")));

    await renderRoute(FailedEditor);
    await waitFor(() => document.querySelector('[role="alert"]') != null);

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load the shared editor",
    );
    expect(document.querySelector("button")?.textContent).toContain("Retry");
  });
});

async function renderRoute(editor: Parameters<typeof SharedFileRoute>[0]["editor"]) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(<SharedFileRoute editor={editor} />);
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempts = 0; attempts < 20; attempts++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for route state.");
}
