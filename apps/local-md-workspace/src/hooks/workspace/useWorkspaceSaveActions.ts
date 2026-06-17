import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { VersionVector } from "loro-crdt";
import {
  acknowledgeCollabDocumentSourceSaved,
  captureCollabDocumentMaterialization,
  collabDocumentNeedsSourceWrite,
  getCollabDocumentValue,
  ingestExternalMarkdownEdit,
  saveCollabDocumentSnapshot,
  schedulePendingCollabDocumentUpdateFlush,
  type CollabDocumentState,
  type CollabSourceImportResult,
} from "@/lib/collaboration/markdown-document";
import { createCollabDocumentBroadcastSync } from "@/lib/collaboration/document-sync";
import { isWorkspaceWriteConflictError } from "@/lib/workspace-file-conflict";
import { errorToMessage } from "@/lib/workspace/errors";
import type { EditorDocument, SaveState } from "@/lib/workspace/types";
import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";

type MutableRef<T> = {
  current: T;
};

type UseWorkspaceSaveActionsOptions = {
  activeDocumentGenerationRef: MutableRef<number>;
  cleanValueRef: MutableRef<string>;
  collabDocumentRef: MutableRef<CollabDocumentState | null>;
  collabSyncCleanupRef: MutableRef<() => void>;
  dirtyRef: MutableRef<boolean>;
  editVersionRef: MutableRef<number>;
  editorValueRef: MutableRef<string>;
  saveOperationRef: MutableRef<number>;
  saveStateRef: MutableRef<SaveState>;
  saveTimerRef: MutableRef<number | null>;
  scheduleAutoSaveRef: MutableRef<() => void>;
  selectedFileBackendRef: MutableRef<WorkspaceBackend | null>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  sendHostDocumentUpdate: (path: string, update: Uint8Array | null) => void;
  sendHostSaveAck: (path: string, value: string, savedVersion: VersionVector) => void;
  setEditorDocument: Dispatch<SetStateAction<EditorDocument>>;
  setErrorMessage: (message: string) => void;
  setRetryLoadPath: (path: string | null) => void;
  setSaveStateSynced: (nextState: SaveState) => void;
};

