import { useCallback, useState } from "react";
import type { FileTreeCreateKind, FileTreeDeleteTarget } from "@/components/FileTree";
import type { TFunction } from "@/lib/i18n";
import { errorToMessage } from "@/lib/workspace/errors";
import {
  defaultNewFilePath,
  defaultNewFolderPath,
  isPathInsideDirectory,
  pathAfterDirectoryRename,
  renameWorkspaceDirectory,
} from "@/lib/workspace/paths";
import { workspaceSelectedPathContext } from "@/lib/workspace/state";
import type { FileDialogMode, SingleFileSource } from "@/lib/workspace/types";
import { clearStoredWorkspaceSelectedPath } from "@/lib/workspace-store";
import type {
  MarkdownDirectoryNode,
  MarkdownFileNode,
  WorkspaceBackend,
} from "@/lib/workspace-backend";

type MutableRef<T> = {
  current: T;
};

type UseWorkspaceEntryDialogsOptions = {
  beginDocumentTransition: (path?: string) => void;
  clearActiveDocument: () => void;
  files: MarkdownFileNode[];
  loadTree: (
    backend: WorkspaceBackend,
    nextSelectedPath?: null | string,
    options?: { saveBeforeSelect?: boolean },
  ) => Promise<void>;
  saveCurrentFile: () => Promise<boolean>;
  saveOperationRef: MutableRef<number>;
  saveTimerRef: MutableRef<number | null>;
  selectedFile: MarkdownFileNode | null;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setBusy: (busy: boolean) => void;
  setErrorMessage: (message: string) => void;
  setRetryLoadPath: (path: string | null) => void;
  singleFileSourceRef: MutableRef<SingleFileSource | null>;
  t: TFunction;
  tree: MarkdownDirectoryNode | null;
  treeSelection: FileTreeDeleteTarget | null;
  workspaceBackend: WorkspaceBackend | null;
};

