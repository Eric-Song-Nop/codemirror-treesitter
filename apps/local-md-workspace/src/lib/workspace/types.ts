import type { OwnerShareRecord } from "@/lib/collaboration/share-storage";
import type { DebouncedTask } from "@/lib/scheduling/debounced-task";
import type { SourceAutoSaveKey } from "@/lib/workspace/source-autosave";
import type { WorkspaceRuntime } from "@/lib/workspace-runtime/types";

export type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

export type FileDialogMode = "create" | "rename";

export type SingleFileSource =
  | {
      draftId: string;
      kind: "draft";
      name: string;
    }
  | {
      kind: "local-file";
      name: string;
    }
  | {
      kind: "dropbox-file";
      name: string;
      path: string;
    };

export type EditorDocument = {
  path: string;
  value: string;
  version: number;
};

export type StandaloneDocumentSource = {
  id: string;
  kind: "standalone";
  readFile(): Promise<string>;
  writeFile(value: string): Promise<void>;
};

export type ActiveDocumentSource = StandaloneDocumentSource | WorkspaceRuntime;

export function isWorkspaceDocumentSource(
  source: ActiveDocumentSource | null | undefined,
): source is WorkspaceRuntime {
  return Boolean(source && "identity" in source);
}

export function activeDocumentSourceId(source: ActiveDocumentSource) {
  return isWorkspaceDocumentSource(source) ? source.identity.id : source.id;
}

export type WorkspaceImageAsset = {
  file: File;
  name: string;
  path: string;
  url: string;
};

export type ActiveOwnerShareRecord = OwnerShareRecord & {
  guestCount?: number;
  hostOnline?: boolean;
  peerCount?: number;
  pendingHostSave?: boolean;
};

export type SourceAutoSaveTask = {
  key: SourceAutoSaveKey;
  task: DebouncedTask;
};
