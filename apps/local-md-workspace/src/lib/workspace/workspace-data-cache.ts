import type { QueryClient } from "@tanstack/react-query";
import { basename } from "pathe";
import { workspaceQueryKeys } from "@/lib/workspace-query-keys";
import { buildMarkdownDirectoryFromEntries, type WorkspaceBackend } from "@/lib/workspace-backend";

export function readWorkspaceTree(queryClient: QueryClient, backend: WorkspaceBackend) {
  return queryClient.fetchQuery({
    queryKey: workspaceQueryKeys.tree(backend),
    queryFn: () => backend.readTree(),
  });
}

export async function readWorkspaceDirectory(
  queryClient: QueryClient,
  backend: WorkspaceBackend,
  path: string,
) {
  if (!backend.listEntries) return null;

  let entries = await queryClient.fetchQuery({
    queryKey: workspaceQueryKeys.directory(backend, path),
    queryFn: () => backend.listEntries!(path),
  });
  return buildMarkdownDirectoryFromEntries(directoryName(path, backend.name), path, entries);
}

export function readWorkspaceImageBytes(
  queryClient: QueryClient,
  backend: WorkspaceBackend,
  path: string,
) {
  if (!backend.readBytes) return Promise.resolve(null);

  return queryClient.fetchQuery({
    queryKey: workspaceQueryKeys.image(backend, path),
    queryFn: () => backend.readBytes!(path),
  });
}

export function removeWorkspaceImageQueries(queryClient: QueryClient, backend: WorkspaceBackend) {
  queryClient.removeQueries({
    queryKey: workspaceQueryKeys.images(backend),
  });
}

function directoryName(path: string, rootName: string) {
  return path ? basename(path) : rootName;
}
