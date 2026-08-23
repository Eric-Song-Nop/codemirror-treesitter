import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { SerializedCollabVersionVector } from "@/lib/collaboration/collab-browser-store";
import type { FileTreeDeleteTarget } from "@/components/FileTree";
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
import type { DropboxRedirectDraft } from "@/lib/dropbox-redirect-draft";
import type { GoogleDriveRedirectDraft } from "@/lib/google-drive-redirect-draft";
import type { OneDriveRedirectDraft } from "@/lib/onedrive-redirect-draft";
import { type AccessFileHandle } from "@/lib/file-system";
import {
  clearLastSingleFileDraft,
  createSingleFileDraft,
  deleteSingleFileDraft,
  loadLastSingleFileDraft,
  loadSingleFileDraft,
  rememberLastSingleFileDraft,
} from "@/lib/single-file-draft-store";
import { sharedMarkdownDraftUnavailableMessage } from "@/lib/share-target";
import { errorToMessage } from "@/lib/workspace/errors";
import { createDocumentSession, type DocumentSession } from "@/lib/workspace/document-session";
import { createSingleFileDraftSource, singleFileMarkdownNode } from "@/lib/workspace/single-file";
import { workspaceSelectedPathContext } from "@/lib/workspace/state";
import type {
  ActiveOwnerShareRecord,
  ActiveDocumentSource,
  EditorDocument,
  SaveState,
  SingleFileSource,
  SourceAutoSaveTask,
} from "@/lib/workspace/types";
import { activeDocumentSourceId } from "@/lib/workspace/types";
import { saveStoredWorkspaceSelectedPath } from "@/lib/workspace-store";
import type { MarkdownFileNode } from "@/lib/workspace-tree";
import { workspaceDocumentPersistenceCoordinator } from "@/lib/workspace-runtime/document-persistence-coordinator";
import type { WorkspaceRuntime } from "@/lib/workspace-runtime/types";

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
  collabSyncCleanupRef: MutableRef<() => void>;
  documentTargetGenerationRef: MutableRef<number>;
  dirtyRef: MutableRef<boolean>;
  editVersionRef: MutableRef<number>;
  editorValueRef: MutableRef<string>;
  isOwnerShareHostPath: (runtime: WorkspaceRuntime, path: string) => boolean;
  loadFileRequestRef: MutableRef<number>;
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
  setBusy: (busy: boolean) => void;
  setCollabDocument: Dispatch<SetStateAction<CollabDocumentState | null>>;
  setCreatedShare: Dispatch<SetStateAction<CreatedOwnerShare | null>>;
  setEditorDocument: Dispatch<SetStateAction<EditorDocument>>;
  setErrorMessage: (message: string) => void;
  setRetryLoadPath: (path: string | null) => void;
  setSaveStateSynced: (nextState: SaveState) => void;
  setSelectedFile: Dispatch<SetStateAction<MarkdownFileNode | null>>;
  setSingleFileSource: Dispatch<SetStateAction<SingleFileSource | null>>;
  setTreeSelection: Dispatch<SetStateAction<FileTreeDeleteTarget | null>>;
  singleFileSourceRef: MutableRef<SingleFileSource | null>;
  startOwnerShareHost: StartOwnerShareHost;
  stopOwnerShareHost: () => void;
};

