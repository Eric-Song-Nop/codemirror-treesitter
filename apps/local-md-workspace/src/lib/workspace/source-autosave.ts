import { isWorkspaceFileSource, type SelectedFileSource } from "@/lib/workspace/types";

export type SourceAutoSaveKey = "cloud" | "local";

export type SourceAutoSaveTiming = {
  delayMs: number;
  maxWaitMs: number;
};

export function sourceAutoSaveKey(
  source: SelectedFileSource | null | undefined,
): SourceAutoSaveKey {
  return isWorkspaceFileSource(source) && source.identity.kind != "local" ? "cloud" : "local";
}

export function sourceAutoSaveTiming(key: SourceAutoSaveKey): SourceAutoSaveTiming {
  return key == "cloud"
    ? {
        delayMs: 2500,
        maxWaitMs: 10_000,
      }
    : {
        delayMs: 900,
        maxWaitMs: 5000,
      };
}
