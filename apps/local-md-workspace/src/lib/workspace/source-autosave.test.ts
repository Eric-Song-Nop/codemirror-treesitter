import { describe, expect, it } from "vite-plus/test";
import { sourceAutoSaveKey, sourceAutoSaveTiming } from "./source-autosave.ts";

describe("source autosave scheduling", () => {
  it("uses the local cadence for regular workspace backends", () => {
    expect(sourceAutoSaveKey(null)).toBe("local");
    expect(sourceAutoSaveTiming("local")).toEqual({
      delayMs: 900,
      maxWaitMs: 5000,
    });
  });

  it("uses the slower cadence for Dropbox-backed workspaces", () => {
    expect(
      sourceAutoSaveKey({
        id: "dropbox:test",
        kind: "opendal-dropbox",
        name: "Dropbox",
      } as Parameters<typeof sourceAutoSaveKey>[0]),
    ).toBe("dropbox");
    expect(sourceAutoSaveTiming("dropbox")).toEqual({
      delayMs: 2500,
      maxWaitMs: 10_000,
    });
  });
});
