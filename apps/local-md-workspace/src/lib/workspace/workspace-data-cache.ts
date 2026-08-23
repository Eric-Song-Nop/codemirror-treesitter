import type { QueryClient } from "@tanstack/react-query";
import { workspaceQueryKeys } from "@/lib/workspace/query-keys";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

export function readWorkspaceTree(queryClient: QueryClient, runtime: WorkspaceRuntime) {
  return queryClient.fetchQuery({
    queryKey: workspaceQueryKeys.tree(runtime.identity),
    queryFn: () => runtime.tree.readTree(),
  });
}

export async function readWorkspaceDirectory(
  queryClient: QueryClient,
  runtime: WorkspaceRuntime,
  path: string,
) {
  return queryClient.fetchQuery({
    queryKey: workspaceQueryKeys.directory(runtime.identity, path),
    queryFn: () =>
      runtime.tree.readDirectory(path, path.split("/").at(-1) ?? runtime.identity.name),
  });
}

export function readWorkspaceImageBytes(
  queryClient: QueryClient,
  runtime: WorkspaceRuntime,
  path: string,
) {
  return queryClient.fetchQuery({
    queryKey: workspaceQueryKeys.image(runtime.identity, path),
    queryFn: () => runtime.assets.read(path),
  });
}

export function removeWorkspaceImageQueries(queryClient: QueryClient, runtime: WorkspaceRuntime) {
  queryClient.removeQueries({
    queryKey: workspaceQueryKeys.images(runtime.identity),
  });
}
