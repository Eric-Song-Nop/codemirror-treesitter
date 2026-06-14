import type { OwnerShareRecord } from "@/lib/collaboration/share-storage";
import type { WorkspaceImageNode } from "@/lib/workspace-backend";

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

export type WorkspaceImageAsset = WorkspaceImageNode & {
  url: string;
};

export type ActiveOwnerShareRecord = OwnerShareRecord & {
  guestCount?: number;
  hostOnline?: boolean;
  peerCount?: number;
  pendingHostSave?: boolean;
};
