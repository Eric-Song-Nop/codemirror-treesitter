import { useCallback, type Dispatch, type SetStateAction } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { WorkspaceDocumentIntentLease } from "@/app/document-session-coordinator";
import type { FileTreeDeleteTarget } from "@/components/FileTree";
import type { AccessFileHandle } from "@/lib/workspace/file-system";
import { clearStoredWorkspaceSelectedPath } from "@/lib/workspace/store";
import {
  findMarkdownFile,
  findMarkdownDirectory,
  replaceMarkdownDirectory,
  type MarkdownDirectoryNode,
  type MarkdownFileNode,
} from "@/lib/workspace/tree";
import { dirname } from "pathe";
import { workspaceSelectedPathContext } from "@/lib/workspace/state";
import { readWorkspaceDirectory, readWorkspaceTree } from "@/lib/workspace/workspace-data-cache";
import {
  activeDocumentSourceId,
  type ActiveDocumentSource,
  type SingleFileSource,
} from "@/lib/workspace/types";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

type MutableRef<T> = {
  current: T;
};

type UseWorkspaceTreeOptions = {
  clearActiveDocument: () => Promise<void>;
  documentTargetGenerationRef: MutableRef<number>;
  loadFile: (
    runtime: WorkspaceRuntime,
    file: MarkdownFileNode,
    options?: { intent?: WorkspaceDocumentIntentLease; saveCurrent?: boolean },
  ) => Promise<boolean>;
  localFileHandleRef: MutableRef<AccessFileHandle | null>;
  selectedFileSourceRef: MutableRef<ActiveDocumentSource | null>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setTree: Dispatch<SetStateAction<MarkdownDirectoryNode | null>>;
  setTreeSelection: (target: FileTreeDeleteTarget | null) => void;
  singleFileSourceRef: MutableRef<SingleFileSource | null>;
};

export function useWorkspaceTree({
  clearActiveDocument,
  documentTargetGenerationRef,
  loadFile,
  localFileHandleRef,
  selectedFileSourceRef,
  selectedFileRef,
  setTree,
  setTreeSelection,
  singleFileSourceRef,
}: UseWorkspaceTreeOptions) {
  let queryClient = useQueryClient();

  let loadTree = useCallback(
    async (
      runtime: WorkspaceRuntime,
      nextSelectedPath?: null | string,
      options: {
        documentIntent?: WorkspaceDocumentIntentLease;
        saveBeforeSelect?: boolean;
      } = {},
    ) => {
      documentTargetGenerationRef.current += 1;
      let nextTree = await loadSelectedPathAncestors(
        runtime,
        await readWorkspaceTree(queryClient, runtime),
        nextSelectedPath ?? null,
        queryClient,
      );
      setTree(nextTree);

      let nextSelectedFile = findMarkdownFile(nextTree, nextSelectedPath ?? null);

      if (nextSelectedFile) {
        await loadFile(runtime, nextSelectedFile, {
          intent: options.documentIntent,
          saveCurrent: options.saveBeforeSelect ?? true,
        });
        return;
      }

      if (nextSelectedPath) {
        let selectedPathContext = workspaceSelectedPathContext(runtime.identity);
        if (selectedPathContext) clearStoredWorkspaceSelectedPath(selectedPathContext);
        if (
          !singleFileSourceRef.current &&
          selectedFileSourceRef.current &&
          activeDocumentSourceId(selectedFileSourceRef.current) == runtime.identity.id &&
          selectedFileRef.current?.path == nextSelectedPath
        ) {
          await clearActiveDocument();
        }
      }
      setTreeSelection(null);
    },
    [
      clearActiveDocument,
      documentTargetGenerationRef,
      loadFile,
      selectedFileSourceRef,
      selectedFileRef,
      setTree,
      setTreeSelection,
      singleFileSourceRef,
      queryClient,
    ],
  );

  let findCurrentEditorWorkspacePath = useCallback(
    async (runtime: WorkspaceRuntime) => {
      let source = singleFileSourceRef.current;
      let file = selectedFileRef.current;
      if (
        !source &&
        file &&
        selectedFileSourceRef.current &&
        activeDocumentSourceId(selectedFileSourceRef.current) == runtime.identity.id
      ) {
        return file.path;
      }

      if (source?.kind == "local-file" && localFileHandleRef.current) {
        return (await runtime.host.findFilePathForHandle?.(localFileHandleRef.current)) ?? null;
      }

      if (source?.kind == "dropbox-file" && runtime.identity.kind == "opendal-dropbox") {
        return source.path;
      }
      return null;
    },
    [localFileHandleRef, selectedFileSourceRef, selectedFileRef, singleFileSourceRef],
  );

  let refreshWorkspaceForCurrentEditor = useCallback(
    async (runtime: WorkspaceRuntime) => {
      let nextSelectedPath = await findCurrentEditorWorkspacePath(runtime).catch(() => null);
      await loadTree(runtime, nextSelectedPath, { saveBeforeSelect: false });
    },
    [findCurrentEditorWorkspacePath, loadTree],
  );

  let loadDirectory = useCallback(
    async (runtime: WorkspaceRuntime, path: string) => {
      let directory = await readWorkspaceDirectory(queryClient, runtime, path);
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
  runtime: WorkspaceRuntime,
  tree: MarkdownDirectoryNode,
  selectedPath: string | null,
  queryClient: QueryClient,
) {
  if (!selectedPath || findMarkdownFile(tree, selectedPath)) return tree;

  for (let directoryPath of ancestorDirectoryPaths(selectedPath)) {
    let directory = findMarkdownDirectory(tree, directoryPath);
    if (!directory) break;
    if (directory.childrenLoaded) continue;

    let loadedDirectory = await readWorkspaceDirectory(queryClient, runtime, directoryPath);
    if (!loadedDirectory) break;
    tree = replaceMarkdownDirectory(tree, loadedDirectory);
    if (findMarkdownFile(tree, selectedPath)) break;
  }

  return tree;
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
