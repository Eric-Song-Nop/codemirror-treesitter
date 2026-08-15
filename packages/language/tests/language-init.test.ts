import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Parser as TSParser } from "web-tree-sitter";
import { TreeSitterParser } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TreeSitterParser initialization", () => {
  it("retries after a failed initialization while keeping successful initialization cached", async () => {
    let failure = new Error("temporary WASM fetch failure");
    let initialize = vi
      .spyOn(TSParser, "init")
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);

    await expect(TreeSitterParser.init()).rejects.toBe(failure);
    await expect(TreeSitterParser.init()).resolves.toBeUndefined();
    await expect(TreeSitterParser.init()).resolves.toBeUndefined();

    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
