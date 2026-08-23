import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { SerializedCollabVersionVector } from "@/lib/collaboration/collab-browser-store";
import {
  acknowledgeCollabDocumentSourceSaved,
  captureCollabDocumentMaterialization,
  collabDocumentNeedsSourceWrite,
  getCollabDocumentValue,
  ingestExternalMarkdownEdit,
  ingestExternalMarkdownObservation,
  resolveCollabRecoveryUseExternal,
  saveCollabDocumentSnapshot,
  schedulePendingCollabDocumentUpdateFlush,
  type CollabDocumentState,
  type CollabSourceImportResult,
} from "@/lib/collaboration/markdown-document";
import { createCollabDocumentBroadcastSync } from "@/lib/collaboration/document-sync";
import { createDebouncedTask } from "@/lib/scheduling/debounced-task";
import { isWorkspaceWriteConflictError } from "@/lib/workspace/file-conflict";
import { errorToMessage } from "@/lib/workspace/errors";
import { sourceAutoSaveKey, sourceAutoSaveTiming } from "@/lib/workspace/source-autosave";
import {
  activeDocumentSourceId,
  isWorkspaceDocumentSource,
  type ActiveDocumentSource,
  type EditorDocument,
  type SaveState,
  type SourceAutoSaveTask,
} from "@/lib/workspace/types";
import { normalizeMarkdownPath, type MarkdownFileNode } from "@/lib/workspace/tree";
import { workspaceDocumentPersistenceCoordinator } from "@/lib/workspace/runtime/document-persistence-coordinator";
import type { WorkspaceRuntime, WorkspaceTextSnapshot } from "@/lib/workspace/runtime/types";
import type { SourceObservation, SourceRevision } from "@/lib/workspace/storage/types";

type MutableRef<T> = {
  current: T;
};

type UseWorkspaceSaveActionsOptions = {
  activeDocumentGenerationRef: MutableRef<number>;
  autoSaveTaskRef: MutableRef<SourceAutoSaveTask | null>;
  cleanValueRef: MutableRef<string>;
  collabDocumentRef: MutableRef<CollabDocumentState | null>;
  collabSyncCleanupRef: MutableRef<() => void>;
  dirtyRef: MutableRef<boolean>;
  editVersionRef: MutableRef<number>;
  editorValueRef: MutableRef<string>;
  saveOperationRef: MutableRef<number>;
  saveStateRef: MutableRef<SaveState>;
  scheduleAutoSaveRef: MutableRef<() => void>;
  selectedFileSourceRef: MutableRef<ActiveDocumentSource | null>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  sendHostDocumentUpdate: (
    runtime: WorkspaceRuntime,
    path: string,
    update: Uint8Array | null,
  ) => void;
  sendHostSaveAck: (
    runtime: WorkspaceRuntime,
    path: string,
    value: string,
    savedVersion: SerializedCollabVersionVector,
  ) => void;
  setEditorDocument: Dispatch<SetStateAction<EditorDocument>>;
  setErrorMessage: (message: string) => void;
  setRetryLoadPath: (path: string | null) => void;
  setSaveStateSynced: (nextState: SaveState) => void;
};

