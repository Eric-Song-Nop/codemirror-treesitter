import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { createDebouncedTask } from "@/lib/scheduling/debounced-task";
import { errorToMessage } from "@/lib/workspace/errors";
import { sourceAutoSaveKey, sourceAutoSaveTiming } from "@/lib/workspace/source-autosave";
import type {
  CollaborativeDocumentSnapshot,
  WorkspaceCollaborativeDocument,
} from "@/lib/workspace/documents";
import {
  isWorkspaceFileSource,
  type SelectedFileSource,
  type EditorDocument,
  type SaveState,
  type SourceAutoSaveTask,
} from "@/lib/workspace/types";
import { normalizeMarkdownPath, type MarkdownFileNode } from "@/lib/workspace/tree";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

type MutableRef<T> = {
  current: T;
};

type UseWorkspaceSaveActionsOptions = {
  autoSaveTaskRef: MutableRef<SourceAutoSaveTask | null>;
  cleanValueRef: MutableRef<string>;
  collabDocumentRef: MutableRef<WorkspaceCollaborativeDocument | null>;
  dirtyRef: MutableRef<boolean>;
  editorValueRef: MutableRef<string>;
  saveOperationRef: MutableRef<number>;
  saveStateRef: MutableRef<SaveState>;
  scheduleAutoSaveRef: MutableRef<() => void>;
  selectedFileSourceRef: MutableRef<SelectedFileSource | null>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setEditorDocument: Dispatch<SetStateAction<EditorDocument>>;
  setErrorMessage: (message: string) => void;
  setRetryLoadPath: (path: string | null) => void;
  setSaveStateSynced: (nextState: SaveState) => void;
};

