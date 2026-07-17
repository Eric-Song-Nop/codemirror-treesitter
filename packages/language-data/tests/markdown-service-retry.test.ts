import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TreeSitterParser } from "@codemirror-treesitter/language";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Markdown parser service loading", () => {
  it("retries after a transient grammar load failure and caches the successful service", async () => {
    let loadParser = TreeSitterParser.load.bind(TreeSitterParser);
    let failLoads = true;
    let grammarLoad = vi.spyOn(TreeSitterParser, "load").mockImplementation((...arguments_) => {
      if (failLoads) return Promise.reject(new Error("temporary grammar fetch failure"));
      return loadParser(...arguments_);
    });
    let { loadMarkdownParserService } = await import("../src/index.js");

    await expect(loadMarkdownParserService()).rejects.toThrow("temporary grammar fetch failure");
    failLoads = false;
    let service = await loadMarkdownParserService();

    await expect(loadMarkdownParserService()).resolves.toBe(service);
    expect(grammarLoad.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
