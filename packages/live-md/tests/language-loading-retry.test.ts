import { describe, expect, it, vi } from "vite-plus/test";

const markdownLoader = vi.hoisted(() => ({ calls: 0, fail: true }));

vi.mock("@codemirror-treesitter/language-data/live-md", async (importOriginal) => {
  let actual =
    await importOriginal<typeof import("@codemirror-treesitter/language-data/live-md")>();
  return {
    ...actual,
    async loadMarkdownParserService() {
      markdownLoader.calls++;
      if (markdownLoader.fail) throw new Error("temporary Markdown service failure");
      return actual.loadMarkdownParserService();
    },
  };
});

describe("LiveMD language loading", () => {
  it("retries a failed Markdown extension load and caches the successful extension", async () => {
    let { loadMarkdownExtension } = await import("../src/core/languages.js");

    await expect(loadMarkdownExtension()).rejects.toThrow("temporary Markdown service failure");
    markdownLoader.fail = false;
    let extension = await loadMarkdownExtension();

    await expect(loadMarkdownExtension()).resolves.toBe(extension);
    expect(markdownLoader.calls).toBe(2);
  });
});
