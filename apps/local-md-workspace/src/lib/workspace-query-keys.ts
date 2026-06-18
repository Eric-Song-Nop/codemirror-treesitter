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

const workspaceMutationKeyBase = [...workspaceQueryKeys.all, "mutation"] as const;

export const workspaceMutationKeys = {
  all: workspaceMutationKeyBase,
  deleteEntry: [...workspaceMutationKeyBase, "delete-entry"] as const,
  exportHtml: [...workspaceMutationKeyBase, "export-html"] as const,
  insertImages: [...workspaceMutationKeyBase, "insert-images"] as const,
  openDropboxWorkspace: [...workspaceMutationKeyBase, "open-dropbox-workspace"] as const,
  openFile: [...workspaceMutationKeyBase, "open-file"] as const,
  openWorkspace: [...workspaceMutationKeyBase, "open-workspace"] as const,
  printPdf: [...workspaceMutationKeyBase, "print-pdf"] as const,
  refreshWorkspace: [...workspaceMutationKeyBase, "refresh-workspace"] as const,
  restoreWorkspace: [...workspaceMutationKeyBase, "restore-workspace"] as const,
  saveAsDropbox: [...workspaceMutationKeyBase, "save-as-dropbox"] as const,
  saveAsLocal: [...workspaceMutationKeyBase, "save-as-local"] as const,
  shareFile: [...workspaceMutationKeyBase, "share-file"] as const,
  submitEntryDialog: [...workspaceMutationKeyBase, "submit-entry-dialog"] as const,
};
