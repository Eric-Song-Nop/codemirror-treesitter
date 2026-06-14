import { useCallback } from "react";
import type { FileTreeDeleteTarget } from "@/components/FileTree";
import type { AccessFileHandle } from "@/lib/file-system";
import { clearStoredWorkspaceSelectedPath } from "@/lib/workspace-store";
import {
  flattenMarkdownFiles,
  type MarkdownDirectoryNode,
  type MarkdownFileNode,
  type WorkspaceBackend,
  type WorkspaceImageNode,
} from "@/lib/workspace-backend";
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
  replaceWorkspaceImageAssets: (nextImageNodes: WorkspaceImageNode[]) => Promise<void>;
  selectedFileBackendRef: MutableRef<WorkspaceBackend | null>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setFiles: (files: MarkdownFileNode[]) => void;
  setTree: (tree: MarkdownDirectoryNode | null) => void;
  setTreeSelection: (target: FileTreeDeleteTarget | null) => void;
  singleFileSourceRef: MutableRef<SingleFileSource | null>;
};

export function useWorkspaceTree({
  clearActiveDocument,
  loadFile,
  localFileHandleRef,
  replaceWorkspaceImageAssets,
  selectedFileBackendRef,
  selectedFileRef,
  setFiles,
  setTree,
  setTreeSelection,
  singleFileSourceRef,
}: UseWorkspaceTreeOptions) {
  let loadTree = useCallback(
    async (
      backend: WorkspaceBackend,
      nextSelectedPath?: null | string,
      options: { saveBeforeSelect?: boolean } = {},
    ) => {
      let [nextTree, nextImageNodes] = await Promise.all([
        backend.readTree(),
        backend.readImages?.() ?? Promise.resolve([]),
      ]);
      await replaceWorkspaceImageAssets(nextImageNodes);
      let nextFiles = flattenMarkdownFiles(nextTree);
      setTree(nextTree);
      setFiles(nextFiles);

      let nextSelectedFile = nextSelectedPath
        ? (nextFiles.find((file) => file.path == nextSelectedPath) ?? null)
        : null;

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
      replaceWorkspaceImageAssets,
      selectedFileBackendRef,
      selectedFileRef,
      setFiles,
      setTree,
      setTreeSelection,
      singleFileSourceRef,
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

  return {
    findCurrentEditorWorkspacePath,
    loadTree,
    refreshWorkspaceForCurrentEditor,
  };
}