export function useWorkspaceSaveActions({
  activeDocumentGenerationRef,
  autoSaveTaskRef,
  cleanValueRef,
  collabDocumentRef,
  collabSyncCleanupRef,
  dirtyRef,
  editVersionRef,
  editorValueRef,
  saveOperationRef,
  saveStateRef,
  scheduleAutoSaveRef,
  selectedFileSourceRef,
  selectedFileRef,
  sendHostDocumentUpdate,
  sendHostSaveAck,
  setEditorDocument,
  setErrorMessage,
  setRetryLoadPath,
  setSaveStateSynced,
}: UseWorkspaceSaveActionsOptions) {
  let clearPendingSaveTimer = useCallback(() => {
    autoSaveTaskRef.current?.task.cancel();
  }, [autoSaveTaskRef]);

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
    let source = selectedFileSourceRef.current;
    let file = selectedFileRef.current;
    if (!source || !file) return true;
    let runtime = isWorkspaceDocumentSource(source) ? source : null;
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
      selectedFileSourceRef.current === source &&
      selectedFileRef.current === file;
    let markCurrentTargetSaved = () => {
      if (!isCurrentSaveTarget()) return;
      cleanValueRef.current = value;
      if (editVersion != editVersionRef.current) return;
      dirtyRef.current = false;
      setSaveStateSynced("saved");
    };
    setSaveStateSynced("saving");

    let outcome = await workspaceDocumentPersistenceCoordinator.schedule({
      epoch: documentGeneration,
      generation: operation,
      path: file.path,
      run: async () => {
        try {
          let sourceImport: CollabSourceImportResult | null = null;
          if (document && runtime) {
            sourceImport = await ingestExternalMarkdownEdit(runtime, document);
            if (sourceImport) {
              sendHostDocumentUpdate(runtime, file.path, sourceImport.update);
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

          if (document) {
            if (!runtime) throw new Error("Collaborative documents require a workspace runtime.");
            let materialization = await persistCollaborativeDocument(
              runtime,
              document,
              sourceImport,
            );
            value = materialization.value;
            sendHostSaveAck(
              runtime,
              file.path,
              materialization.value,
              materialization.versionVector,
            );
          } else {
            if (runtime) {
              let result = await runtime.documents.commit({
                condition: { kind: "unconditional" },
                path: file.path,
                value,
              });
              if (result.status != "committed") {
                throw new Error(`Workspace write for ${file.path} ended with ${result.status}.`);
              }
            } else if (!isWorkspaceDocumentSource(source)) {
              await source.writeFile(value);
            }
          }
          markCurrentTargetSaved();
          return true;
        } catch (error) {
          let reconcileIndeterminateCommit = async (candidate: unknown) => {
            if (!(candidate instanceof IndeterminateDocumentCommitError) || !document) {
              return candidate;
            }
            try {
              let sourceImport = await ingestExternalMarkdownObservation(
                document,
                candidate.observation,
              );
              if (sourceImport) {
                if (runtime) sendHostDocumentUpdate(runtime, file.path, sourceImport.update);
                value = applyCollabDocumentValue(document, sourceImport.value);
              }
              if (runtime) await saveCollabDocumentSnapshot(runtime, document);
            } catch (reconcileError) {
              return reconcileError;
            }
            return candidate;
          };

          let finalError = await reconcileIndeterminateCommit(error);
          if (finalError === error && isWorkspaceWriteConflictError(error)) {
            try {
              if (document) {
                if (!runtime)
                  throw new Error("Collaborative documents require a workspace runtime.");
                let sourceImport = await ingestExternalMarkdownEdit(runtime, document);
                if (sourceImport) sendHostDocumentUpdate(runtime, file.path, sourceImport.update);
                value = applyCollabDocumentValue(document, getCollabDocumentValue(document));
                let materialization = await persistCollaborativeDocument(
                  runtime,
                  document,
                  sourceImport,
                );
                value = materialization.value;
                sendHostSaveAck(
                  runtime,
                  file.path,
                  materialization.value,
                  materialization.versionVector,
                );
                markCurrentTargetSaved();
                return true;
              }

              let externalValue = runtime
                ? await readWorkspaceDocumentValue(runtime, file.path)
                : !isWorkspaceDocumentSource(source)
                  ? await source.readFile()
                  : "";
              if (externalValue == value) {
                markCurrentTargetSaved();
                return true;
              }
            } catch (retryError) {
              finalError = await reconcileIndeterminateCommit(retryError);
            }
          }

          if (!isCurrentSaveTarget()) return true;
          setSaveStateSynced("error");
          setRetryLoadPath(null);
          setErrorMessage(errorToMessage(finalError));
          return false;
        }
      },
      sessionId: document?.docId ?? `${activeDocumentSourceId(source)}:${file.path}`,
      workspaceId: activeDocumentSourceId(source),
    });
    if (outcome.status == "completed") return outcome.value;
    if (outcome.status == "superseded") return true;
    if (!isCurrentSaveTarget()) return true;
    setSaveStateSynced(outcome.status == "blocked" ? "pending" : "error");
    if (outcome.status == "busy") {
      setErrorMessage(`Another document session is still writing ${file.path}.`);
    }
    return false;
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
    selectedFileSourceRef,
    selectedFileRef,
    sendHostDocumentUpdate,
    sendHostSaveAck,
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

  let reconcileCurrentDocumentSource = useCallback(
    async (
      runtime: WorkspaceRuntime,
      file: MarkdownFileNode,
      document: CollabDocumentState,
      documentGeneration: number,
    ) => {
      let isCurrentDocument = () =>
        documentGeneration == activeDocumentGenerationRef.current &&
        selectedFileSourceRef.current === runtime &&
        selectedFileRef.current?.path == file.path &&
        collabDocumentRef.current === document;

      try {
        await workspaceDocumentPersistenceCoordinator.barrier({
          path: file.path,
          run: async () => {
            if (!isCurrentDocument()) return;
            try {
              let sourceImport = await ingestExternalMarkdownEdit(runtime, document);
              if (!isCurrentDocument()) return;
              if (sourceImport) {
                sendHostDocumentUpdate(runtime, file.path, sourceImport.update);
                applyCollabDocumentValue(document, sourceImport.value);
              }
              await saveCollabDocumentSnapshot(runtime, document);
              if (!isCurrentDocument()) return;

              let value = getCollabDocumentValue(document);
              if (document.source.kind != "present") {
                clearPendingSaveTimer();
                dirtyRef.current = true;
                setSaveStateSynced("error");
                setRetryLoadPath(document.source.kind == "unavailable" ? file.path : null);
                setErrorMessage(sourceWriteBlockedMessage(document.source.kind));
                return;
              }

              if (collabDocumentNeedsSourceWrite(document)) {
                dirtyRef.current = true;
                setSaveStateSynced("pending");
                scheduleAutoSaveRef.current();
                return;
              }

              cleanValueRef.current = value;
              dirtyRef.current = false;
              setSaveStateSynced("saved");
            } catch (error) {
              if (!isCurrentDocument()) return;
              setSaveStateSynced("error");
              setRetryLoadPath(file.path);
              setErrorMessage(errorToMessage(error));
            }
          },
          workspaceId: runtime.identity.id,
        });
      } catch (error) {
        if (!isCurrentDocument()) return;
        setSaveStateSynced("error");
        setRetryLoadPath(file.path);
        setErrorMessage(errorToMessage(error));
      }
    },
    [
      activeDocumentGenerationRef,
      applyCollabDocumentValue,
      cleanValueRef,
      clearPendingSaveTimer,
      collabDocumentRef,
      dirtyRef,
      scheduleAutoSaveRef,
      selectedFileSourceRef,
      selectedFileRef,
      sendHostDocumentUpdate,
      setErrorMessage,
      setRetryLoadPath,
      setSaveStateSynced,
    ],
  );

  let keepCurrentDocumentAs = useCallback(
    async (
      runtime: WorkspaceRuntime,
      file: MarkdownFileNode,
      document: CollabDocumentState,
      rawPath: string,
      documentGeneration: number,
    ) => {
      let targetPath = normalizeMarkdownPath(rawPath);
      if (targetPath == file.path)
        throw new Error("Choose a different path for the recovered copy.");
      let value = getCollabDocumentValue(document);
      await workspaceDocumentPersistenceCoordinator.barrier({
        path: file.path,
        run: async () => {
          assertCurrentRecoveryDocument({
            activeDocumentGenerationRef,
            runtime,
            collabDocumentRef,
            document,
            documentGeneration,
            file,
            selectedFileSourceRef,
            selectedFileRef,
          });
          await commitExplicitDocumentTarget(runtime, targetPath, value);
        },
        workspaceId: runtime.identity.id,
      });
      return targetPath;
    },
    [activeDocumentGenerationRef, collabDocumentRef, selectedFileRef, selectedFileSourceRef],
  );

  let resolveCurrentDocumentUseExternal = useCallback(
    async (
      runtime: WorkspaceRuntime,
      file: MarkdownFileNode,
      document: CollabDocumentState,
      documentGeneration: number,
    ) => {
      await workspaceDocumentPersistenceCoordinator.barrier({
        path: file.path,
        run: async () => {
          assertCurrentRecoveryDocument({
            activeDocumentGenerationRef,
            runtime,
            collabDocumentRef,
            document,
            documentGeneration,
            file,
            selectedFileSourceRef,
            selectedFileRef,
          });
          if (document.source.kind != "recovery-required") {
            throw new Error("The document no longer requires external-source recovery.");
          }
          let confirmedIncomingRevision = document.source.incoming.revision;
          let observation = await runtime.documents.observe(file.path);
          if (observation.state == "missing") {
            await ingestExternalMarkdownObservation(document, observation);
            throw new Error("The external source was removed. Review the updated recovery state.");
          }
          if (observation.state == "unavailable") {
            await ingestExternalMarkdownObservation(document, observation);
            throw observation.error;
          }
          let result = await resolveCollabRecoveryUseExternal(
            document,
            observation.value,
            confirmedIncomingRevision,
          );
          if (result.status == "incoming-changed") {
            await ingestExternalMarkdownObservation(document, observation);
            await saveCollabDocumentSnapshot(runtime, document);
            throw new Error("The external source changed again. Review it before confirming.");
          }
          if (result.update.byteLength) {
            sendHostDocumentUpdate(runtime, file.path, result.update);
          }
          let value = applyCollabDocumentValue(document, observation.value.value);
          await saveCollabDocumentSnapshot(runtime, document);
          cleanValueRef.current = value;
          dirtyRef.current = false;
          setErrorMessage("");
          setRetryLoadPath(null);
          setSaveStateSynced("saved");
        },
        workspaceId: runtime.identity.id,
      });
    },
    [
      activeDocumentGenerationRef,
      applyCollabDocumentValue,
      cleanValueRef,
      collabDocumentRef,
      dirtyRef,
      selectedFileSourceRef,
      selectedFileRef,
      sendHostDocumentUpdate,
      setErrorMessage,
      setRetryLoadPath,
      setSaveStateSynced,
    ],
  );

  let recreateCurrentDocumentSource = useCallback(
    async (
      runtime: WorkspaceRuntime,
      file: MarkdownFileNode,
      document: CollabDocumentState,
      documentGeneration: number,
    ) => {
      await workspaceDocumentPersistenceCoordinator.barrier({
        path: file.path,
        run: async () => {
          assertCurrentRecoveryDocument({
            activeDocumentGenerationRef,
            runtime,
            collabDocumentRef,
            document,
            documentGeneration,
            file,
            selectedFileSourceRef,
            selectedFileRef,
          });
          if (document.source.kind != "missing") {
            throw new Error("The source path is no longer missing. Reconcile it before saving.");
          }
          let materialization = captureCollabDocumentMaterialization(document);
          let snapshot: WorkspaceTextSnapshot;
          try {
            snapshot = await commitExplicitDocumentTarget(
              runtime,
              file.path,
              materialization.value,
            );
          } catch (commitError) {
            let observation = await runtime.documents.observe(file.path);
            let sourceImport = await ingestExternalMarkdownObservation(document, observation);
            if (sourceImport) {
              sendHostDocumentUpdate(runtime, file.path, sourceImport.update);
              applyCollabDocumentValue(document, sourceImport.value);
            }
            await saveCollabDocumentSnapshot(runtime, document);
            throw commitError;
          }
          await acknowledgeCollabDocumentSourceSaved(runtime, document, materialization.value, {
            frontiers: materialization.frontiers,
            source: sourceBaseline(snapshot),
            versionVector: materialization.versionVector,
          });
          sendHostSaveAck(runtime, file.path, materialization.value, materialization.versionVector);
          let value = applyCollabDocumentValue(document, materialization.value);
          cleanValueRef.current = value;
          dirtyRef.current = false;
          setErrorMessage("");
          setRetryLoadPath(null);
          setSaveStateSynced("saved");
        },
        workspaceId: runtime.identity.id,
      });
    },
    [
      activeDocumentGenerationRef,
      applyCollabDocumentValue,
      cleanValueRef,
      collabDocumentRef,
      dirtyRef,
      selectedFileSourceRef,
      selectedFileRef,
      sendHostSaveAck,
      setErrorMessage,
      setRetryLoadPath,
      setSaveStateSynced,
    ],
  );

  let handleRemoteCollabDocumentUpdate = useCallback(
    async (runtime: WorkspaceRuntime, document: CollabDocumentState) => {
      if (collabDocumentRef.current !== document) return;
      try {
        editorValueRef.current = getCollabDocumentValue(document);
        editVersionRef.current += 1;
        dirtyRef.current = true;
        setSaveStateSynced("pending");
        await saveCollabDocumentSnapshot(runtime, document);
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
    (runtime: WorkspaceRuntime, document: CollabDocumentState) => {
      collabSyncCleanupRef.current = createCollabDocumentBroadcastSync({
        doc: document.doc,
        docId: document.docId,
        identity: runtime.identity,
        onRemoteUpdate: () => {
          void handleRemoteCollabDocumentUpdate(runtime, document);
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
    keepCurrentDocumentAs,
    reconcileCurrentDocumentSource,
    recreateCurrentDocumentSource,
    resolveCurrentDocumentUseExternal,
    saveCurrentFile,
    scheduleAutoSave,
  };
}

async function readSavedSourceBaseline(
  runtime: WorkspaceRuntime,
  path: string,
  expectedValue: string,
) {
  let observation = await runtime.documents.observe(path);
  if (observation.state == "unavailable") throw observation.error;
  if (observation.state == "missing") {
    throw new Error(`${path} disappeared after it was written.`);
  }
  if (observation.value.value != expectedValue) {
    throw new Error(`Workspace write conflict for ${path}: the source changed after commit.`);
  }
  return {
    contentHash: observation.value.contentHash,
    revision: observation.value.revision,
  };
}

class IndeterminateDocumentCommitError extends Error {
  constructor(
    readonly observation: SourceObservation<WorkspaceTextSnapshot>,
    path: string,
  ) {
    super(`The write outcome for ${path} could not be confirmed. Reconcile before saving again.`);
    this.name = "IndeterminateDocumentCommitError";
  }
}

async function persistCollaborativeDocument(
  runtime: WorkspaceRuntime,
  document: CollabDocumentState,
  sourceImport: CollabSourceImportResult | null,
) {
  let materialization = captureCollabDocumentMaterialization(document);
  if (document.source.kind != "present") {
    throw new Error(sourceWriteBlockedMessage(document.source.kind));
  }
  await saveCollabDocumentSnapshot(runtime, document);
  let source = await commitDocumentValue(
    runtime,
    document.path,
    materialization.value,
    document.source.baseline.revision,
  );
  await acknowledgeCollabDocumentSourceSaved(runtime, document, materialization.value, {
    externalEdit: sourceImport?.externalEdit,
    frontiers: materialization.frontiers,
    source,
    versionVector: materialization.versionVector,
  });
  return materialization;
}

async function commitDocumentValue(
  runtime: WorkspaceRuntime,
  path: string,
  value: string,
  revision: SourceRevision,
) {
  let result = await runtime.documents.commit({
    condition: { kind: "if-unchanged", revision },
    path,
    value,
  });
  if (result.status == "conflict") throw new Error(`Workspace write conflict for ${path}.`);
  if (result.status == "unknown") {
    let observation = await runtime.documents.observe(path);
    if (observation.state == "present" && observation.value.value == value) {
      return sourceBaseline(observation.value);
    }
    throw new IndeterminateDocumentCommitError(observation, path);
  }
  return readSavedSourceBaseline(runtime, path, value);
}

function sourceBaseline(snapshot: WorkspaceTextSnapshot) {
  return { contentHash: snapshot.contentHash, revision: snapshot.revision };
}

async function commitExplicitDocumentTarget(
  runtime: WorkspaceRuntime,
  path: string,
  value: string,
) {
  let result = await runtime.documents.commit({ condition: { kind: "if-absent" }, path, value });
  if (result.status == "conflict") throw new Error(`${path} already exists.`);
  let observation = await runtime.documents.observe(path);
  if (observation.state == "unavailable") throw observation.error;
  if (observation.state == "missing" || observation.value.value != value) {
    throw new Error(`The write outcome for ${path} is unknown. Reconcile it before continuing.`);
  }
  return observation.value;
}

function assertCurrentRecoveryDocument(input: {
  activeDocumentGenerationRef: MutableRef<number>;
  collabDocumentRef: MutableRef<CollabDocumentState | null>;
  document: CollabDocumentState;
  documentGeneration: number;
  file: MarkdownFileNode;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  selectedFileSourceRef: MutableRef<ActiveDocumentSource | null>;
  runtime: WorkspaceRuntime;
}) {
  if (
    input.activeDocumentGenerationRef.current != input.documentGeneration ||
    input.selectedFileSourceRef.current !== input.runtime ||
    input.selectedFileRef.current?.path != input.file.path ||
    input.collabDocumentRef.current !== input.document
  ) {
    throw new Error("The active document changed before recovery completed.");
  }
}

async function readWorkspaceDocumentValue(runtime: WorkspaceRuntime, path: string) {
  let observation = await runtime.documents.observe(path);
  if (observation.state == "unavailable") throw observation.error;
  if (observation.state == "missing") throw new Error(`${path} does not exist.`);
  return observation.value.value;
}

function sourceWriteBlockedMessage(kind: CollabDocumentState["source"]["kind"]) {
  switch (kind) {
    case "missing":
      return "The source file was removed. Use Save As or explicitly recreate it.";
    case "recovery-required":
      return "The source and local document both changed. Resolve recovery before saving.";
    case "unavailable":
      return "The source file is unavailable. Reconnect it before saving.";
    case "present":
      return "";
  }
}