export function useWorkspaceSaveActions({
  autoSaveTaskRef,
  cleanValueRef,
  collabDocumentRef,
  dirtyRef,
  editorValueRef,
  saveOperationRef,
  saveStateRef,
  scheduleAutoSaveRef,
  selectedFileSourceRef,
  selectedFileRef,
  setEditorDocument,
  setErrorMessage,
  setRetryLoadPath,
  setSaveStateSynced,
}: UseWorkspaceSaveActionsOptions) {
  let standaloneSaveRef = useRef<Promise<boolean>>(Promise.resolve(true));

  let clearPendingSaveTimer = useCallback(() => {
    autoSaveTaskRef.current?.task.cancel();
  }, [autoSaveTaskRef]);

  let applyCollaborativeDocumentSnapshot = useCallback(
    (
      document: WorkspaceCollaborativeDocument,
      snapshot: CollaborativeDocumentSnapshot = document.snapshot(),
    ) => {
      if (collabDocumentRef.current !== document) return snapshot;

      editorValueRef.current = snapshot.value;
      dirtyRef.current = snapshot.persistenceStatus != "saved";
      setEditorDocument((current) =>
        current.path == snapshot.path && current.value == snapshot.value
          ? current
          : {
              path: snapshot.path,
              value: snapshot.value,
              version: current.version + 1,
            },
      );

      let saveState = documentSaveState(snapshot);
      setSaveStateSynced(saveState);
      if (saveState == "saved") cleanValueRef.current = snapshot.value;
      return snapshot;
    },
    [
      cleanValueRef,
      collabDocumentRef,
      dirtyRef,
      editorValueRef,
      setEditorDocument,
      setSaveStateSynced,
    ],
  );

  let saveCurrentFile = useCallback(async () => {
    let file = selectedFileRef.current;
    let document = collabDocumentRef.current;
    if (document && file?.path == document.path) {
      clearPendingSaveTimer();
      if (document.snapshot().persistenceStatus != "saved") setSaveStateSynced("saving");
      try {
        await document.flush();
        let snapshot = applyCollaborativeDocumentSnapshot(document);
        if (snapshot.persistenceStatus == "saved") {
          setErrorMessage("");
          setRetryLoadPath(null);
          return true;
        }
        return false;
      } catch (error) {
        let snapshot = applyCollaborativeDocumentSnapshot(document);
        setSaveStateSynced("error");
        setRetryLoadPath(snapshot.sourceKind == "unavailable" ? document.path : null);
        setErrorMessage(errorToMessage(error));
        return false;
      }
    }

    let source = selectedFileSourceRef.current;
    if (!source || !file || isWorkspaceFileSource(source)) return true;
    let value = editorValueRef.current;
    if (!dirtyRef.current && value == cleanValueRef.current) return true;

    clearPendingSaveTimer();
    let operation = ++saveOperationRef.current;
    let request = standaloneSaveRef.current
      .catch(() => true)
      .then(async () => {
        if (operation != saveOperationRef.current) return true;
        setSaveStateSynced("saving");
        try {
          await source.writeFile(value);
          if (
            operation == saveOperationRef.current &&
            selectedFileSourceRef.current === source &&
            selectedFileRef.current === file
          ) {
            cleanValueRef.current = value;
            if (editorValueRef.current == value) {
              dirtyRef.current = false;
              setSaveStateSynced("saved");
            }
          }
          return true;
        } catch (error) {
          if (operation == saveOperationRef.current) {
            setSaveStateSynced("error");
            setRetryLoadPath(null);
            setErrorMessage(errorToMessage(error));
          }
          return false;
        }
      });
    standaloneSaveRef.current = request;
    return request;
  }, [
    applyCollaborativeDocumentSnapshot,
    cleanValueRef,
    clearPendingSaveTimer,
    collabDocumentRef,
    dirtyRef,
    editorValueRef,
    saveOperationRef,
    selectedFileSourceRef,
    selectedFileRef,
    setErrorMessage,
    setRetryLoadPath,
    setSaveStateSynced,
  ]);

  let scheduleAutoSave = useCallback(() => {
    let key = sourceAutoSaveKey(selectedFileSourceRef.current);
    let autoSaveTask = autoSaveTaskRef.current;
    if (!autoSaveTask || autoSaveTask.key != key) {
      autoSaveTask?.task.dispose();
      let timing = sourceAutoSaveTiming(key);
      autoSaveTask = {
        key,
        task: createDebouncedTask({
          delayMs: timing.delayMs,
          maxWaitMs: timing.maxWaitMs,
          run: async () => {
            await saveCurrentFile();
          },
        }),
      };
      autoSaveTaskRef.current = autoSaveTask;
    }
    autoSaveTask.task.schedule();
  }, [autoSaveTaskRef, saveCurrentFile, selectedFileSourceRef]);
  scheduleAutoSaveRef.current = scheduleAutoSave;

  let handleEditorInput = useCallback(
    (value: string) => {
      editorValueRef.current = value;

      let document = collabDocumentRef.current;
      if (document) {
        let snapshot = document.snapshot();
        if (snapshot.value == value) {
          applyCollaborativeDocumentSnapshot(document, snapshot);
        } else {
          dirtyRef.current = true;
          if (saveStateRef.current != "pending") setSaveStateSynced("pending");
        }
        return;
      }

      dirtyRef.current = true;
      if (saveStateRef.current != "pending") setSaveStateSynced("pending");
      scheduleAutoSave();
    },
    [
      applyCollaborativeDocumentSnapshot,
      collabDocumentRef,
      dirtyRef,
      editorValueRef,
      saveStateRef,
      scheduleAutoSave,
      setSaveStateSynced,
    ],
  );

  let keepCurrentDocumentAs = useCallback(
    async (
      runtime: WorkspaceRuntime,
      file: MarkdownFileNode,
      document: WorkspaceCollaborativeDocument,
      rawPath: string,
    ) => {
      assertCurrentRecoveryDocument({
        collabDocumentRef,
        document,
        file,
        runtime,
        selectedFileRef,
        selectedFileSourceRef,
      });
      let targetPath = normalizeMarkdownPath(rawPath);
      await document.writeCopy(targetPath);
      return targetPath;
    },
    [collabDocumentRef, selectedFileRef, selectedFileSourceRef],
  );

  let resolveCurrentDocumentUseExternal = useCallback(
    async (
      runtime: WorkspaceRuntime,
      file: MarkdownFileNode,
      document: WorkspaceCollaborativeDocument,
    ) => {
      assertCurrentRecoveryDocument({
        collabDocumentRef,
        document,
        file,
        runtime,
        selectedFileRef,
        selectedFileSourceRef,
      });
      let source = document.collabState.source;
      if (source.kind != "recovery-required") {
        throw new Error("The document no longer requires external-source recovery.");
      }
      let result = await document.useExternalChange(source.incoming.revision);
      if (result.status == "incoming-changed") {
        throw new Error("The external source changed again. Review it before confirming.");
      }
      applyCollaborativeDocumentSnapshot(document);
      setErrorMessage("");
      setRetryLoadPath(null);
    },
    [
      applyCollaborativeDocumentSnapshot,
      collabDocumentRef,
      selectedFileRef,
      selectedFileSourceRef,
      setErrorMessage,
      setRetryLoadPath,
    ],
  );

  let recreateCurrentDocumentSource = useCallback(
    async (
      runtime: WorkspaceRuntime,
      file: MarkdownFileNode,
      document: WorkspaceCollaborativeDocument,
    ) => {
      assertCurrentRecoveryDocument({
        collabDocumentRef,
        document,
        file,
        runtime,
        selectedFileRef,
        selectedFileSourceRef,
      });
      await document.recreateSource();
      applyCollaborativeDocumentSnapshot(document);
      setErrorMessage("");
      setRetryLoadPath(null);
    },
    [
      applyCollaborativeDocumentSnapshot,
      collabDocumentRef,
      selectedFileRef,
      selectedFileSourceRef,
      setErrorMessage,
      setRetryLoadPath,
    ],
  );

  return {
    applyCollaborativeDocumentSnapshot,
    clearPendingSaveTimer,
    handleEditorInput,
    keepCurrentDocumentAs,
    recreateCurrentDocumentSource,
    resolveCurrentDocumentUseExternal,
    saveCurrentFile,
    scheduleAutoSave,
  };
}

function documentSaveState(snapshot: CollaborativeDocumentSnapshot): SaveState {
  switch (snapshot.persistenceStatus) {
    case "pending":
      return "pending";
    case "saving":
      return "saving";
    case "saved":
      return "saved";
    case "blocked":
    case "error":
      return "error";
  }
}

function assertCurrentRecoveryDocument(input: {
  collabDocumentRef: MutableRef<WorkspaceCollaborativeDocument | null>;
  document: WorkspaceCollaborativeDocument;
  file: MarkdownFileNode;
  runtime: WorkspaceRuntime;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  selectedFileSourceRef: MutableRef<SelectedFileSource | null>;
}) {
  if (
    input.selectedFileSourceRef.current !== input.runtime ||
    input.selectedFileRef.current?.path != input.file.path ||
    input.collabDocumentRef.current !== input.document
  ) {
    throw new Error("The selected document changed before recovery completed.");
  }
}