export function useWorkspaceEntryDialogs({
  beginDocumentTransition,
  clearActiveDocument,
  files,
  loadTree,
  saveCurrentFile,
  saveOperationRef,
  saveTimerRef,
  selectedFile,
  selectedFileRef,
  setBusy,
  setErrorMessage,
  setRetryLoadPath,
  singleFileSourceRef,
  t,
  tree,
  treeSelection,
  workspaceBackend,
}: UseWorkspaceEntryDialogsOptions) {
  let [fileDialogMode, setFileDialogMode] = useState<FileDialogMode | null>(null);
  let [fileDialogTarget, setFileDialogTarget] = useState<FileTreeDeleteTarget | null>(null);
  let [fileDialogValue, setFileDialogValue] = useState("");
  let [fileDialogError, setFileDialogError] = useState("");
  let [deleteTarget, setDeleteTarget] = useState<FileTreeDeleteTarget | null>(null);

  let openCreateDialog = useCallback(
    (target: FileTreeDeleteTarget | null = treeSelection, kind: FileTreeCreateKind = "file") => {
      setFileDialogError("");
      setFileDialogTarget(null);
      setFileDialogValue(
        kind == "directory"
          ? defaultNewFolderPath(tree, target, t)
          : defaultNewFilePath(files, target, t),
      );
      setFileDialogMode("create");
    },
    [files, t, tree, treeSelection],
  );

  let openRenameDialog = useCallback(
    (target?: FileTreeDeleteTarget) => {
      let renameTarget =
        target ??
        (selectedFile
          ? {
              kind: "file" as const,
              name: selectedFile.name,
              path: selectedFile.path,
            }
          : null);
      if (!renameTarget) return;
      setFileDialogError("");
      setFileDialogTarget(renameTarget);
      setFileDialogValue(renameTarget.name);
      setFileDialogMode("rename");
    },
    [selectedFile],
  );

  let closeFileDialog = useCallback((open: boolean) => {
    if (!open) {
      setFileDialogMode(null);
      setFileDialogTarget(null);
      setFileDialogError("");
    }
  }, []);

  let submitFileDialog = useCallback(
    async (value: string) => {
      if (!workspaceBackend || !fileDialogMode) return;
      if (!(await saveCurrentFile())) return;

      setFileDialogError("");
      setBusy(true);
      setRetryLoadPath(null);
      try {
        let currentTarget = fileDialogTarget;
        let nextPath =
          fileDialogMode == "create"
            ? await workspaceBackend.createFile(value)
            : currentTarget?.kind == "file"
              ? await workspaceBackend.renameFile(currentTarget.path, value)
              : currentTarget?.kind == "directory"
                ? await renameWorkspaceDirectory(workspaceBackend, currentTarget.path, value)
                : null;
        let nextSelectedPath =
          currentTarget?.kind == "directory" && nextPath
            ? pathAfterDirectoryRename(
                selectedFileRef.current?.path ?? null,
                currentTarget.path,
                nextPath,
              )
            : nextPath;

        setFileDialogMode(null);
        setFileDialogTarget(null);
        let currentWorkspacePath = singleFileSourceRef.current
          ? null
          : (selectedFileRef.current?.path ?? null);
        if (nextSelectedPath && currentWorkspacePath != nextSelectedPath) {
          beginDocumentTransition(nextSelectedPath);
        }
        await loadTree(workspaceBackend, nextSelectedPath ?? currentWorkspacePath, {
          saveBeforeSelect: false,
        });
      } catch (error) {
        setFileDialogError(errorToMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [
      beginDocumentTransition,
      fileDialogMode,
      fileDialogTarget,
      loadTree,
      saveCurrentFile,
      selectedFileRef,
      setBusy,
      setRetryLoadPath,
      singleFileSourceRef,
      workspaceBackend,
    ],
  );

  let requestDeleteEntry = useCallback(
    (target: FileTreeDeleteTarget) => {
      setErrorMessage("");
      setDeleteTarget(target);
    },
    [setErrorMessage],
  );

  let closeDeleteDialog = useCallback((open: boolean) => {
    if (!open) setDeleteTarget(null);
  }, []);

  let deleteWorkspaceEntry = useCallback(async () => {
    let backend = workspaceBackend;
    let target = deleteTarget;
    if (!backend || !target) return;
    if (!(await saveCurrentFile())) return;

    setBusy(true);
    setErrorMessage("");
    setRetryLoadPath(null);
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    saveOperationRef.current += 1;
    try {
      let nextSelectedPath = singleFileSourceRef.current
        ? null
        : (selectedFileRef.current?.path ?? null);
      let deletedActiveWorkspaceDocument = false;
      if (target.kind == "directory") {
        if (!backend.deleteDirectory) throw new Error("This workspace cannot delete folders.");
        await backend.deleteDirectory(target.path);
        if (nextSelectedPath && isPathInsideDirectory(nextSelectedPath, target.path)) {
          nextSelectedPath = null;
          deletedActiveWorkspaceDocument = !singleFileSourceRef.current;
        }
      } else {
        await backend.deleteFile(target.path);
        if (nextSelectedPath == target.path) {
          nextSelectedPath = null;
          deletedActiveWorkspaceDocument = !singleFileSourceRef.current;
        }
      }

      setDeleteTarget(null);
      if (deletedActiveWorkspaceDocument) {
        let selectedPathContext = workspaceSelectedPathContext(backend);
        if (selectedPathContext) clearStoredWorkspaceSelectedPath(selectedPathContext);
        clearActiveDocument();
      }
      await loadTree(backend, nextSelectedPath, { saveBeforeSelect: false });
    } catch (error) {
      setErrorMessage(errorToMessage(error));
      setRetryLoadPath(null);
    } finally {
      setBusy(false);
    }
  }, [
    clearActiveDocument,
    deleteTarget,
    loadTree,
    saveCurrentFile,
    saveOperationRef,
    saveTimerRef,
    selectedFileRef,
    setBusy,
    setErrorMessage,
    setRetryLoadPath,
    singleFileSourceRef,
    workspaceBackend,
  ]);

  return {
    deleteTarget,
    fileDialogError,
    fileDialogMode,
    fileDialogValue,
    closeDeleteDialog,
    closeFileDialog,
    deleteWorkspaceEntry,
    openCreateDialog,
    openRenameDialog,
    requestDeleteEntry,
    setFileDialogValue,
    submitFileDialog,
  };
}
