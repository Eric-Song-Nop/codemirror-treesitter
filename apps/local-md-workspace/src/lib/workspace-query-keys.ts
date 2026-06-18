import type { WorkspaceBackend } from "@/lib/workspace-backend";

export const workspaceQueryKeys = {
  all: ["local-md-workspace"] as const,
  backend: (backend: Pick<WorkspaceBackend, "id">) =>
    [...workspaceQueryKeys.all, "backend", backend.id] as const,
  directory: (backend: Pick<WorkspaceBackend, "id">, path: string) =>
    [...workspaceQueryKeys.backend(backend), "directory", path] as const,
  document: (backend: Pick<WorkspaceBackend, "id">, path: string) =>
    [...workspaceQueryKeys.backend(backend), "document", path] as const,
  images: (backend: Pick<WorkspaceBackend, "id">) =>
    [...workspaceQueryKeys.backend(backend), "image"] as const,
  image: (backend: Pick<WorkspaceBackend, "id">, path: string) =>
    [...workspaceQueryKeys.images(backend), path] as const,
  sharedSession: (relayOrigin: string, shareId: string, guestSecretToken: string) =>
    [...workspaceQueryKeys.all, "shared-session", relayOrigin, shareId, guestSecretToken] as const,
  tree: (backend: Pick<WorkspaceBackend, "id">) =>
    [...workspaceQueryKeys.backend(backend), "tree"] as const,
};
