// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vite-plus/test";
import { LiveMdEditorElement } from "../src/element/live-md-editor.js";

const prepareLiveMd = vi.hoisted(() => vi.fn());

vi.mock("../src/core/languages.js", async (importOriginal) => {
  let actual = await importOriginal<typeof import("../src/core/languages.js")>();
  return {
    ...actual,
    prepareLiveMd,
  };
});

describe("live-md register entry", () => {
  it("defines the default element when Markdown preload fails", async () => {
    let error = new Error("markdown wasm failed");
    prepareLiveMd.mockRejectedValueOnce(error);
    let errorEvent = waitForEvent<CustomEvent>(globalThis, "live-md-error");

    await import("../src/register.js");

    expect(customElements.get("live-md-editor")).toBe(LiveMdEditorElement);
    await expect(errorEvent).resolves.toMatchObject({
      detail: { error },
    });
  });
});

function waitForEvent<T extends Event>(target: EventTarget, type: string) {
  return new Promise<T>((resolve) => {
    target.addEventListener(type, (event) => resolve(event as T), { once: true });
  });
}
