import type { WorkspaceBackend } from "@/lib/workspace-backend";

export type SourceAutoSaveKey = "cloud" | "local";

export type SourceAutoSaveTiming = {
  delayMs: number;
  maxWaitMs: number;
};

export function sourceAutoSaveKey(backend: WorkspaceBackend | null | undefined): SourceAutoSaveKey {
  return backend?.kind == "opendal-dropbox" ||
    backend?.kind == "opendal-gdrive" ||
    backend?.kind == "opendal-onedrive"
    ? "cloud"
    : "local";
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
