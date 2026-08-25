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
import { useWorkspaceSaveActions } from "@/hooks/workspace/useWorkspaceSaveActions";
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
import { createDocumentSession, type DocumentSession } from "@/lib/workspace/document-session";
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
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";
import type { WorkspaceCollaborativeDocument } from "@/lib/workspace/documents";

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
  collabDocumentRef: MutableRef<WorkspaceCollaborativeDocument | null>;
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
  setActiveShareRecord: Dispatch<SetStateAction<ActiveOwnerShareRecord | null>>;
  setCreatedShare: Dispatch<SetStateAction<CreatedOwnerShare | null>>;
  setEditorDocument: Dispatch<SetStateAction<{ path: string; value: string; version: number }>>;
  setErrorMessage: (message: string) => void;
  setRetryLoadPath: (path: string | null) => void;
  setSaveStateSynced: (nextState: SaveState) => void;
  singleFileSourceRef: MutableRef<SingleFileSource | null>;
  startOwnerShareHost: StartOwnerShareHost;
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
  setActiveShareRecord,
  setCreatedShare,
  setEditorDocument,
  setErrorMessage,
  setRetryLoadPath,
  setSaveStateSynced,
  singleFileSourceRef,
  startOwnerShareHost,
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
    applyCollaborativeDocumentSnapshot,
    clearPendingSaveTimer,
    handleEditorInput,
    keepCurrentDocumentAs,
    reconcileCurrentDocumentSource,
    recreateCurrentDocumentSource,
    resolveCurrentDocumentUseExternal,
    saveCurrentFile,
  } = useWorkspaceSaveActions({
    autoSaveTaskRef,
    cleanValueRef,
    collabDocumentRef,
    dirtyRef,
    editVersionRef,
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
  });

  let clearCompatibilityDocument = useCallback(() => {
    clearPendingSaveTimer();
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
  ]);

  let clearActiveDocument = useCallback(async () => {
    documentTargetGenerationRef.current += 1;
    let outcome = await documentSessions.close();
    if (!outcome || outcome.hadActiveSession) return;
    clearCompatibilityDocument();
    clearWorkspaceDocumentView(workspaceAppStore);
  }, [
    clearCompatibilityDocument,
    documentSessions,
    documentTargetGenerationRef,
    workspaceAppStore,
  ]);

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
      if (!outcome || !documentSessions.isCurrent(options.intent)) return false;
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
      setErrorMessage("");
      setRetryLoadPath(null);
      return true;
    },
    [
      cleanValueRef,
      clearCompatibilityDocument,
      documentSessions,
      dirtyRef,
      editVersionRef,
      editorValueRef,
      localFileHandleRef,
      selectedFileSourceRef,
      selectedFileRef,
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
            // Workspace documents materialize independently of UI selection. Only
            // a standalone draft needs an explicit save before the view changes.
            if (
              (options.saveCurrent ?? true) &&
              !collabDocumentRef.current &&
              !(await saveCurrentFile())
            ) {
              return null;
            }
            if (!documentSessions.isCurrent(lease)) return null;

            let restoredShareRecord = await restoreOwnerShareRecordForPath(
              runtime.identity,
              file.path,
            ).catch(() => null);
            if (!documentSessions.isCurrent(lease)) return null;

            let document = await runtime.documents.document(file.path);
            let snapshot = document.snapshot();
            let nextSaveState = collaborativeDocumentSaveState(snapshot.persistenceStatus);

            return {
              activate: () => {
                clearCompatibilityDocument();
                try {
                  selectedFileRef.current = file;
                  selectedFileSourceRef.current = runtime;
                  collabDocumentRef.current = document;
                  editorValueRef.current = snapshot.value;
                  cleanValueRef.current = snapshot.value;
                  dirtyRef.current = snapshot.persistenceStatus != "saved";
                  editVersionRef.current = 0;
                  singleFileSourceRef.current = null;
                  localFileHandleRef.current = null;
                  saveStateRef.current = nextSaveState;

                  let stopSubscription = document.subscribe((event) => {
                    if (collabDocumentRef.current !== document) return;
                    applyCollaborativeDocumentSnapshot(document, event.snapshot);
                    if (event.kind == "persistence-error") {
                      setErrorMessage(errorToMessage(event.error));
                      setRetryLoadPath(
                        event.snapshot.sourceKind == "unavailable" ? document.path : null,
                      );
                    } else if (event.kind == "materialized") {
                      setErrorMessage("");
                      setRetryLoadPath(null);
                    }
                  });

                  let selectedPathContext = workspaceSelectedPathContext(runtime.identity);
                  if (selectedPathContext) {
                    saveStoredWorkspaceSelectedPath(selectedPathContext, file.path);
                  }

                  let session = {
                    ...createDocumentSession(runtime, file, document),
                    epoch: activeDocumentGenerationRef.current,
                  };
                  setActiveShareRecord(restoredShareRecord);
                  if (restoredShareRecord) {
                    void startOwnerShareHost(restoredShareRecord, session);
                  }
                  setRetryLoadPath(null);

                  return {
                    release: async () => stopSubscription(),
                    retire: clearCompatibilityDocument,
                    session,
                  };
                } catch (error) {
                  clearCompatibilityDocument();
                  throw error;
                }
              },
              dispose: async () => {},
              view: { document, file, saveState: nextSaveState, value: snapshot.value },
            };
          },
        });
        return outcome != null;
      } catch (error) {
        if (!documentSessions.isCurrent(lease)) return false;
        setErrorMessage(errorToMessage(error));
        setRetryLoadPath(file.path);
        return false;
      }
    },
    [
      activeDocumentGenerationRef,
      applyCollaborativeDocumentSnapshot,
      beginDocumentTransition,
      cleanValueRef,
      clearCompatibilityDocument,
      collabDocumentRef,
      documentSessions,
      dirtyRef,
      editVersionRef,
      editorValueRef,
      localFileHandleRef,
      saveCurrentFile,
      selectedFileSourceRef,
      selectedFileRef,
      setActiveShareRecord,
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
      let document = collabDocumentRef.current;
      if (!document || document.path != file.path) return false;

      invalidateDocumentTarget();
      selectedFileSourceRef.current = runtime;
      let currentValue = document.read();
      let result = document.edit([
        { expectedText: currentValue, from: 0, insert: draft.dirtyValue, to: currentValue.length },
      ]);
      if (result.status == "conflict") return false;
      applyCollaborativeDocumentSnapshot(document);
      return true;
    },
    [
      applyCollaborativeDocumentSnapshot,
      collabDocumentRef,
      invalidateDocumentTarget,
      selectedFileSourceRef,
      selectedFileRef,
    ],
  );

  let ensureSelectedCollabDocument = useCallback(
    async (runtime: WorkspaceRuntime, file: MarkdownFileNode) => {
      return runtime.documents.document(file.path);
    },
    [],
  );

  return {
    activateSingleFileDocument,
    beginDocumentTransition,
    clearActiveDocument,
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

function collaborativeDocumentSaveState(
  status: ReturnType<WorkspaceCollaborativeDocument["snapshot"]>["persistenceStatus"],
): SaveState {
  switch (status) {
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
