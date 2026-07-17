import { describe, expect, it } from "vite-plus/test";
import {
  createLiveMdRenderCache,
  liveMdRenderCacheLimits,
} from "../src/core/runtime/render-cache.js";

describe("LiveMD render cache bounds", () => {
  it("bounds every long-lived render cache", () => {
    let cache = createLiveMdRenderCache();
    for (let [name, limit] of Object.entries(liveMdRenderCacheLimits)) {
      let map = cache[name as keyof typeof liveMdRenderCacheLimits] as Map<string, unknown>;
      for (let index = 0; index <= limit; index++) map.set(`key-${index}`, index);
      expect(map.size, name).toBe(limit);
      expect(map.has("key-0"), name).toBe(false);
      expect(map.has(`key-${limit}`), name).toBe(true);
    }
  });

  it("retains a recently used render result when evicting", () => {
    let images = createLiveMdRenderCache().images as Map<string, unknown>;
    for (let index = 0; index < 256; index++) images.set(`key-${index}`, index);

    expect(images.get("key-0")).toBe(0);
    images.set("key-256", 256);

    expect(images.has("key-0")).toBe(true);
    expect(images.has("key-1")).toBe(false);
  });
});