export function useWorkspaceDocumentActions({
  activeDocumentGenerationRef,
  autoSaveTaskRef,
  cleanValueRef,
  collabDocumentRef,
  collabSyncCleanupRef,
  documentTargetGenerationRef,
  dirtyRef,
  editVersionRef,
  editorValueRef,
  isOwnerShareHostPath,
  loadFileRequestRef,
  localFileHandleRef,
  saveOperationRef,
  saveStateRef,
  scheduleAutoSaveRef,
  selectedFileSourceRef,
  selectedFileRef,
  sendHostDocumentUpdate,
  sendHostSaveAck,
  setActiveShareRecord,
  setBusy,
  setCollabDocument,
  setCreatedShare,
  setEditorDocument,
  setErrorMessage,
  setRetryLoadPath,
  setSaveStateSynced,
  setSelectedFile,
  setSingleFileSource,
  setTreeSelection,
  singleFileSourceRef,
  startOwnerShareHost,
  stopOwnerShareHost,
}: UseWorkspaceDocumentActionsOptions) {
  let [loadingFilePath, setLoadingFilePath] = useState<string | null>(null);

  let invalidateActiveDocumentSave = useCallback(() => {
    activeDocumentGenerationRef.current += 1;
    saveOperationRef.current += 1;
  }, [activeDocumentGenerationRef, saveOperationRef]);

  let invalidateDocumentTarget = useCallback(() => {
    documentTargetGenerationRef.current += 1;
  }, [documentTargetGenerationRef]);

  let disposeActiveCollabDocument = useCallback(async () => {
    collabSyncCleanupRef.current();
    collabSyncCleanupRef.current = () => {};
    let document = collabDocumentRef.current;
    let source = selectedFileSourceRef.current;
    let file = selectedFileRef.current;
    let epoch = activeDocumentGenerationRef.current;
    collabDocumentRef.current = null;
    try {
      let path = document?.path ?? file?.path;
      if (source && path) {
        let workspaceId = activeDocumentSourceId(source);
        await workspaceDocumentPersistenceCoordinator.close({
          epoch,
          path,
          sessionId: document?.docId ?? `${workspaceId}:${path}`,
          workspaceId,
        });
      }
    } finally {
      await document?.dispose();
    }
  }, [
    activeDocumentGenerationRef,
    collabDocumentRef,
    collabSyncCleanupRef,
    selectedFileRef,
    selectedFileSourceRef,
  ]);

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
  });

  let closeActiveDocumentSession = useCallback(async () => {
    let disposal = disposeActiveCollabDocument();
    invalidateDocumentTarget();
    loadFileRequestRef.current += 1;
    invalidateActiveDocumentSave();
    clearPendingSaveTimer();
    stopOwnerShareHost();
    setCollabDocument(null);
    await disposal;
  }, [
    clearPendingSaveTimer,
    disposeActiveCollabDocument,
    invalidateActiveDocumentSave,
    invalidateDocumentTarget,
    loadFileRequestRef,
    setCollabDocument,
    stopOwnerShareHost,
  ]);

  let clearActiveDocument = useCallback(async () => {
    let close = closeActiveDocumentSession();
    selectedFileRef.current = null;
    selectedFileSourceRef.current = null;
    singleFileSourceRef.current = null;
    localFileHandleRef.current = null;
    editorValueRef.current = "";
    cleanValueRef.current = "";
    dirtyRef.current = false;
    editVersionRef.current = 0;
    setSingleFileSource(null);
    setSelectedFile(null);
    setCollabDocument(null);
    setTreeSelection(null);
    setActiveShareRecord(null);
    setCreatedShare(null);
    setEditorDocument((current) => ({
      path: "",
      value: "",
      version: current.version + 1,
    }));
    setSaveStateSynced("idle");
    await close;
  }, [
    cleanValueRef,
    closeActiveDocumentSession,
    dirtyRef,
    editVersionRef,
    editorValueRef,
    localFileHandleRef,
    selectedFileSourceRef,
    selectedFileRef,
    setActiveShareRecord,
    setCollabDocument,
    setCreatedShare,
    setEditorDocument,
    setSaveStateSynced,
    setSelectedFile,
    setSingleFileSource,
    setTreeSelection,
    singleFileSourceRef,
  ]);

  let beginDocumentTransition = useCallback(
    (path = "") => {
      invalidateDocumentTarget();
      setSelectedFile(null);
      setCollabDocument(null);
      setEditorDocument((current) => ({
        path,
        value: "",
        version: current.version + 1,
      }));
    },
    [invalidateDocumentTarget, setCollabDocument, setEditorDocument, setSelectedFile],
  );

  let activateSingleFileDocument = useCallback(
    (
      singleFile: SingleFileSource,
      persistence: ActiveDocumentSource,
      file: MarkdownFileNode,
      value: string,
    ) => {
      let disposal = disposeActiveCollabDocument();
      invalidateDocumentTarget();
      loadFileRequestRef.current += 1;
      invalidateActiveDocumentSave();
      clearPendingSaveTimer();
      stopOwnerShareHost();
      void disposal.catch((error: unknown) => {
        setErrorMessage(errorToMessage(error));
      });
      selectedFileSourceRef.current = persistence;
      selectedFileRef.current = file;
      editorValueRef.current = value;
      cleanValueRef.current = value;
      dirtyRef.current = false;
      editVersionRef.current = 0;
      localFileHandleRef.current =
        singleFile.kind == "local-file" ? localFileHandleRef.current : null;

      setSingleFileSource(singleFile);
      setSelectedFile(file);
      setCollabDocument(null);
      setTreeSelection(null);
      setActiveShareRecord(null);
      setCreatedShare(null);
      setEditorDocument((current) => ({
        path: file.path,
        value,
        version: current.version + 1,
      }));
      setSaveStateSynced("saved");
      setErrorMessage("");
      setRetryLoadPath(null);
    },
    [
      cleanValueRef,
      clearPendingSaveTimer,
      dirtyRef,
      disposeActiveCollabDocument,
      editVersionRef,
      editorValueRef,
      invalidateActiveDocumentSave,
      invalidateDocumentTarget,
      loadFileRequestRef,
      localFileHandleRef,
      selectedFileSourceRef,
      selectedFileRef,
      setActiveShareRecord,
      setCollabDocument,
      setCreatedShare,
      setEditorDocument,
      setErrorMessage,
      setRetryLoadPath,
      setSaveStateSynced,
      setSelectedFile,
      setSingleFileSource,
      setTreeSelection,
      stopOwnerShareHost,
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
      invalidateDocumentTarget();
      if ((options.saveCurrent ?? true) && !(await saveCurrentFile())) return;
      if (options.shouldContinue && !options.shouldContinue()) return;

      setBusy(true);
      setErrorMessage("");
      setRetryLoadPath(null);
      try {
        let draft = options.draftId
          ? await loadSingleFileDraft(options.draftId).catch(() => null)
          : options.reuseLast === true
            ? await loadLastSingleFileDraft().catch(() => null)
            : null;
        if (!draft && options.draftId) throw new Error(sharedMarkdownDraftUnavailableMessage);
        draft ??= await createSingleFileDraft({ name: "Untitled.md" });
        await rememberLastSingleFileDraft(draft.id).catch(() => {});
        if (options.shouldContinue && !options.shouldContinue()) return;

        let source = createSingleFileDraftSource(draft);
        activateSingleFileDocument(
          { draftId: draft.id, kind: "draft", name: draft.name },
          source,
          singleFileMarkdownNode(draft.name),
          draft.value,
        );
      } catch (error) {
        setErrorMessage(errorToMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [
      activateSingleFileDocument,
      invalidateDocumentTarget,
      saveCurrentFile,
      setBusy,
      setErrorMessage,
      setRetryLoadPath,
    ],
  );

  let loadFile = useCallback(
    async (
      runtime: WorkspaceRuntime,
      file: MarkdownFileNode,
      options: { saveCurrent?: boolean } = {},
    ) => {
      invalidateDocumentTarget();
      let requestId = ++loadFileRequestRef.current;
      let isCurrentLoadRequest = () => loadFileRequestRef.current == requestId;

      setLoadingFilePath(file.path);
      setBusy(true);
      setErrorMessage("");
      setRetryLoadPath(null);

      try {
        if ((options.saveCurrent ?? true) && !(await saveCurrentFile())) return;
        if (!isCurrentLoadRequest()) return;

        let isSameActiveWorkspaceFile =
          !singleFileSourceRef.current &&
          selectedFileSourceRef.current === runtime &&
          selectedFileRef.current?.path == file.path;
        if (!isSameActiveWorkspaceFile) beginDocumentTransition(file.path);

        let restoredShareRecord = await restoreOwnerShareRecordForPath(
          runtime.identity,
          file.path,
        ).catch(() => null);
        if (!isCurrentLoadRequest()) return;
        let document = await openMarkdownCollabDocument(runtime, file.path);
        if (!isCurrentLoadRequest()) {
          await document.dispose();
          return;
        }
        let value = document.value;
        if (!isOwnerShareHostPath(runtime, file.path)) stopOwnerShareHost();
        try {
          await disposeActiveCollabDocument();
        } catch (error) {
          await document.dispose().catch(() => {});
          throw error;
        }
        if (!isCurrentLoadRequest()) {
          await document.dispose();
          return;
        }
        invalidateActiveDocumentSave();
        selectedFileRef.current = file;
        selectedFileSourceRef.current = runtime;
        collabDocumentRef.current = document;
        bindCollabDocumentBroadcast(runtime, document);
        let needsSourceWrite = collabDocumentNeedsSourceWrite(document);
        editorValueRef.current = value;
        cleanValueRef.current = value;
        dirtyRef.current = needsSourceWrite;
        editVersionRef.current = 0;
        setSingleFileSource(null);
        localFileHandleRef.current = null;
        let selectedPathContext = workspaceSelectedPathContext(runtime.identity);
        if (selectedPathContext) saveStoredWorkspaceSelectedPath(selectedPathContext, file.path);
        setSelectedFile(file);
        setCollabDocument(document);
        setTreeSelection({ kind: "file", name: file.name, path: file.path });
        setEditorDocument((current) => ({
          path: file.path,
          value,
          version: current.version + 1,
        }));
        setSaveStateSynced(needsSourceWrite ? "pending" : "saved");
        setActiveShareRecord(restoredShareRecord);
        setCreatedShare(null);
        if (restoredShareRecord) {
          void startOwnerShareHost(
            restoredShareRecord,
            createDocumentSession(runtime, file, document),
            {
              shouldContinue: isCurrentLoadRequest,
            },
          );
        }
        if (needsSourceWrite) scheduleAutoSave();
        setRetryLoadPath(null);
      } catch (error) {
        if (!isCurrentLoadRequest()) return;
        setErrorMessage(errorToMessage(error));
        setRetryLoadPath(file.path);
      } finally {
        if (isCurrentLoadRequest()) {
          setLoadingFilePath(null);
          setBusy(false);
        }
      }
    },
    [
      beginDocumentTransition,
      bindCollabDocumentBroadcast,
      cleanValueRef,
      collabDocumentRef,
      dirtyRef,
      disposeActiveCollabDocument,
      editVersionRef,
      editorValueRef,
      invalidateActiveDocumentSave,
      invalidateDocumentTarget,
      isOwnerShareHostPath,
      loadFileRequestRef,
      localFileHandleRef,
      saveCurrentFile,
      scheduleAutoSave,
      selectedFileSourceRef,
      selectedFileRef,
      setActiveShareRecord,
      setBusy,
      setCollabDocument,
      setCreatedShare,
      setEditorDocument,
      setErrorMessage,
      setRetryLoadPath,
      setSaveStateSynced,
      setSelectedFile,
      setSingleFileSource,
      setTreeSelection,
      singleFileSourceRef,
      startOwnerShareHost,
      stopOwnerShareHost,
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
      let current = collabDocumentRef.current;
      if (current?.path == file.path && selectedFileSourceRef.current === runtime) return current;

      invalidateDocumentTarget();
      let document = await openMarkdownCollabDocument(runtime, file.path);

      try {
        await disposeActiveCollabDocument();
      } catch (error) {
        await document.dispose().catch(() => {});
        throw error;
      }
      invalidateActiveDocumentSave();
      collabDocumentRef.current = document;
      bindCollabDocumentBroadcast(runtime, document);

      let value = document.value;
      let needsSourceWrite = collabDocumentNeedsSourceWrite(document);
      editorValueRef.current = value;
      cleanValueRef.current = value;
      dirtyRef.current = needsSourceWrite;
      editVersionRef.current += 1;
      setCollabDocument(document);
      setEditorDocument((currentDocument) => ({
        path: file.path,
        value,
        version: currentDocument.version + 1,
      }));
      setSaveStateSynced(needsSourceWrite ? "pending" : "saved");
      if (needsSourceWrite) scheduleAutoSave();
      return document;
    },
    [
      bindCollabDocumentBroadcast,
      cleanValueRef,
      collabDocumentRef,
      dirtyRef,
      disposeActiveCollabDocument,
      editVersionRef,
      editorValueRef,
      invalidateActiveDocumentSave,
      invalidateDocumentTarget,
      scheduleAutoSave,
      selectedFileSourceRef,
      setCollabDocument,
      setEditorDocument,
      setSaveStateSynced,
    ],
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
    loadingFilePath,
    openSingleFileDraft,
    reconcileCurrentDocumentSource,
    recreateCurrentDocumentSource,
    restoreCloudRedirectEditorDraft,
    resolveCurrentDocumentUseExternal,
    saveCurrentFile,
  };
}
