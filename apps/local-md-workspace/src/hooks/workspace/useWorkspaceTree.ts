import { useCallback, type Dispatch, type SetStateAction } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { FileTreeDeleteTarget } from "@/components/FileTree";
import type { AccessFileHandle } from "@/lib/file-system";
import { workspaceQueryKeys } from "@/lib/workspace-query-keys";
import { clearStoredWorkspaceSelectedPath } from "@/lib/workspace-store";
import {
  buildMarkdownDirectoryFromEntries,
  findMarkdownFile,
  findMarkdownDirectory,
  replaceMarkdownDirectory,
  type MarkdownDirectoryNode,
  type MarkdownFileNode,
  type WorkspaceBackend,
} from "@/lib/workspace-backend";
import { basename, dirname } from "pathe";
import { workspaceSelectedPathContext } from "@/lib/workspace/state";
import type { SingleFileSource } from "@/lib/workspace/types";

type MutableRef<T> = {
  current: T;
};

type UseWorkspaceTreeOptions = {
  clearActiveDocument: () => void;
  loadFile: (
    backend: WorkspaceBackend,
    file: MarkdownFileNode,
    options?: { saveCurrent?: boolean },
  ) => Promise<void>;
  localFileHandleRef: MutableRef<AccessFileHandle | null>;
  selectedFileBackendRef: MutableRef<WorkspaceBackend | null>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setTree: Dispatch<SetStateAction<MarkdownDirectoryNode | null>>;
  setTreeSelection: (target: FileTreeDeleteTarget | null) => void;
  singleFileSourceRef: MutableRef<SingleFileSource | null>;
};

export function useWorkspaceTree({
  clearActiveDocument,
  loadFile,
  localFileHandleRef,
  selectedFileBackendRef,
  selectedFileRef,
  setTree,
  setTreeSelection,
  singleFileSourceRef,
}: UseWorkspaceTreeOptions) {
  let queryClient = useQueryClient();

  let loadTree = useCallback(
    async (
      backend: WorkspaceBackend,
      nextSelectedPath?: null | string,
      options: { saveBeforeSelect?: boolean } = {},
    ) => {
      let nextTree = await loadSelectedPathAncestors(
        backend,
        await readBackendTree(queryClient, backend),
        nextSelectedPath ?? null,
        queryClient,
      );
      setTree(nextTree);

      let nextSelectedFile = findMarkdownFile(nextTree, nextSelectedPath ?? null);

      if (nextSelectedFile) {
        await loadFile(backend, nextSelectedFile, {
          saveCurrent: options.saveBeforeSelect ?? true,
        });
        return;
      }

      if (nextSelectedPath) {
        let selectedPathContext = workspaceSelectedPathContext(backend);
        if (selectedPathContext) clearStoredWorkspaceSelectedPath(selectedPathContext);
        if (
          !singleFileSourceRef.current &&
          selectedFileBackendRef.current?.id == backend.id &&
          selectedFileRef.current?.path == nextSelectedPath
        ) {
          clearActiveDocument();
        }
      }
      setTreeSelection(null);
    },
    [
      clearActiveDocument,
      loadFile,
      selectedFileBackendRef,
      selectedFileRef,
      setTree,
      setTreeSelection,
      singleFileSourceRef,
      queryClient,
    ],
  );

  let findCurrentEditorWorkspacePath = useCallback(
    async (backend: WorkspaceBackend) => {
      let source = singleFileSourceRef.current;
      let file = selectedFileRef.current;
      if (!source && file && selectedFileBackendRef.current?.id == backend.id) return file.path;

      if (source?.kind == "local-file" && localFileHandleRef.current) {
        return (await backend.findFilePathForHandle?.(localFileHandleRef.current)) ?? null;
      }

      if (source?.kind == "dropbox-file" && backend.kind == "opendal-dropbox") {
        return source.path;
      }
      return null;
    },
    [localFileHandleRef, selectedFileBackendRef, selectedFileRef, singleFileSourceRef],
  );

  let refreshWorkspaceForCurrentEditor = useCallback(
    async (backend: WorkspaceBackend) => {
      let nextSelectedPath = await findCurrentEditorWorkspacePath(backend).catch(() => null);
      await loadTree(backend, nextSelectedPath, { saveBeforeSelect: false });
    },
    [findCurrentEditorWorkspacePath, loadTree],
  );

  let loadDirectory = useCallback(
    async (backend: WorkspaceBackend, path: string) => {
      let directory = await readBackendDirectory(queryClient, backend, path);
      if (!directory) return;
      setTree((currentTree) =>
        currentTree ? replaceMarkdownDirectory(currentTree, directory) : currentTree,
      );
    },
    [queryClient, setTree],
  );

  return {
    findCurrentEditorWorkspacePath,
    loadDirectory,
    loadTree,
    refreshWorkspaceForCurrentEditor,
  };
}

async function loadSelectedPathAncestors(
  backend: WorkspaceBackend,
  tree: MarkdownDirectoryNode,
  selectedPath: string | null,
  queryClient: QueryClient,
) {
  if (!selectedPath || findMarkdownFile(tree, selectedPath)) return tree;

  for (let directoryPath of ancestorDirectoryPaths(selectedPath)) {
    let directory = findMarkdownDirectory(tree, directoryPath);
    if (!directory) break;
    if (directory.childrenLoaded) continue;

    let loadedDirectory = await readBackendDirectory(queryClient, backend, directoryPath);
    if (!loadedDirectory) break;
    tree = replaceMarkdownDirectory(tree, loadedDirectory);
    if (findMarkdownFile(tree, selectedPath)) break;
  }

  return tree;
}

function readBackendTree(queryClient: QueryClient, backend: WorkspaceBackend) {
  return queryClient.fetchQuery({
    queryKey: workspaceQueryKeys.tree(backend),
    queryFn: () => backend.readTree(),
  });
}

async function readBackendDirectory(
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

function ancestorDirectoryPaths(filePath: string) {
  let directoryPath = dirname(filePath);
  if (directoryPath == ".") return [];

  let paths: string[] = [];
  let current = "";
  for (let part of directoryPath.split("/")) {
    current = current ? `${current}/${part}` : part;
    paths.push(current);
  }
  return paths;
}

function directoryName(path: string, rootName: string) {
  return path ? basename(path) : rootName;
}
