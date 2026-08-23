import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceStorageKind } from "@/lib/workspace/storage/types";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";
import { sourceAutoSaveKey, sourceAutoSaveTiming } from "./source-autosave.ts";

describe("source autosave scheduling", () => {
  it("uses the local cadence for regular workspace backends", () => {
    expect(sourceAutoSaveKey(null)).toBe("local");
    expect(sourceAutoSaveTiming("local")).toEqual({
      delayMs: 900,
      maxWaitMs: 5000,
    });
  });

  it("uses the slower cadence for cloud-backed workspaces", () => {
    for (let kind of ["opendal-dropbox", "opendal-gdrive", "opendal-onedrive"] as const) {
      expect(sourceAutoSaveKey(runtime(kind))).toBe("cloud");
    }
    expect(sourceAutoSaveTiming("cloud")).toEqual({
      delayMs: 2500,
      maxWaitMs: 10_000,
    });
  });
});

function runtime(kind: WorkspaceStorageKind): WorkspaceRuntime {
  return {
    identity: { id: `${kind}:test`, kind, name: kind },
  } as WorkspaceRuntime;
}
