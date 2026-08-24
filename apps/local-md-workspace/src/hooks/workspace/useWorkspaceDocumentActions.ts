import { useCallback, type Dispatch, type SetStateAction } from "react";
import type {
  WorkspaceDocumentIntentLease,
  WorkspaceDocumentSessionController,
} from "@/app/document-session-coordinator";
import {
  clearWorkspaceDocumentView,
  publishSingleFileDocumentView,
  type WorkspaceAppStore,
} from "@/app/workspace-store";
import type { SerializedCollabVersionVector } from "@/lib/collaboration/collab-browser-store";
import { useWorkspaceSaveActions } from "@/hooks/workspace/useWorkspaceSaveActions";
import {
  collabDocumentNeedsSourceWrite,
  openMarkdownCollabDocument,
  type CollabDocumentState,
} from "@/lib/collaboration/markdown-document";
import {
  restoreOwnerShareRecordForPath,
  type CreatedOwnerShare,
  type OwnerShareRecord,
} from "@/lib/collaboration/share-storage";
import type { DropboxRedirectDraft } from "@/lib/workspace/providers/dropbox/redirect-draft";
import type { GoogleDriveRedirectDraft } from "@/lib/workspace/providers/google-drive/redirect-draft";
import type { OneDriveRedirectDraft } from "@/lib/workspace/providers/onedrive/redirect-draft";
import { type AccessFileHandle } from "@/lib/workspace/file-system";
import {
  clearLastSingleFileDraft,
  createSingleFileDraft,
  deleteSingleFileDraft,
  loadLastSingleFileDraft,
  loadSingleFileDraft,
  rememberLastSingleFileDraft,
} from "@/lib/workspace/single-file-draft-store";
import { sharedMarkdownDraftUnavailableMessage } from "@/lib/platform/share-target";
import { errorToMessage } from "@/lib/workspace/errors";
import {
  createActiveWorkspaceDocumentSession,
  type DocumentSession,
} from "@/lib/workspace/document-session";
import { createSingleFileDraftSource, singleFileMarkdownNode } from "@/lib/workspace/single-file";
import { workspaceSelectedPathContext } from "@/lib/workspace/state";
import type {
  ActiveOwnerShareRecord,
  ActiveDocumentSource,
  SaveState,
  SingleFileSource,
  SourceAutoSaveTask,
} from "@/lib/workspace/types";
import { saveStoredWorkspaceSelectedPath } from "@/lib/workspace/store";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import { workspaceDocumentPersistenceCoordinator } from "@/lib/workspace/runtime/document-persistence-coordinator";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

type MutableRef<T> = {
  current: T;
};

type CloudRedirectDraft = DropboxRedirectDraft | GoogleDriveRedirectDraft | OneDriveRedirectDraft;

type StartOwnerShareHost = (
  record: OwnerShareRecord,
  session: DocumentSession,
  options?: { actionLabel?: string; shouldContinue?: () => boolean },
) => Promise<void>;

type UseWorkspaceDocumentActionsOptions = {
  activeDocumentGenerationRef: MutableRef<number>;
  autoSaveTaskRef: MutableRef<SourceAutoSaveTask | null>;
  cleanValueRef: MutableRef<string>;
  collabDocumentRef: MutableRef<CollabDocumentState | null>;
  documentSessions: WorkspaceDocumentSessionController;
  documentTargetGenerationRef: MutableRef<number>;
  dirtyRef: MutableRef<boolean>;
  editVersionRef: MutableRef<number>;
  editorValueRef: MutableRef<string>;
  localFileHandleRef: MutableRef<AccessFileHandle | null>;
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
  setActiveShareRecord: Dispatch<SetStateAction<ActiveOwnerShareRecord | null>>;
  setCreatedShare: Dispatch<SetStateAction<CreatedOwnerShare | null>>;
  setEditorDocument: Dispatch<SetStateAction<{ path: string; value: string; version: number }>>;
  setErrorMessage: (message: string) => void;
  setRetryLoadPath: (path: string | null) => void;
  setSaveStateSynced: (nextState: SaveState) => void;
  singleFileSourceRef: MutableRef<SingleFileSource | null>;
  startOwnerShareHost: StartOwnerShareHost;
  stopOwnerShareHost: () => void;
  workspaceAppStore: WorkspaceAppStore;
};