export function useWorkspaceSaveActions({
  activeDocumentGenerationRef,
  cleanValueRef,
  collabDocumentRef,
  collabSyncCleanupRef,
  dirtyRef,
  editVersionRef,
  editorValueRef,
  saveOperationRef,
  saveStateRef,
  saveTimerRef,
  scheduleAutoSaveRef,
  selectedFileBackendRef,
  selectedFileRef,
  sendHostDocumentUpdate,
  sendHostSaveAck,
  setEditorDocument,
  setErrorMessage,
  setRetryLoadPath,
  setSaveStateSynced,
}: UseWorkspaceSaveActionsOptions) {
  let clearPendingSaveTimer = useCallback(() => {
    if (saveTimerRef.current == null) return;
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  }, [saveTimerRef]);

  let applyCollabDocumentValue = useCallback(
    (document: CollabDocumentState, value = getCollabDocumentValue(document)) => {
      if (collabDocumentRef.current !== document) return value;
      editorValueRef.current = value;
      editVersionRef.current += 1;
      setEditorDocument((current) => ({
        path: document.path,
        value,
        version: current.version + 1,
      }));
      return value;
    },
    [collabDocumentRef, editVersionRef, editorValueRef, setEditorDocument],
  );

  let saveCurrentFile = useCallback(async () => {
    let backend = selectedFileBackendRef.current;
    let file = selectedFileRef.current;
    if (!backend || !file) return true;
    let documentGeneration = activeDocumentGenerationRef.current;

    let selectedDocument = collabDocumentRef.current;
    let document = selectedDocument?.path == file.path ? selectedDocument : null;
    let value = document ? getCollabDocumentValue(document) : editorValueRef.current;
    let editVersion = editVersionRef.current;
    if (!document && !dirtyRef.current && value == cleanValueRef.current) return true;

    clearPendingSaveTimer();

    if (!document && value == cleanValueRef.current) {
      dirtyRef.current = false;
      setSaveStateSynced("saved");
      return true;
    }

    let operation = ++saveOperationRef.current;
    let isCurrentSaveTarget = () =>
      operation == saveOperationRef.current &&
      documentGeneration == activeDocumentGenerationRef.current &&
      selectedFileBackendRef.current === backend &&
      selectedFileRef.current === file;
    setSaveStateSynced("saving");

    try {
      let sourceImport: CollabSourceImportResult | null = null;
      if (document) {
        sourceImport = await ingestExternalMarkdownEdit(backend, document);
        if (sourceImport) {
          sendHostDocumentUpdate(file.path, sourceImport.update);
          value = applyCollabDocumentValue(document, sourceImport.value);
        } else {
          value = getCollabDocumentValue(document);
        }
        editVersion = editVersionRef.current;

        if (
          !sourceImport &&
          !collabDocumentNeedsSourceWrite(document) &&
          !dirtyRef.current &&
          value == cleanValueRef.current
        ) {
          if (isCurrentSaveTarget()) setSaveStateSynced("saved");
          return true;
        }
      }

      if (document && document.path == file.path) {
        let materialization = captureCollabDocumentMaterialization(document);
        value = materialization.value;
        await saveCollabDocumentSnapshot(backend, document);
        await backend.writeFile(file.path, materialization.value);
        await acknowledgeCollabDocumentSourceSaved(backend, document, materialization.value, {
          externalEdit: sourceImport?.externalEdit,
          frontiers: materialization.frontiers,
          versionVector: materialization.versionVector,
        });
        sendHostSaveAck(file.path, materialization.value, materialization.version);
      } else {
        await backend.writeFile(file.path, value);
      }
      if (isCurrentSaveTarget()) {
        cleanValueRef.current = value;
        if (editVersion == editVersionRef.current) {
          dirtyRef.current = false;
          setSaveStateSynced("saved");
        }
      }
      return true;
    } catch (error) {
      if (isWorkspaceWriteConflictError(error)) {
        try {
          let externalValue = await backend.readFile(file.path);
          if (document && document.path == file.path) {
            let sourceImport: CollabSourceImportResult | null = null;
            if (externalValue != value) {
              sourceImport = await ingestExternalMarkdownEdit(backend, document, externalValue);
              if (sourceImport) sendHostDocumentUpdate(file.path, sourceImport.update);
              value = applyCollabDocumentValue(document, getCollabDocumentValue(document));
            }

            let materialization = captureCollabDocumentMaterialization(document);
            value = materialization.value;
            await saveCollabDocumentSnapshot(backend, document);
            if (externalValue != materialization.value) {
              await backend.writeFile(file.path, materialization.value);
            }
            await acknowledgeCollabDocumentSourceSaved(backend, document, materialization.value, {
              externalEdit: sourceImport?.externalEdit,
              frontiers: materialization.frontiers,
              versionVector: materialization.versionVector,
            });
            sendHostSaveAck(file.path, materialization.value, materialization.version);
            if (isCurrentSaveTarget()) {
              cleanValueRef.current = value;
              if (editVersion == editVersionRef.current) {
                dirtyRef.current = false;
                setSaveStateSynced("saved");
              }
            }
            return true;
          }

          if (externalValue == value) {
            if (isCurrentSaveTarget()) {
              cleanValueRef.current = value;
              if (editVersion == editVersionRef.current) {
                dirtyRef.current = false;
                setSaveStateSynced("saved");
              }
            }
            return true;
          }
        } catch {
          // Fall through to the original storage error below.
        }
      }

      if (!isCurrentSaveTarget()) return true;
      setSaveStateSynced("error");
      setRetryLoadPath(null);
      setErrorMessage(errorToMessage(error));
      return false;
    }
  }, [
    activeDocumentGenerationRef,
    applyCollabDocumentValue,
    cleanValueRef,
    clearPendingSaveTimer,
    collabDocumentRef,
    dirtyRef,
    editVersionRef,
    editorValueRef,
    saveOperationRef,
    selectedFileBackendRef,
    selectedFileRef,
    sendHostDocumentUpdate,
    sendHostSaveAck,
    setErrorMessage,
    setRetryLoadPath,
    setSaveStateSynced,
  ]);

  let scheduleAutoSave = useCallback(() => {
    clearPendingSaveTimer();

    let delay = selectedFileBackendRef.current?.kind == "opendal-dropbox" ? 2500 : 650;
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveCurrentFile();
    }, delay);
  }, [clearPendingSaveTimer, saveCurrentFile, saveTimerRef, selectedFileBackendRef]);
  scheduleAutoSaveRef.current = scheduleAutoSave;

  let handleRemoteCollabDocumentUpdate = useCallback(
    async (backend: WorkspaceBackend, document: CollabDocumentState) => {
      if (collabDocumentRef.current !== document) return;
      try {
        editorValueRef.current = getCollabDocumentValue(document);
        editVersionRef.current += 1;
        dirtyRef.current = true;
        setSaveStateSynced("pending");
        await saveCollabDocumentSnapshot(backend, document);
        scheduleAutoSaveRef.current();
      } catch (error) {
        setSaveStateSynced("error");
        setErrorMessage(errorToMessage(error));
      }
    },
    [
      collabDocumentRef,
      dirtyRef,
      editVersionRef,
      editorValueRef,
      scheduleAutoSaveRef,
      setErrorMessage,
      setSaveStateSynced,
    ],
  );

  let bindCollabDocumentBroadcast = useCallback(
    (backend: WorkspaceBackend, document: CollabDocumentState) => {
      collabSyncCleanupRef.current = createCollabDocumentBroadcastSync({
        backend,
        doc: document.doc,
        docId: document.docId,
        onRemoteUpdate: () => {
          void handleRemoteCollabDocumentUpdate(backend, document);
        },
      });
    },
    [collabSyncCleanupRef, handleRemoteCollabDocumentUpdate],
  );

  let handleEditorInput = useCallback(
    (value: string) => {
      editorValueRef.current = value;
      let document = collabDocumentRef.current;
      if (document) schedulePendingCollabDocumentUpdateFlush(document);
      editVersionRef.current += 1;
      dirtyRef.current = true;

      if (saveStateRef.current != "pending") {
        setSaveStateSynced("pending");
      }

      scheduleAutoSave();
    },
    [
      collabDocumentRef,
      dirtyRef,
      editVersionRef,
      editorValueRef,
      saveStateRef,
      scheduleAutoSave,
      setSaveStateSynced,
    ],
  );

  return {
    bindCollabDocumentBroadcast,
    clearPendingSaveTimer,
    handleEditorInput,
    saveCurrentFile,
    scheduleAutoSave,
  };
}
