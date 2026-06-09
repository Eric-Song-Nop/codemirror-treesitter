// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import { preloadLiveMdPreviewAssets } from "../src/index.js";

describe("LiveMD preview asset preloading", () => {
  it("loads the preview renderers used by KaTeX and Mermaid widgets", async () => {
    await expect(preloadLiveMdPreviewAssets()).resolves.toBeUndefined();
  });
});
