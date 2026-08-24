import { useCallback, useState } from "react";
import type { WorkspaceDocumentIntentLease } from "@/app/document-session-coordinator";
import type { FileTreeCreateKind, FileTreeDeleteTarget } from "@/components/FileTree";
import type { TFunction } from "@/lib/i18n";
import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import { errorToMessage } from "@/lib/workspace/errors";
import {
  defaultNewFilePath,
  defaultNewFolderPath,
  isPathInsideDirectory,
  pathAfterDirectoryRename,
} from "@/lib/workspace/paths";
import { workspaceSelectedPathContext } from "@/lib/workspace/state";
import type { FileDialogMode, SingleFileSource, SourceAutoSaveTask } from "@/lib/workspace/types";
import { clearStoredWorkspaceSelectedPath } from "@/lib/workspace/store";
import type { MarkdownDirectoryNode, MarkdownFileNode } from "@/lib/workspace/tree";
import type { SourceRevision, WorkspacePathMutationResult } from "@/lib/workspace/storage/types";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

type MutableRef<T> = {
  current: T;
};

type UseWorkspaceEntryDialogsOptions = {
  autoSaveTaskRef: MutableRef<SourceAutoSaveTask | null>;
  beginDocumentTransition: (path?: string) => WorkspaceDocumentIntentLease;
  clearActiveDocument: () => Promise<void>;
  closeActiveDocumentSession: () => Promise<void>;
  collabDocumentRef: MutableRef<CollabDocumentState | null>;
  documentTargetGenerationRef: MutableRef<number>;
  finishDocumentTransition: (lease: WorkspaceDocumentIntentLease) => void;
  loadTree: (
    runtime: WorkspaceRuntime,
    nextSelectedPath?: null | string,
    options?: {
      documentIntent?: WorkspaceDocumentIntentLease;
      saveBeforeSelect?: boolean;
    },
  ) => Promise<void>;
  saveCurrentFile: () => Promise<boolean>;
  saveOperationRef: MutableRef<number>;
  selectedFile: MarkdownFileNode | null;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setBusy: (busy: boolean) => void;
  setErrorMessage: (message: string) => void;
  setRetryLoadPath: (path: string | null) => void;
  singleFileSourceRef: MutableRef<SingleFileSource | null>;
  t: TFunction;
  tree: MarkdownDirectoryNode | null;
  treeSelection: FileTreeDeleteTarget | null;
  workspaceRuntime: WorkspaceRuntime | null;
};

