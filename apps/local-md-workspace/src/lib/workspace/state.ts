import type { AccessDirectoryHandle } from "@/lib/file-system";
import type { TFunction } from "@/lib/i18n";
import {
  loadStoredWorkspaceSelectedPath,
  type StoredLocalWorkspaceRecord,
  type StoredWorkspaceSelectedPathContext,
} from "@/lib/workspace-store";
import type { MarkdownFileNode } from "@/lib/workspace-tree";
import type { WorkspaceIdentity } from "@/lib/workspace-runtime/types";
import type { SaveState, SingleFileSource } from "@/lib/workspace/types";

export function saveStateLabel(
  saveState: SaveState,
  selectedFile: MarkdownFileNode | null,
  singleFileSource: SingleFileSource | null,
  t: TFunction,
) {
  if (!selectedFile) return t("save.noFile");
  switch (saveState) {
    case "pending":
      return t("save.pending");
    case "saving":
      return t("save.saving");
    case "error":
      return t("save.error");
    case "idle":
    case "saved":
      return singleFileSource?.kind == "draft" ? t("save.draft") : t("save.saved");
  }
}

export function createEphemeralLocalWorkspaceRecord(
  handle: AccessDirectoryHandle,
): StoredLocalWorkspaceRecord {
  return {
    handle,
    id: createEphemeralLocalWorkspaceId(handle),
    lastOpenedAt: Date.now(),
    name: handle.name || "Workspace",
  };
}

export function workspaceSelectedPathContext(
  identity: WorkspaceIdentity,
): StoredWorkspaceSelectedPathContext | null {
  if (identity.kind == "local") return { kind: "local", workspaceId: identity.id };
  if (identity.kind == "opendal-dropbox") return { kind: "dropbox", workspaceId: identity.id };
  if (identity.kind == "opendal-gdrive") return { kind: "gdrive", workspaceId: identity.id };
  if (identity.kind == "opendal-onedrive") return { kind: "onedrive", workspaceId: identity.id };
  return null;
}

export function loadWorkspaceSelectedPath(identity: WorkspaceIdentity) {
  let context = workspaceSelectedPathContext(identity);
  return context ? loadStoredWorkspaceSelectedPath(context) : null;
}

function createEphemeralLocalWorkspaceId(handle: AccessDirectoryHandle) {
  return `local:${handle.name || "workspace"}`;
}
