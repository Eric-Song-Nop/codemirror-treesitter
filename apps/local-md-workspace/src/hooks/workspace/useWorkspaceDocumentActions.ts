import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { VersionVector } from "loro-crdt";
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
  rememberLastSingleFileDraft,
} from "@/lib/single-file-draft-store";
import { errorToMessage } from "@/lib/workspace/errors";
import { createDocumentSession, type DocumentSession } from "@/lib/workspace/document-session";
import { createSingleFileDraftBackend, singleFileMarkdownNode } from "@/lib/workspace/single-file";
import { workspaceSelectedPathContext } from "@/lib/workspace/state";
import type {
  ActiveOwnerShareRecord,
  EditorDocument,
  SaveState,
  SingleFileSource,
  SourceAutoSaveTask,
} from "@/lib/workspace/types";
import { saveStoredWorkspaceSelectedPath } from "@/lib/workspace-store";
import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";

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
  dirtyRef: MutableRef<boolean>;
  editVersionRef: MutableRef<number>;
  editorValueRef: MutableRef<string>;
  isOwnerShareHostPath: (backend: WorkspaceBackend, path: string) => boolean;
  loadFileRequestRef: MutableRef<number>;
  localFileHandleRef: MutableRef<AccessFileHandle | null>;
  saveOperationRef: MutableRef<number>;
  saveStateRef: MutableRef<SaveState>;
  scheduleAutoSaveRef: MutableRef<() => void>;
  selectedFileBackendRef: MutableRef<WorkspaceBackend | null>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  sendHostDocumentUpdate: (
    backend: WorkspaceBackend,
    path: string,
    update: Uint8Array | null,
  ) => void;
  sendHostSaveAck: (
    backend: WorkspaceBackend,
    path: string,
    value: string,
    savedVersion: VersionVector,
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
  dirtyRef,
  editVersionRef,
  editorValueRef,
  isOwnerShareHostPath,
  loadFileRequestRef,
  localFileHandleRef,
  saveOperationRef,
  saveStateRef,
  scheduleAutoSaveRef,
  selectedFileBackendRef,
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

  let disposeActiveCollabDocument = useCallback(() => {
    collabSyncCleanupRef.current();
    collabSyncCleanupRef.current = () => {};
    let document = collabDocumentRef.current;
    collabDocumentRef.current = null;
    return document?.dispose() ?? Promise.resolve();
  }, [collabDocumentRef, collabSyncCleanupRef]);

  let {
    bindCollabDocumentBroadcast,
    clearPendingSaveTimer,
    handleEditorInput,
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
    selectedFileBackendRef,
    selectedFileRef,
    sendHostDocumentUpdate,
    sendHostSaveAck,
    setEditorDocument,
    setErrorMessage,
    setRetryLoadPath,
    setSaveStateSynced,
  });

  let clearActiveDocument = useCallback(() => {
    loadFileRequestRef.current += 1;
    invalidateActiveDocumentSave();
    clearPendingSaveTimer();
    stopOwnerShareHost();
    void disposeActiveCollabDocument().catch((error: unknown) => {
      setErrorMessage(errorToMessage(error));
    });
    selectedFileRef.current = null;
    selectedFileBackendRef.current = null;
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
  }, [
    cleanValueRef,
    clearPendingSaveTimer,
    collabDocumentRef,
    dirtyRef,
    disposeActiveCollabDocument,
    editVersionRef,
    editorValueRef,
    invalidateActiveDocumentSave,
    loadFileRequestRef,
    localFileHandleRef,
    selectedFileBackendRef,
    selectedFileRef,
    setActiveShareRecord,
    setCollabDocument,
    setCreatedShare,
    setEditorDocument,
    setErrorMessage,
    setSaveStateSynced,
    setSelectedFile,
    setSingleFileSource,
    setTreeSelection,
    singleFileSourceRef,
    stopOwnerShareHost,
  ]);

  let beginDocumentTransition = useCallback(
    (path = "") => {
      setSelectedFile(null);
      setCollabDocument(null);
      setEditorDocument((current) => ({
        path,
        value: "",
        version: current.version + 1,
      }));
    },
    [setCollabDocument, setEditorDocument, setSelectedFile],
  );

  let activateSingleFileDocument = useCallback(
    (
      source: SingleFileSource,
      backend: WorkspaceBackend,
      file: MarkdownFileNode,
      value: string,
    ) => {
      loadFileRequestRef.current += 1;
      invalidateActiveDocumentSave();
      clearPendingSaveTimer();
      stopOwnerShareHost();
      void disposeActiveCollabDocument().catch((error: unknown) => {
        setErrorMessage(errorToMessage(error));
      });
      selectedFileBackendRef.current = backend;
      selectedFileRef.current = file;
      editorValueRef.current = value;
      cleanValueRef.current = value;
      dirtyRef.current = false;
      editVersionRef.current = 0;
      localFileHandleRef.current = source.kind == "local-file" ? localFileHandleRef.current : null;

      setSingleFileSource(source);
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
      loadFileRequestRef,
      localFileHandleRef,
      selectedFileBackendRef,
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
        reuseLast?: boolean;
        saveCurrent?: boolean;
        shouldContinue?: () => boolean;
      } = {},
    ) => {
      if (options.shouldContinue && !options.shouldContinue()) return;
      if ((options.saveCurrent ?? true) && !(await saveCurrentFile())) return;
      if (options.shouldContinue && !options.shouldContinue()) return;

      setBusy(true);
      setErrorMessage("");
      setRetryLoadPath(null);
      try {
        let draft =
          options.reuseLast === true ? await loadLastSingleFileDraft().catch(() => null) : null;
        draft ??= await createSingleFileDraft({ name: "Untitled.md" });
        await rememberLastSingleFileDraft(draft.id).catch(() => {});
        if (options.shouldContinue && !options.shouldContinue()) return;

        let backend = createSingleFileDraftBackend(draft);
        activateSingleFileDocument(
          { draftId: draft.id, kind: "draft", name: draft.name },
          backend,
          singleFileMarkdownNode(draft.name),
          draft.value,
        );
      } catch (error) {
        setErrorMessage(errorToMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [activateSingleFileDocument, saveCurrentFile, setBusy, setErrorMessage, setRetryLoadPath],
  );

  let loadFile = useCallback(
    async (
      backend: WorkspaceBackend,
      file: MarkdownFileNode,
      options: { saveCurrent?: boolean } = {},
    ) => {
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
          selectedFileBackendRef.current === backend &&
          selectedFileRef.current?.path == file.path;
        if (!isSameActiveWorkspaceFile) beginDocumentTransition(file.path);

        let restoredShareRecord = await restoreOwnerShareRecordForPath(backend, file.path).catch(
          () => null,
        );
        if (!isCurrentLoadRequest()) return;
        let document = await openMarkdownCollabDocument(backend, file.path);
        if (!isCurrentLoadRequest()) {
          await document.dispose();
          return;
        }
        let value = document.value;
        if (!isOwnerShareHostPath(backend, file.path)) stopOwnerShareHost();
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
        selectedFileBackendRef.current = backend;
        collabDocumentRef.current = document;
        bindCollabDocumentBroadcast(backend, document);
        let needsSourceWrite = collabDocumentNeedsSourceWrite(document);
        editorValueRef.current = value;
        cleanValueRef.current = value;
        dirtyRef.current = needsSourceWrite;
        editVersionRef.current = 0;
        setSingleFileSource(null);
        localFileHandleRef.current = null;
        let selectedPathContext = workspaceSelectedPathContext(backend);
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
            createDocumentSession(backend, file, document),
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
      isOwnerShareHostPath,
      loadFileRequestRef,
      localFileHandleRef,
      saveCurrentFile,
      scheduleAutoSave,
      selectedFileBackendRef,
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
    (backend: WorkspaceBackend, draft: CloudRedirectDraft) => {
      if (!draft.selectedPath || draft.dirtyValue == null) return false;

      let file = selectedFileRef.current;
      if (!file || file.path != draft.selectedPath) return false;

      selectedFileBackendRef.current = backend;
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
      scheduleAutoSave,
      selectedFileBackendRef,
      selectedFileRef,
      setEditorDocument,
      setSaveStateSynced,
    ],
  );

  let ensureSelectedCollabDocument = useCallback(
    async (backend: WorkspaceBackend, file: MarkdownFileNode) => {
      let current = collabDocumentRef.current;
      if (current?.path == file.path && selectedFileBackendRef.current === backend) return current;

      let document = await openMarkdownCollabDocument(backend, file.path);

      try {
        await disposeActiveCollabDocument();
      } catch (error) {
        await document.dispose().catch(() => {});
        throw error;
      }
      invalidateActiveDocumentSave();
      collabDocumentRef.current = document;
      bindCollabDocumentBroadcast(backend, document);

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
      scheduleAutoSave,
      selectedFileBackendRef,
      setCollabDocument,
      setEditorDocument,
      setSaveStateSynced,
    ],
  );

  return {
    activateSingleFileDocument,
    beginDocumentTransition,
    clearActiveDocument,
    discardMaterializedDraft,
    ensureSelectedCollabDocument,
    handleEditorInput,
    loadFile,
    loadingFilePath,
    openSingleFileDraft,
    restoreCloudRedirectEditorDraft,
    saveCurrentFile,
  };
}