export function useWorkspaceEntryDialogs({
  autoSaveTaskRef,
  beginDocumentTransition,
  clearActiveDocument,
  closeActiveDocumentSession,
  collabDocumentRef,
  documentTargetGenerationRef,
  finishDocumentTransition,
  loadTree,
  saveCurrentFile,
  saveOperationRef,
  selectedFile,
  selectedFileRef,
  setBusy,
  setErrorMessage,
  setRetryLoadPath,
  singleFileSourceRef,
  t,
  tree,
  treeSelection,
  workspaceRuntime,
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
          : defaultNewFilePath(tree, target, t),
      );
      setFileDialogMode("create");
    },
    [t, tree, treeSelection],
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
      if (!workspaceRuntime || !fileDialogMode) return;
      documentTargetGenerationRef.current += 1;
      if (!(await saveCurrentFile())) return;

      setFileDialogError("");
      setBusy(true);
      setRetryLoadPath(null);
      let currentTarget = fileDialogTarget;
      let currentWorkspacePath = singleFileSourceRef.current
        ? null
        : (selectedFileRef.current?.path ?? null);
      let closesActiveSession =
        fileDialogMode == "rename" &&
        Boolean(
          currentTarget &&
          currentWorkspacePath &&
          entryContainsPath(currentTarget, currentWorkspacePath),
        );
      let reopenPath = currentWorkspacePath;
      let revision =
        currentTarget?.kind == "file" && currentTarget.path == currentWorkspacePath
          ? activeDocumentRevision(collabDocumentRef.current)
          : undefined;
      let documentIntent: WorkspaceDocumentIntentLease | null = null;
      try {
        if (closesActiveSession) await closeActiveDocumentSession();
        let nextPath =
          fileDialogMode == "create"
            ? await workspaceRuntime.entries.create(value)
            : currentTarget?.kind == "file"
              ? await renameWorkspaceEntry(workspaceRuntime, currentTarget, value, revision)
              : currentTarget?.kind == "directory"
                ? await renameWorkspaceEntry(workspaceRuntime, currentTarget, value)
                : null;
        let nextSelectedPath =
          currentTarget?.kind == "directory" && nextPath
            ? pathAfterDirectoryRename(currentWorkspacePath, currentTarget.path, nextPath)
            : nextPath;
        if (closesActiveSession) reopenPath = nextSelectedPath;

        setFileDialogMode(null);
        setFileDialogTarget(null);
        if (nextSelectedPath && currentWorkspacePath != nextSelectedPath) {
          documentIntent = beginDocumentTransition(nextSelectedPath);
        }
        await loadTree(workspaceRuntime, nextSelectedPath ?? currentWorkspacePath, {
          documentIntent: documentIntent ?? undefined,
          saveBeforeSelect: false,
        });
      } catch (error) {
        if (closesActiveSession && reopenPath) {
          await loadTree(workspaceRuntime, reopenPath, { saveBeforeSelect: false }).catch(() => {});
        }
        setFileDialogError(errorToMessage(error));
      } finally {
        if (documentIntent) finishDocumentTransition(documentIntent);
        setBusy(false);
      }
    },
    [
      beginDocumentTransition,
      closeActiveDocumentSession,
      collabDocumentRef,
      documentTargetGenerationRef,
      fileDialogMode,
      fileDialogTarget,
      finishDocumentTransition,
      loadTree,
      saveCurrentFile,
      selectedFileRef,
      setBusy,
      setRetryLoadPath,
      singleFileSourceRef,
      workspaceRuntime,
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
    let runtime = workspaceRuntime;
    let target = deleteTarget;
    if (!runtime || !target) return;
    documentTargetGenerationRef.current += 1;
    if (!(await saveCurrentFile())) return;

    let activePath = singleFileSourceRef.current ? null : (selectedFileRef.current?.path ?? null);
    let deletesActiveDocument = Boolean(activePath && entryContainsPath(target, activePath));
    setBusy(true);
    setErrorMessage("");
    setRetryLoadPath(null);
    autoSaveTaskRef.current?.task.cancel();
    saveOperationRef.current += 1;
    let revision =
      target.kind == "file" && target.path == activePath
        ? activeDocumentRevision(collabDocumentRef.current)
        : undefined;
    try {
      if (deletesActiveDocument) await closeActiveDocumentSession();
      assertEntryMutationApplied(
        await runtime.entries.delete({ kind: target.kind, path: target.path, revision }),
        target.path,
      );
      let nextSelectedPath = deletesActiveDocument ? null : activePath;

      setDeleteTarget(null);
      if (deletesActiveDocument) {
        let selectedPathContext = workspaceSelectedPathContext(runtime.identity);
        if (selectedPathContext) clearStoredWorkspaceSelectedPath(selectedPathContext);
        await clearActiveDocument();
      }
      await loadTree(runtime, nextSelectedPath, { saveBeforeSelect: false });
    } catch (error) {
      if (deletesActiveDocument && activePath) {
        await loadTree(runtime, activePath, { saveBeforeSelect: false }).catch(() => {});
      }
      setErrorMessage(errorToMessage(error));
      setRetryLoadPath(null);
    } finally {
      setBusy(false);
    }
  }, [
    clearActiveDocument,
    closeActiveDocumentSession,
    collabDocumentRef,
    autoSaveTaskRef,
    deleteTarget,
    documentTargetGenerationRef,
    loadTree,
    saveCurrentFile,
    saveOperationRef,
    selectedFileRef,
    setBusy,
    setErrorMessage,
    setRetryLoadPath,
    singleFileSourceRef,
    workspaceRuntime,
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

async function renameWorkspaceEntry(
  runtime: WorkspaceRuntime,
  target: FileTreeDeleteTarget,
  rawName: string,
  revision?: SourceRevision,
) {
  let renamed = await runtime.entries.rename({
    kind: target.kind,
    path: target.path,
    rawName,
    revision,
  });
  assertEntryMutationApplied(renamed.result, target.path);
  return renamed.path;
}

function entryContainsPath(target: FileTreeDeleteTarget, path: string) {
  return target.kind == "directory"
    ? isPathInsideDirectory(path, target.path)
    : path == target.path;
}

function activeDocumentRevision(document: CollabDocumentState | null) {
  return document?.source.kind == "present" ? document.source.baseline.revision : undefined;
}

function assertEntryMutationApplied(result: WorkspacePathMutationResult, path: string) {
  if (result.status == "applied") return;
  if (result.status == "conflict") {
    throw new Error(`Workspace mutation conflict for ${path}: ${result.reason}.`);
  }
  throw new Error(`Workspace mutation for ${path} ended with ${result.status}; refresh required.`);
}
