import type { WorkspaceIdentity } from "@/lib/workspace/runtime/types";

export const workspaceQueryKeys = {
  all: ["local-md-workspace"] as const,
  workspace: (identity: Pick<WorkspaceIdentity, "id">) =>
    [...workspaceQueryKeys.all, "workspace", identity.id] as const,
  directory: (identity: Pick<WorkspaceIdentity, "id">, path: string) =>
    [...workspaceQueryKeys.workspace(identity), "directory", path] as const,
  document: (identity: Pick<WorkspaceIdentity, "id">, path: string) =>
    [...workspaceQueryKeys.workspace(identity), "document", path] as const,
  images: (identity: Pick<WorkspaceIdentity, "id">) =>
    [...workspaceQueryKeys.workspace(identity), "image"] as const,
  image: (identity: Pick<WorkspaceIdentity, "id">, path: string) =>
    [...workspaceQueryKeys.images(identity), path] as const,
  sharedSession: (relayOrigin: string, shareId: string, guestSecretToken: string) =>
    [...workspaceQueryKeys.all, "shared-session", relayOrigin, shareId, guestSecretToken] as const,
  tree: (identity: Pick<WorkspaceIdentity, "id">) =>
    [...workspaceQueryKeys.workspace(identity), "tree"] as const,
};