export function useWorkspaceDocumentActions({
  activeDocumentGenerationRef,
  autoSaveTaskRef,
  cleanValueRef,
  collabDocumentRef,
  documentSessions,
  documentTargetGenerationRef,
  dirtyRef,
  editVersionRef,
  editorValueRef,
  localFileHandleRef,
  saveOperationRef,
  saveStateRef,
  scheduleAutoSaveRef,
  selectedFileSourceRef,
  selectedFileRef,
  sendHostDocumentUpdate,
  sendHostSaveAck,
  setActiveShareRecord,
  setCreatedShare,
  setEditorDocument,
  setErrorMessage,
  setRetryLoadPath,
  setSaveStateSynced,
  singleFileSourceRef,
  startOwnerShareHost,
  stopOwnerShareHost,
  workspaceAppStore,
}: UseWorkspaceDocumentActionsOptions) {
  let invalidateActiveDocumentSave = useCallback(() => {
    activeDocumentGenerationRef.current += 1;
    saveOperationRef.current += 1;
  }, [activeDocumentGenerationRef, saveOperationRef]);

  let invalidateDocumentTarget = useCallback(() => {
    documentTargetGenerationRef.current += 1;
    documentSessions.invalidate();
  }, [documentSessions, documentTargetGenerationRef]);

  let {
    bindCollabDocumentBroadcast,
    clearPendingSaveTimer,
    handleEditorInput,
    keepCurrentDocumentAs,
    reconcileCurrentDocumentSource,
    recreateCurrentDocumentSource,
    resolveCurrentDocumentUseExternal,
    saveCurrentFile,
    scheduleAutoSave,
  } = useWorkspaceSaveActions({
    activeDocumentGenerationRef,
    autoSaveTaskRef,
    cleanValueRef,
    collabDocumentRef,
    documentSessions,
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
  });

  let clearCompatibilityDocument = useCallback(() => {
    clearPendingSaveTimer();
    stopOwnerShareHost();
    invalidateActiveDocumentSave();
    collabDocumentRef.current = null;
    selectedFileRef.current = null;
    selectedFileSourceRef.current = null;
    singleFileSourceRef.current = null;
    localFileHandleRef.current = null;
    editorValueRef.current = "";
    cleanValueRef.current = "";
    dirtyRef.current = false;
    editVersionRef.current = 0;
    saveStateRef.current = "idle";
    setActiveShareRecord(null);
    setCreatedShare(null);
  }, [
    cleanValueRef,
    clearPendingSaveTimer,
    collabDocumentRef,
    dirtyRef,
    editVersionRef,
    editorValueRef,
    invalidateActiveDocumentSave,
    localFileHandleRef,
    selectedFileSourceRef,
    selectedFileRef,
    setActiveShareRecord,
    setCreatedShare,
    saveStateRef,
    singleFileSourceRef,
    stopOwnerShareHost,
  ]);

  let closeManagedDocumentSession = useCallback(async () => {
    documentTargetGenerationRef.current += 1;
    return documentSessions.close();
  }, [documentSessions, documentTargetGenerationRef]);

  let closeActiveDocumentSession = useCallback(async () => {
    await closeManagedDocumentSession();
  }, [closeManagedDocumentSession]);

  let clearActiveDocument = useCallback(async () => {
    let outcome = await closeManagedDocumentSession();
    if (outcome.status != "closed" || outcome.hadActiveSession) return;
    clearCompatibilityDocument();
    clearWorkspaceDocumentView(workspaceAppStore);
  }, [clearCompatibilityDocument, closeManagedDocumentSession, workspaceAppStore]);

  let beginDocumentTransition = useCallback(
    (path = "") => {
      documentTargetGenerationRef.current += 1;
      return documentSessions.begin(path, { activeValue: editorValueRef.current });
    },
    [documentSessions, documentTargetGenerationRef, editorValueRef],
  );

  let activateSingleFileDocument = useCallback(
    async (
      singleFile: SingleFileSource,
      persistence: ActiveDocumentSource,
      file: MarkdownFileNode,
      value: string,
      options: {
        intent: ReturnType<WorkspaceDocumentSessionController["begin"]>;
        localFileHandle?: AccessFileHandle;
      },
    ) => {
      let outcome = await documentSessions.close(options.intent);
      if (outcome.status != "closed" || !documentSessions.isCurrent(options.intent)) return false;
      if (!outcome.hadActiveSession) clearCompatibilityDocument();
      selectedFileSourceRef.current = persistence;
      selectedFileRef.current = file;
      singleFileSourceRef.current = singleFile;
      editorValueRef.current = value;
      cleanValueRef.current = value;
      dirtyRef.current = false;
      editVersionRef.current = 0;
      localFileHandleRef.current =
        singleFile.kind == "local-file" ? (options.localFileHandle ?? null) : null;

      saveStateRef.current = "saved";
      publishSingleFileDocumentView(workspaceAppStore, {
        file,
        singleFileSource: singleFile,
        value,
      });
      setActiveShareRecord(null);
      setCreatedShare(null);
      setErrorMessage("");
      setRetryLoadPath(null);
      return true;
    },
    [
      cleanValueRef,
      clearCompatibilityDocument,
      documentSessions,
      documentTargetGenerationRef,
      dirtyRef,
      editVersionRef,
      editorValueRef,
      localFileHandleRef,
      selectedFileSourceRef,
      selectedFileRef,
      setActiveShareRecord,
      setCreatedShare,
      setErrorMessage,
      setRetryLoadPath,
      saveStateRef,
      workspaceAppStore,
    ],
  );

  let discardMaterializedDraft = useCallback((source: SingleFileSource | null) => {
    if (source?.kind != "draft") return;
    void deleteSingleFileDraft(source.draftId).catch(() => {});
    void clearLastSingleFileDraft(source.draftId).catch(() => {});
  }, []);

  let openSingleFileDraft = useCallback(
    async (
      options: {
        draftId?: string;
        reuseLast?: boolean;
        saveCurrent?: boolean;
        shouldContinue?: () => boolean;
      } = {},
    ) => {
      if (options.shouldContinue && !options.shouldContinue()) return;
      let lease = beginDocumentTransition("Untitled.md");

      setErrorMessage("");
      setRetryLoadPath(null);
      try {
        if ((options.saveCurrent ?? true) && !(await saveCurrentFile())) return;
        if (!documentSessions.isCurrent(lease)) return;
        if (options.shouldContinue && !options.shouldContinue()) return;

        let draft = options.draftId
          ? await loadSingleFileDraft(options.draftId).catch(() => null)
          : options.reuseLast === true
            ? await loadLastSingleFileDraft().catch(() => null)
            : null;
        if (!draft && options.draftId) throw new Error(sharedMarkdownDraftUnavailableMessage);
        draft ??= await createSingleFileDraft({ name: "Untitled.md" });
        await rememberLastSingleFileDraft(draft.id).catch(() => {});
        if (!documentSessions.isCurrent(lease)) return;
        if (options.shouldContinue && !options.shouldContinue()) return;

        let source = createSingleFileDraftSource(draft);
        await activateSingleFileDocument(
          { draftId: draft.id, kind: "draft", name: draft.name },
          source,
          singleFileMarkdownNode(draft.name),
          draft.value,
          { intent: lease },
        );
      } catch (error) {
        if (documentSessions.isCurrent(lease)) setErrorMessage(errorToMessage(error));
      } finally {
        documentSessions.finish(lease);
      }
    },
    [
      activateSingleFileDocument,
      beginDocumentTransition,
      documentSessions,
      saveCurrentFile,
      setErrorMessage,
      setRetryLoadPath,
    ],
  );

  let loadFile = useCallback(
    async (
      runtime: WorkspaceRuntime,
      file: MarkdownFileNode,
      options: { intent?: WorkspaceDocumentIntentLease; saveCurrent?: boolean } = {},
    ) => {
      // The opening lease is the loading state. A shared boolean would let a
      // superseded load clear a newer operation's busy state.
      let lease = options.intent ?? beginDocumentTransition(file.path);

      setErrorMessage("");
      setRetryLoadPath(null);

      try {
        let outcome = await documentSessions.transition({
          lease,
          prepare: async () => {
            if ((options.saveCurrent ?? true) && !(await saveCurrentFile())) return null;
            if (!documentSessions.isCurrent(lease)) return null;

            let restoredShareRecord = await restoreOwnerShareRecordForPath(
              runtime.identity,
              file.path,
            ).catch(() => null);
            if (!documentSessions.isCurrent(lease)) return null;

            let document = await openMarkdownCollabDocument(runtime, file.path);
            let value = document.value;
            let needsSourceWrite = collabDocumentNeedsSourceWrite(document);
            let nextSaveState: SaveState = needsSourceWrite ? "pending" : "saved";

            return {
              activate: () => {
                let stopBroadcast = () => {};
                clearCompatibilityDocument();
                try {
                  selectedFileRef.current = file;
                  selectedFileSourceRef.current = runtime;
                  collabDocumentRef.current = document;
                  stopBroadcast = bindCollabDocumentBroadcast(runtime, document);
                  editorValueRef.current = value;
                  cleanValueRef.current = value;
                  dirtyRef.current = needsSourceWrite;
                  editVersionRef.current = 0;
                  singleFileSourceRef.current = null;
                  localFileHandleRef.current = null;
                  saveStateRef.current = nextSaveState;

                  let selectedPathContext = workspaceSelectedPathContext(runtime.identity);
                  if (selectedPathContext) {
                    saveStoredWorkspaceSelectedPath(selectedPathContext, file.path);
                  }

                  let session = createActiveWorkspaceDocumentSession(
                    runtime,
                    file,
                    document,
                    activeDocumentGenerationRef.current,
                  );
                  setActiveShareRecord(restoredShareRecord);
                  setCreatedShare(null);
                  if (restoredShareRecord) {
                    void startOwnerShareHost(restoredShareRecord, session, {
                      shouldContinue: () =>
                        documentSessions.isActive(session) || documentSessions.isCurrent(lease),
                    });
                  }
                  if (needsSourceWrite) scheduleAutoSave();
                  setRetryLoadPath(null);

                  return {
                    release: async () => {
                      try {
                        stopBroadcast();
                      } finally {
                        await workspaceDocumentPersistenceCoordinator.close({
                          epoch: session.epoch,
                          path: session.file.path,
                          sessionId: session.collabDocument.docId,
                          workspaceId: session.runtime.identity.id,
                        });
                      }
                    },
                    retire: clearCompatibilityDocument,
                    session,
                  };
                } catch (error) {
                  stopBroadcast();
                  clearCompatibilityDocument();
                  throw error;
                }
              },
              dispose: () => document.dispose(),
              document,
              file,
              saveState: nextSaveState,
              value,
            };
          },
        });
        return outcome.status == "activated";
      } catch (error) {
        if (!documentSessions.isCurrent(lease)) return false;
        setErrorMessage(errorToMessage(error));
        setRetryLoadPath(file.path);
        return false;
      }
    },
    [
      activeDocumentGenerationRef,
      beginDocumentTransition,
      bindCollabDocumentBroadcast,
      cleanValueRef,
      clearCompatibilityDocument,
      collabDocumentRef,
      documentSessions,
      dirtyRef,
      editVersionRef,
      editorValueRef,
      localFileHandleRef,
      saveCurrentFile,
      scheduleAutoSave,
      selectedFileSourceRef,
      selectedFileRef,
      setActiveShareRecord,
      setCreatedShare,
      setErrorMessage,
      setRetryLoadPath,
      saveStateRef,
      singleFileSourceRef,
      startOwnerShareHost,
    ],
  );

  let restoreCloudRedirectEditorDraft = useCallback(
    (runtime: WorkspaceRuntime, draft: CloudRedirectDraft) => {
      if (!draft.selectedPath || draft.dirtyValue == null) return false;

      let file = selectedFileRef.current;
      if (!file || file.path != draft.selectedPath) return false;

      invalidateDocumentTarget();
      selectedFileSourceRef.current = runtime;
      editorValueRef.current = draft.dirtyValue;
      editVersionRef.current += 1;
      setEditorDocument((current) => ({
        path: file.path,
        value: draft.dirtyValue ?? "",
        version: current.version + 1,
      }));

      if (draft.dirtyValue == cleanValueRef.current) {
        dirtyRef.current = false;
        setSaveStateSynced("saved");
        return true;
      }

      dirtyRef.current = true;
      setSaveStateSynced("pending");
      scheduleAutoSave();
      return true;
    },
    [
      cleanValueRef,
      dirtyRef,
      editVersionRef,
      editorValueRef,
      invalidateDocumentTarget,
      scheduleAutoSave,
      selectedFileSourceRef,
      selectedFileRef,
      setEditorDocument,
      setSaveStateSynced,
    ],
  );

  let ensureSelectedCollabDocument = useCallback(
    async (runtime: WorkspaceRuntime, file: MarkdownFileNode) => {
      let current = documentSessions.current();
      if (current?.runtime === runtime && current.file.path == file.path) {
        return current.collabDocument;
      }

      if (!(await loadFile(runtime, file, { saveCurrent: false }))) {
        throw new Error("The document changed before collaboration was ready.");
      }
      let active = documentSessions.current();
      if (active?.runtime !== runtime || active.file.path != file.path) {
        throw new Error("The document changed before collaboration was ready.");
      }
      return active.collabDocument;
    },
    [documentSessions, loadFile],
  );

  return {
    activateSingleFileDocument,
    beginDocumentTransition,
    clearActiveDocument,
    closeActiveDocumentSession,
    discardMaterializedDraft,
    ensureSelectedCollabDocument,
    handleEditorInput,
    keepCurrentDocumentAs,
    loadFile,
    openSingleFileDraft,
    reconcileCurrentDocumentSource,
    recreateCurrentDocumentSource,
    restoreCloudRedirectEditorDraft,
    resolveCurrentDocumentUseExternal,
    saveCurrentFile,
  };
}
