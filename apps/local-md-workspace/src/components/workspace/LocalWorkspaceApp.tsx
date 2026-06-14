import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Extension } from "@codemirror/state";
import type { VersionVector } from "loro-crdt";
import type { LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileTreeDeleteTarget } from "@/components/FileTree";
import { WorkspaceDialogs } from "@/components/workspace/WorkspaceDialogs";
import { WorkspaceEditorPane } from "@/components/workspace/WorkspaceEditorPane";
import { WorkspaceErrorBanner } from "@/components/workspace/WorkspaceErrorBanner";
import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { WorkspaceSidebar } from "@/components/workspace/WorkspaceSidebar";
import { useWorkspaceEntryDialogs } from "@/hooks/workspace/useWorkspaceEntryDialogs";
import { useWorkspaceFileActions } from "@/hooks/workspace/useWorkspaceFileActions";
import { useWorkspaceImageAssets } from "@/hooks/workspace/useWorkspaceImageAssets";
import { useWorkspaceShareActions } from "@/hooks/workspace/useWorkspaceShareActions";
import { useWorkspaceShareState } from "@/hooks/workspace/useWorkspaceShareState";
import {
  authorizeDropboxWithPkce,
  completeDropboxRedirectOAuthIfPresent,
  completeDropboxPopupOAuthIfPresent,
  type DropboxAccessToken,
} from "@/lib/dropbox-oauth";
import {
  saveDropboxRedirectDraft,
  takeDropboxRedirectDraft,
  type DropboxRedirectDraft,
} from "@/lib/dropbox-redirect-draft";
import {
  acknowledgeCollabDocumentSourceSaved,
  captureCollabDocumentMaterialization,
  collabDocumentNeedsSourceWrite,
  getCollabDocumentValue,
  ingestExternalMarkdownEdit,
  openMarkdownCollabDocument,
  saveCollabDocumentSnapshot,
  savePendingCollabDocumentUpdates,
  type CollabDocumentState,
  type CollabSourceImportResult,
} from "@/lib/collaboration/markdown-document";
import { hashMarkdownText } from "@/lib/markdown-hash";
import { isWorkspaceWriteConflictError } from "@/lib/workspace-file-conflict";
import { createCollabDocumentBroadcastSync } from "@/lib/collaboration/document-sync";
import {
  findOwnerShareRecordForPath,
  type OwnerShareRecord,
} from "@/lib/collaboration/share-storage";
import { isMobileBrowser } from "@/lib/browser-support";
import { ShareRelayConnection } from "@/lib/collaboration/share-relay-connection";
import {
  configuredShareRelayOrigin,
  createRelayShareSession,
} from "@/lib/collaboration/share-relay-client";
import {
  createLocalWorkspaceBackend,
  ensureReadWritePermission,
  pickWorkspaceDirectory,
  queryReadWritePermission,
  supportsDirectoryPicker,
  supportsSaveFilePicker,
  type AccessDirectoryHandle,
  type AccessFileHandle,
} from "@/lib/file-system";
import {
  flattenMarkdownFiles,
  type MarkdownDirectoryNode,
  type MarkdownFileNode,
  type WorkspaceBackend,
} from "@/lib/workspace-backend";
import { useI18n } from "@/lib/i18n";
import { defaultSidebarOpen, isMobileSidebarViewport } from "@/lib/workspace/constants";
import {
  defaultDropboxAppKey,
  defaultDropboxRedirectUri,
  defaultDropboxRoot,
  isDropboxRedirectCallbackWindow,
  normalizeDropboxRootInput,
} from "@/lib/workspace/dropbox-config";
import { errorToMessage, isAbortError } from "@/lib/workspace/errors";
import {
  getOrCreateOwnerShareClientId,
  mergeOwnerShareStatus,
  readHostSecret,
  serializeVersionVector,
} from "@/lib/workspace/share-host";
import { createSingleFileDraftBackend, singleFileMarkdownNode } from "@/lib/workspace/single-file";
import {
  createEphemeralLocalWorkspaceRecord,
  loadWorkspaceSelectedPath,
  saveStateLabel,
  workspaceSelectedPathContext,
} from "@/lib/workspace/state";
import type { EditorDocument, SaveState, SingleFileSource } from "@/lib/workspace/types";
import {
  clearStoredWorkspaceSelectedPath,
  loadStoredDropboxWorkspaceConfig,
  loadStoredWorkspaceKind,
  loadStoredLocalWorkspaceRecord,
  rememberStoredLocalWorkspace,
  saveStoredDropboxWorkspaceConfig,
  saveStoredWorkspaceSelectedPath,
  saveStoredWorkspaceKind,
  type StoredLocalWorkspaceRecord,
  type StoredDropboxWorkspaceConfig,
  type StoredWorkspaceKind,
} from "@/lib/workspace-store";
import {
  clearLastSingleFileDraft,
  createSingleFileDraft,
  deleteSingleFileDraft,
  loadLastSingleFileDraft,
  rememberLastSingleFileDraft,
} from "@/lib/single-file-draft-store";

const emptyEditorExtensions: Extension[] = [];

export function LocalWorkspaceApp() {
  let { locale, t, toggleLocale } = useI18n();
  let [workspaceBackend, setWorkspaceBackend] = useState<WorkspaceBackend | null>(null);
  let [storedLocalWorkspace, setStoredLocalWorkspace] = useState<StoredLocalWorkspaceRecord | null>(
    null,
  );
  let [storedDropboxConfig, setStoredDropboxConfig] = useState<StoredDropboxWorkspaceConfig | null>(
    () => loadStoredDropboxWorkspaceConfig(),
  );
  let [storedWorkspaceKind, setStoredWorkspaceKind] = useState<StoredWorkspaceKind | null>(() =>
    loadStoredWorkspaceKind(),
  );
  let [tree, setTree] = useState<MarkdownDirectoryNode | null>(null);
  let [files, setFiles] = useState<MarkdownFileNode[]>([]);
  let [selectedFile, setSelectedFile] = useState<MarkdownFileNode | null>(null);
  let [treeSelection, setTreeSelection] = useState<FileTreeDeleteTarget | null>(null);
  let [singleFileSource, setSingleFileSource] = useState<SingleFileSource | null>(null);
  let [editorDocument, setEditorDocument] = useState<EditorDocument>({
    path: "",
    value: "",
    version: 0,
  });
  let [collabDocument, setCollabDocument] = useState<CollabDocumentState | null>(null);
  let [saveState, setSaveState] = useState<SaveState>("idle");
  let [errorMessage, setErrorMessage] = useState("");
  let [retryLoadPath, setRetryLoadPath] = useState<string | null>(null);
  let [busy, setBusy] = useState(false);
  let [dropboxConnecting, setDropboxConnecting] = useState(false);
  let [restoreChecking, setRestoreChecking] = useState(false);
  let [sidebarOpen, setSidebarOpen] = useState(() => defaultSidebarOpen());

  let editorElementRef = useRef<LiveMdEditorElement | null>(null);
  let workspaceBackendRef = useRef<WorkspaceBackend | null>(null);
  let selectedFileBackendRef = useRef<WorkspaceBackend | null>(null);
  let selectedFileRef = useRef<MarkdownFileNode | null>(null);
  let singleFileSourceRef = useRef<SingleFileSource | null>(null);
  let localFileHandleRef = useRef<AccessFileHandle | null>(null);
  let collabDocumentRef = useRef<CollabDocumentState | null>(null);
  let collabSyncCleanupRef = useRef<() => void>(() => {});
  let shareHostConnectionRef = useRef<ShareRelayConnection | null>(null);
  let shareHostRecordRef = useRef<OwnerShareRecord | null>(null);
  let shareHostUpdateCleanupRef = useRef<() => void>(() => {});
  let editorValueRef = useRef("");
  let cleanValueRef = useRef("");
  let dirtyRef = useRef(false);
  let editVersionRef = useRef(0);
  let saveStateRef = useRef<SaveState>("idle");
  let saveTimerRef = useRef<number | null>(null);
  let saveOperationRef = useRef(0);
  let activeDocumentGenerationRef = useRef(0);
  let loadFileRequestRef = useRef(0);
  let dropboxTokenRef = useRef<DropboxAccessToken | null>(null);
  let dropboxTokenAppKeyRef = useRef("");
  let dropboxAuthPromiseRef = useRef<Promise<DropboxAccessToken> | null>(null);
  let dropboxAutoRestoreAttemptedRef = useRef(false);
  let dropboxRedirectPendingRef = useRef(isDropboxRedirectCallbackWindow());
  let [localRestoreChecked, setLocalRestoreChecked] = useState(false);
  let [dropboxAutoRestoreChecked, setDropboxAutoRestoreChecked] = useState(false);
  let {
    activeShareForSelectedFile,
    activeShareRecord,
    closeShareDialog,
    copySharedFileLink,
    createdShare,
    openShareDialog,
    setActiveShareRecord,
    setCreatedShare,
    setShareCopied,
    setShareCreating,
    setShareError,
    setShareExpiration,
    shareCopied,
    shareCreating,
    shareDialogOpen,
    shareError,
    shareExpiration,
  } = useWorkspaceShareState({
    selectedFile,
    singleFileSource,
  });

  useEffect(() => {
    workspaceBackendRef.current = workspaceBackend;
  }, [workspaceBackend]);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  useEffect(() => {
    singleFileSourceRef.current = singleFileSource;
  }, [singleFileSource]);

  useEffect(() => {
    collabDocumentRef.current = collabDocument;
  }, [collabDocument]);

  useEffect(
    () => () => {
      collabSyncCleanupRef.current();
      shareHostUpdateCleanupRef.current();
      shareHostConnectionRef.current?.close();
      collabDocumentRef.current?.dispose();
    },
    [],
  );

  useEffect(() => {
    completeDropboxPopupOAuthIfPresent();
  }, []);

  let selectedPath = singleFileSource ? null : (selectedFile?.path ?? null);
  let rootName = tree?.name ?? workspaceBackend?.name ?? storedLocalWorkspace?.name ?? "Grove";
  let selectedPathLabel = selectedFile
    ? selectedFile.path == selectedFile.name
      ? ""
      : selectedFile.path
    : "";
  let headerTitle = singleFileSource?.name ?? selectedFile?.name ?? rootName;
  let headerSubtitle = singleFileSource
    ? ""
    : selectedFile
      ? selectedPathLabel
      : workspaceBackend
        ? files.length == 1
          ? t("workspace.markdownFileCount_one")
          : t("workspace.markdownFileCount_other", { count: files.length })
        : "";
  let browserSupported = supportsDirectoryPicker();
  let canShareFile = Boolean(!singleFileSource && workspaceBackend && selectedFile);
  let canRefreshWorkspace = Boolean(workspaceBackend);
  let folderAccessUnavailableMessage = browserSupported
    ? ""
    : isMobileBrowser()
      ? t("errors.fileSystemAccessUnavailableMobile")
      : t("errors.fileSystemAccessUnavailableDesktop");
  let {
    canInsertImage,
    handleEditorImageFiles,
    handleImageInputChange,
    imageInputRef,
    replaceImageAssets: replaceWorkspaceImageAssets,
    resolveImageAssetFile,
    resolveImageSource,
  } = useWorkspaceImageAssets({
    editorDocument,
    editorElementRef,
    selectedFile,
    selectedFileRef,
    setBusy,
    setErrorMessage,
    singleFileSource,
    singleFileSourceRef,
    workspaceBackend,
    workspaceBackendRef,
  });

  let setSaveStateSynced = useCallback((nextState: SaveState) => {
    if (saveStateRef.current == nextState) return;
    saveStateRef.current = nextState;
    setSaveState(nextState);
  }, []);

  let stopOwnerShareHost = useCallback(() => {
    shareHostUpdateCleanupRef.current();
    shareHostUpdateCleanupRef.current = () => {};
    shareHostConnectionRef.current?.close();
    shareHostConnectionRef.current = null;
    shareHostRecordRef.current = null;
  }, []);

  let invalidateActiveDocumentSave = useCallback(() => {
    activeDocumentGenerationRef.current += 1;
    saveOperationRef.current += 1;
  }, []);

  let clearActiveDocument = useCallback(() => {
    loadFileRequestRef.current += 1;
    invalidateActiveDocumentSave();
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    stopOwnerShareHost();
    collabSyncCleanupRef.current();
    collabSyncCleanupRef.current = () => {};
    collabDocumentRef.current?.dispose();
    collabDocumentRef.current = null;
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
  }, [invalidateActiveDocumentSave, setSaveStateSynced, stopOwnerShareHost]);

  let beginDocumentTransition = useCallback((path = "") => {
    setSelectedFile(null);
    setCollabDocument(null);
    setEditorDocument((current) => ({
      path,
      value: "",
      version: current.version + 1,
    }));
  }, []);

  let activateSingleFileDocument = useCallback(
    (
      source: SingleFileSource,
      backend: WorkspaceBackend,
      file: MarkdownFileNode,
      value: string,
    ) => {
      loadFileRequestRef.current += 1;
      invalidateActiveDocumentSave();
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      stopOwnerShareHost();
      collabSyncCleanupRef.current();
      collabSyncCleanupRef.current = () => {};
      collabDocumentRef.current?.dispose();
      collabDocumentRef.current = null;
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
    [invalidateActiveDocumentSave, setSaveStateSynced, stopOwnerShareHost],
  );

  let discardMaterializedDraft = useCallback((source: SingleFileSource | null) => {
    if (source?.kind != "draft") return;
    void deleteSingleFileDraft(source.draftId).catch(() => {});
    void clearLastSingleFileDraft(source.draftId).catch(() => {});
  }, []);

  let sendHostSaveAck = useCallback((path: string, value: string, savedVersion: VersionVector) => {
    let record = shareHostRecordRef.current;
    let connection = shareHostConnectionRef.current;
    if (!record || !connection || record.path != path) return;

    let materializedHash = hashMarkdownText(value);
    connection.enqueueHostSaveAck(
      new TextEncoder().encode(
        JSON.stringify({
          materializedHash,
          savedAt: Date.now(),
          shareId: record.shareId,
          versionVector: serializeVersionVector(savedVersion),
        }),
      ),
    );
    setActiveShareRecord((current) =>
      current?.shareId == record.shareId
        ? { ...current, lastHostSavedVersion: materializedHash }
        : current,
    );
  }, []);

  let sendHostDocumentUpdate = useCallback((path: string, update: Uint8Array | null) => {
    if (!update?.byteLength) return;
    let record = shareHostRecordRef.current;
    let connection = shareHostConnectionRef.current;
    if (!record || !connection || record.path != path) return;
    connection.enqueueDocumentUpdate(update);
  }, []);

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
    [],
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

    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

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
  }, [applyCollabDocumentValue, sendHostDocumentUpdate, sendHostSaveAck, setSaveStateSynced]);

  let scheduleAutoSave = useCallback(() => {
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);

    let delay = selectedFileBackendRef.current?.kind == "opendal-dropbox" ? 2500 : 650;
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveCurrentFile();
    }, delay);
  }, [saveCurrentFile]);

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
    [activateSingleFileDocument, saveCurrentFile],
  );

  let startOwnerShareHost = useCallback(
    async (
      record: OwnerShareRecord,
      backend: WorkspaceBackend,
      document: CollabDocumentState,
      options: { actionLabel?: string; shouldContinue?: () => boolean } = {},
    ) => {
      if (options.shouldContinue && !options.shouldContinue()) return;
      stopOwnerShareHost();

      let actionLabel = options.actionLabel ?? "Link created";
      let hostSecret = readHostSecret(record);
      if (!hostSecret) {
        setShareError(`${actionLabel}, but this browser cannot host it without the host key.`);
        return;
      }

      try {
        let session = await createRelayShareSession(
          configuredShareRelayOrigin(),
          record.shareId,
          "host",
          hostSecret,
        );
        if (options.shouldContinue && !options.shouldContinue()) return;
        setActiveShareRecord((current) =>
          current?.shareId == record.shareId
            ? {
                ...current,
                expiresAt: session.shareExpiresAt,
                guestCount: session.guestCount,
                hostOnline: session.hostOnline,
                peerCount: session.peerCount,
                pendingHostSave: session.pendingHostSave,
              }
            : current,
        );
        let connection = new ShareRelayConnection({
          clientId: getOrCreateOwnerShareClientId(),
          doc: document.doc,
          onDocumentImported: () => {
            editorValueRef.current = getCollabDocumentValue(document);
            editVersionRef.current += 1;
            dirtyRef.current = true;
            setSaveStateSynced("pending");
            void savePendingCollabDocumentUpdates(backend, document).catch(() => {});
            scheduleAutoSave();
          },
          onError: (message) => setShareError(message),
          onShareStatus: (status) => {
            setActiveShareRecord((current) =>
              current?.shareId == status.shareId ? mergeOwnerShareStatus(current, status) : current,
            );
          },
          relayOrigin: configuredShareRelayOrigin(),
          sessionToken: session.sessionToken,
          shareId: record.shareId,
        });
        shareHostConnectionRef.current = connection;
        shareHostRecordRef.current = record;
        shareHostUpdateCleanupRef.current = document.doc.subscribeLocalUpdates((bytes) => {
          connection.enqueueDocumentUpdate(bytes);
        });
        connection.connect();
      } catch (error) {
        if (options.shouldContinue && !options.shouldContinue()) return;
        setShareError(`${actionLabel}, but host sync did not start: ${errorToMessage(error)}`);
      }
    },
    [scheduleAutoSave, setSaveStateSynced, stopOwnerShareHost],
  );

  let handleEditorInput = useCallback(
    (value: string) => {
      editorValueRef.current = value;
      let backend = selectedFileBackendRef.current;
      let document = collabDocumentRef.current;
      if (backend && document) {
        void savePendingCollabDocumentUpdates(backend, document).catch(() => {});
      }
      editVersionRef.current += 1;
      dirtyRef.current = true;

      if (saveStateRef.current != "pending") {
        setSaveStateSynced("pending");
      }

      scheduleAutoSave();
    },
    [scheduleAutoSave, setSaveStateSynced],
  );

  let loadFile = useCallback(
    async (
      backend: WorkspaceBackend,
      file: MarkdownFileNode,
      options: { saveCurrent?: boolean } = {},
    ) => {
      let requestId = ++loadFileRequestRef.current;
      let isCurrentLoadRequest = () => loadFileRequestRef.current == requestId;

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

        let restoredShareRecord = await findOwnerShareRecordForPath(backend, file.path).catch(
          () => null,
        );
        if (!isCurrentLoadRequest()) return;
        let document = await openMarkdownCollabDocument(backend, file.path);
        if (!isCurrentLoadRequest()) {
          document.dispose();
          return;
        }
        let value = document.value;
        if (shareHostRecordRef.current?.path != file.path) stopOwnerShareHost();
        collabSyncCleanupRef.current();
        collabDocumentRef.current?.dispose();
        collabSyncCleanupRef.current = () => {};
        invalidateActiveDocumentSave();
        selectedFileRef.current = file;
        selectedFileBackendRef.current = backend;
        collabDocumentRef.current = document;
        if (document) {
          let handleRemoteDocumentUpdate = () => {
            if (collabDocumentRef.current !== document) return;
            void (async () => {
              try {
                editorValueRef.current = getCollabDocumentValue(document);
                editVersionRef.current += 1;
                dirtyRef.current = true;
                setSaveStateSynced("pending");
                await saveCollabDocumentSnapshot(backend, document);
                scheduleAutoSave();
              } catch (error) {
                setSaveStateSynced("error");
                setErrorMessage(errorToMessage(error));
              }
            })();
          };
          collabSyncCleanupRef.current = createCollabDocumentBroadcastSync({
            backend,
            doc: document.doc,
            docId: document.docId,
            onRemoteUpdate: handleRemoteDocumentUpdate,
          });
        }
        let needsSourceWrite = document ? collabDocumentNeedsSourceWrite(document) : false;
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
        if (restoredShareRecord && document) {
          void startOwnerShareHost(restoredShareRecord, backend, document, {
            shouldContinue: isCurrentLoadRequest,
          });
        }
        if (needsSourceWrite) scheduleAutoSave();
        setRetryLoadPath(null);
      } catch (error) {
        if (!isCurrentLoadRequest()) return;
        setErrorMessage(errorToMessage(error));
        setRetryLoadPath(file.path);
      } finally {
        if (isCurrentLoadRequest()) setBusy(false);
      }
    },
    [
      beginDocumentTransition,
      saveCurrentFile,
      scheduleAutoSave,
      setSaveStateSynced,
      startOwnerShareHost,
      stopOwnerShareHost,
    ],
  );

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
      } else {
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
      }
    },
    [clearActiveDocument, loadFile, replaceWorkspaceImageAssets],
  );

  let rememberWorkspaceHandle = useCallback(async (handle: AccessDirectoryHandle) => {
    let record = await rememberStoredLocalWorkspace(handle);
    let nextRecord = record ?? createEphemeralLocalWorkspaceRecord(handle);
    setStoredLocalWorkspace(nextRecord);
    setStoredWorkspaceKind("local");
    saveStoredWorkspaceKind("local");
    return nextRecord;
  }, []);

  let findCurrentEditorWorkspacePath = useCallback(async (backend: WorkspaceBackend) => {
    let source = singleFileSourceRef.current;
    let file = selectedFileRef.current;
    if (!source && file && selectedFileBackendRef.current?.id == backend.id) return file.path;

    if (source?.kind == "local-file" && localFileHandleRef.current) {
      return (await backend.findFilePathForHandle?.(localFileHandleRef.current)) ?? null;
    }

    if (source?.kind == "dropbox-file" && backend.kind == "opendal-dropbox") return source.path;
    return null;
  }, []);

  let refreshWorkspaceForCurrentEditor = useCallback(
    async (backend: WorkspaceBackend) => {
      let nextSelectedPath = await findCurrentEditorWorkspacePath(backend).catch(() => null);
      await loadTree(backend, nextSelectedPath, { saveBeforeSelect: false });
    },
    [findCurrentEditorWorkspacePath, loadTree],
  );

  let authorizeDropboxAccess = useCallback(async (appKey: string, root?: string) => {
    let normalizedAppKey = appKey.trim();
    if (dropboxAuthPromiseRef.current) return dropboxAuthPromiseRef.current;

    let redirectUri = defaultDropboxRedirectUri();
    let promise = authorizeDropboxWithPkce({
      allowFullPageRedirect: true,
      appKey: normalizedAppKey,
      ...(redirectUri ? { redirectUri } : {}),
      onBeforeFullPageRedirect: () => {
        let backend = workspaceBackendRef.current;
        let file = selectedFileRef.current;
        let shouldRestoreDirtyEditor =
          backend?.kind == "opendal-dropbox" && Boolean(file) && dirtyRef.current;

        saveDropboxRedirectDraft({
          appKey: normalizedAppKey,
          dirtyValue: shouldRestoreDirtyEditor ? editorValueRef.current : undefined,
          root,
          selectedPath: shouldRestoreDirtyEditor ? file?.path : undefined,
        });
      },
    });
    dropboxAuthPromiseRef.current = promise;

    try {
      let token = await promise;
      dropboxTokenRef.current = token;
      dropboxTokenAppKeyRef.current = normalizedAppKey;
      return token;
    } finally {
      if (dropboxAuthPromiseRef.current == promise) dropboxAuthPromiseRef.current = null;
    }
  }, []);

  let createDropboxBackend = useCallback(
    async (config: StoredDropboxWorkspaceConfig) => {
      let appKey = config.appKey.trim();
      if (!appKey) throw new Error("Dropbox app key is required.");

      let root = normalizeDropboxRootInput(config.root);
      let refreshAccessToken = () => authorizeDropboxAccess(appKey, root);
      let getAccessToken = async () => {
        let token = dropboxTokenRef.current;
        if (
          token &&
          dropboxTokenAppKeyRef.current == appKey &&
          token.expiresAt > Date.now() + 5 * 60 * 1000
        ) {
          return token;
        }
        return refreshAccessToken();
      };

      await getAccessToken();
      let { createDropboxWorkspaceBackend } = await import("@/lib/dropbox-workspace-backend");
      let backend = createDropboxWorkspaceBackend({
        getAccessToken,
        name: t("workspace.dropboxWorkspace"),
        refreshAccessToken,
        root,
      });
      let storedConfig = root ? { appKey, root } : { appKey };
      setStoredDropboxConfig(storedConfig);
      setStoredWorkspaceKind("dropbox");
      saveStoredDropboxWorkspaceConfig(storedConfig);
      saveStoredWorkspaceKind("dropbox");
      return backend;
    },
    [authorizeDropboxAccess, t],
  );

  let restoreDropboxRedirectEditorDraft = useCallback(
    (backend: WorkspaceBackend, draft: DropboxRedirectDraft) => {
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
    [scheduleAutoSave, setSaveStateSynced],
  );

  let openWorkspace = useCallback(async () => {
    setErrorMessage("");
    setRetryLoadPath(null);
    if (!(await saveCurrentFile())) return;
    if (!supportsDirectoryPicker()) {
      setErrorMessage(folderAccessUnavailableMessage);
      return;
    }

    setBusy(true);
    try {
      let handle = await pickWorkspaceDirectory();
      if (!(await ensureReadWritePermission(handle))) {
        setErrorMessage("Read-write folder permission was not granted.");
        setRetryLoadPath(null);
        return;
      }
      let record = await rememberWorkspaceHandle(handle);
      let backend = createLocalWorkspaceBackend(handle, record.id);
      dropboxTokenRef.current = null;
      dropboxTokenAppKeyRef.current = "";
      setWorkspaceBackend(backend);
      setSidebarOpen(defaultSidebarOpen());
      await loadTree(backend, loadWorkspaceSelectedPath(backend));
    } catch (error) {
      if (!isAbortError(error)) setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [folderAccessUnavailableMessage, loadTree, rememberWorkspaceHandle, saveCurrentFile]);

  let openDropboxWorkspace = useCallback(
    async (
      config: StoredDropboxWorkspaceConfig,
      options: {
        restoreDraft?: DropboxRedirectDraft | null;
        skipSaveCurrent?: boolean;
      } = {},
    ) => {
      setErrorMessage("");
      setRetryLoadPath(null);
      if (!options.skipSaveCurrent && !(await saveCurrentFile())) return false;

      setBusy(true);
      setDropboxConnecting(true);

      try {
        let backend = await createDropboxBackend(config);
        setWorkspaceBackend(backend);
        setSidebarOpen(defaultSidebarOpen());
        await loadTree(
          backend,
          options.restoreDraft?.selectedPath ?? loadWorkspaceSelectedPath(backend),
          {
            saveBeforeSelect: false,
          },
        );
        if (options.restoreDraft) restoreDropboxRedirectEditorDraft(backend, options.restoreDraft);
        return true;
      } catch (error) {
        setErrorMessage(errorToMessage(error));
        setRetryLoadPath(null);
        return false;
      } finally {
        setDropboxConnecting(false);
        setBusy(false);
      }
    },
    [createDropboxBackend, loadTree, restoreDropboxRedirectEditorDraft, saveCurrentFile],
  );

  let restoreStoredWorkspace = useCallback(async () => {
    if (!storedLocalWorkspace) return;

    setBusy(true);
    setErrorMessage("");
    setRetryLoadPath(null);
    try {
      if (!(await ensureReadWritePermission(storedLocalWorkspace.handle))) {
        setErrorMessage("Read-write folder permission was not granted.");
        setRetryLoadPath(null);
        return;
      }

      let backend = createLocalWorkspaceBackend(
        storedLocalWorkspace.handle,
        storedLocalWorkspace.id,
      );
      dropboxTokenRef.current = null;
      dropboxTokenAppKeyRef.current = "";
      setWorkspaceBackend(backend);
      setSidebarOpen(defaultSidebarOpen());
      await loadTree(backend, loadWorkspaceSelectedPath(backend), { saveBeforeSelect: false });
    } catch (error) {
      setErrorMessage(errorToMessage(error));
      setRetryLoadPath(null);
    } finally {
      setBusy(false);
    }
  }, [loadTree, storedLocalWorkspace]);

  let restoreDropboxWorkspace = useCallback(async () => {
    if (!storedDropboxConfig) return;
    let appKey = defaultDropboxAppKey();
    if (!appKey) {
      setErrorMessage(
        "Dropbox workspace is not configured. Set VITE_DROPBOX_APP_KEY for this app.",
      );
      setRetryLoadPath(null);
      return;
    }
    await openDropboxWorkspace({
      appKey,
      root: storedDropboxConfig.root,
    });
  }, [openDropboxWorkspace, storedDropboxConfig]);

  let refreshWorkspace = useCallback(async () => {
    if (!workspaceBackend || !(await saveCurrentFile())) return;

    setBusy(true);
    setErrorMessage("");
    setRetryLoadPath(null);
    try {
      await refreshWorkspaceForCurrentEditor(workspaceBackend);
    } catch (error) {
      setErrorMessage(errorToMessage(error));
      setRetryLoadPath(null);
    } finally {
      setBusy(false);
    }
  }, [refreshWorkspaceForCurrentEditor, saveCurrentFile, workspaceBackend]);

  useEffect(() => {
    if (!dropboxRedirectPendingRef.current) return;

    let canceled = false;
    setBusy(true);
    setDropboxConnecting(true);
    setErrorMessage("");

    void (async () => {
      try {
        let token = await completeDropboxRedirectOAuthIfPresent();
        if (canceled || !token) return;

        let draft = takeDropboxRedirectDraft();
        let restoreDraft = draft?.appKey == token.appKey ? draft : null;
        dropboxTokenRef.current = {
          accessToken: token.accessToken,
          expiresAt: token.expiresAt,
        };
        dropboxTokenAppKeyRef.current = token.appKey;

        await openDropboxWorkspace(
          {
            appKey: token.appKey,
            root: restoreDraft?.root,
          },
          {
            restoreDraft,
            skipSaveCurrent: true,
          },
        );
      } catch (error) {
        if (!canceled) {
          setErrorMessage(errorToMessage(error));
          setRetryLoadPath(null);
        }
      } finally {
        dropboxRedirectPendingRef.current = false;
        if (!canceled) {
          setDropboxAutoRestoreChecked(true);
          setDropboxConnecting(false);
          setBusy(false);
        }
      }
    })();

    return () => {
      canceled = true;
    };
  }, [openDropboxWorkspace]);

  useEffect(() => {
    if (dropboxRedirectPendingRef.current) {
      setLocalRestoreChecked(true);
      return;
    }
    if (!browserSupported) {
      setLocalRestoreChecked(true);
      return;
    }
    if (workspaceBackend) {
      setLocalRestoreChecked(true);
      return;
    }
    if (storedWorkspaceKind == "dropbox" && storedDropboxConfig) {
      setLocalRestoreChecked(true);
      return;
    }

    let canceled = false;
    setRestoreChecking(true);

    void (async () => {
      try {
        let record = await loadStoredLocalWorkspaceRecord();
        if (canceled || !record) return;

        setStoredLocalWorkspace(record);

        if ((await queryReadWritePermission(record.handle)) != "granted") {
          return;
        }
        if (canceled) return;

        let backend = createLocalWorkspaceBackend(record.handle, record.id);
        dropboxTokenRef.current = null;
        dropboxTokenAppKeyRef.current = "";
        setWorkspaceBackend(backend);
        setSidebarOpen(defaultSidebarOpen());
        await loadTree(backend, loadWorkspaceSelectedPath(backend), { saveBeforeSelect: false });
      } catch (error) {
        if (!canceled) setErrorMessage(errorToMessage(error));
      } finally {
        if (!canceled) {
          setRestoreChecking(false);
          setLocalRestoreChecked(true);
        }
      }
    })();

    return () => {
      canceled = true;
    };
  }, [browserSupported, loadTree, storedDropboxConfig, storedWorkspaceKind, workspaceBackend]);

  useEffect(() => {
    if (!localRestoreChecked || dropboxRedirectPendingRef.current) {
      return;
    }
    if (dropboxAutoRestoreAttemptedRef.current) return;
    if (
      workspaceBackend ||
      !storedDropboxConfig ||
      (storedWorkspaceKind && storedWorkspaceKind != "dropbox") ||
      (!storedWorkspaceKind && storedLocalWorkspace)
    ) {
      setDropboxAutoRestoreChecked(true);
      return;
    }

    dropboxAutoRestoreAttemptedRef.current = true;
    setDropboxAutoRestoreChecked(false);
    void (async () => {
      try {
        await openDropboxWorkspace(storedDropboxConfig, { skipSaveCurrent: true });
      } finally {
        setDropboxAutoRestoreChecked(true);
      }
    })();
  }, [
    localRestoreChecked,
    openDropboxWorkspace,
    storedDropboxConfig,
    storedLocalWorkspace,
    storedWorkspaceKind,
    workspaceBackend,
  ]);

  useEffect(() => {
    if (
      !localRestoreChecked ||
      !dropboxAutoRestoreChecked ||
      dropboxRedirectPendingRef.current ||
      workspaceBackend ||
      selectedFile
    ) {
      return;
    }

    void openSingleFileDraft({
      reuseLast: true,
      saveCurrent: false,
      shouldContinue: () => !selectedFileRef.current,
    });
  }, [
    dropboxAutoRestoreChecked,
    localRestoreChecked,
    openSingleFileDraft,
    selectedFile,
    workspaceBackend,
  ]);

  useEffect(
    () => () => {
      if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );

  let selectFile = useCallback(
    (file: MarkdownFileNode) => {
      if (!workspaceBackend) return;
      void loadFile(workspaceBackend, file);
      if (isMobileSidebarViewport()) setSidebarOpen(false);
    },
    [loadFile, workspaceBackend],
  );

  let toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => !open);
  }, []);

  let {
    closeDeleteDialog,
    closeFileDialog,
    deleteTarget,
    deleteWorkspaceEntry,
    fileDialogError,
    fileDialogMode,
    fileDialogValue,
    openCreateDialog,
    openRenameDialog,
    requestDeleteEntry,
    setFileDialogValue,
    submitFileDialog,
  } = useWorkspaceEntryDialogs({
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
  });

  let connectDropbox = () => {
    let appKey = defaultDropboxAppKey();
    if (!appKey) {
      setErrorMessage(
        "Dropbox workspace is not configured. Set VITE_DROPBOX_APP_KEY for this app.",
      );
      setRetryLoadPath(null);
      return;
    }

    void openDropboxWorkspace({
      appKey,
      root: storedDropboxConfig?.root ?? defaultDropboxRoot(),
    });
  };

  let retryUnavailableCollabFile = useCallback(async () => {
    let backend = workspaceBackend;
    let retryPath = retryLoadPath;
    if (!backend || !retryPath) return;

    let file = files.find((item) => item.path == retryPath);
    if (!file) {
      await refreshWorkspace();
      return;
    }

    await loadFile(backend, file, { saveCurrent: false });
  }, [files, loadFile, refreshWorkspace, retryLoadPath, workspaceBackend]);

  let ensureSelectedCollabDocument = useCallback(
    async (backend: WorkspaceBackend, file: MarkdownFileNode) => {
      let current = collabDocumentRef.current;
      if (current?.path == file.path && selectedFileBackendRef.current === backend) return current;

      let document = await openMarkdownCollabDocument(backend, file.path);

      collabSyncCleanupRef.current();
      collabDocumentRef.current?.dispose();
      invalidateActiveDocumentSave();
      collabDocumentRef.current = document;
      collabSyncCleanupRef.current = createCollabDocumentBroadcastSync({
        backend,
        doc: document.doc,
        docId: document.docId,
        onRemoteUpdate: () => {
          if (collabDocumentRef.current !== document) return;
          void (async () => {
            try {
              editorValueRef.current = getCollabDocumentValue(document);
              editVersionRef.current += 1;
              dirtyRef.current = true;
              setSaveStateSynced("pending");
              await saveCollabDocumentSnapshot(backend, document);
              scheduleAutoSave();
            } catch (error) {
              setSaveStateSynced("error");
              setErrorMessage(errorToMessage(error));
            }
          })();
        },
      });

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
    [invalidateActiveDocumentSave, scheduleAutoSave, setSaveStateSynced],
  );

  let { createSharedFileLink, rotateSharedFileLink, stopSharingFile } = useWorkspaceShareActions({
    activeShareRecord,
    collabDocumentRef,
    ensureSelectedCollabDocument,
    saveCurrentFile,
    selectedFileRef,
    setActiveShareRecord,
    setCreatedShare,
    setShareCopied,
    setShareCreating,
    setShareError,
    shareExpiration,
    startOwnerShareHost,
    stopOwnerShareHost,
    workspaceBackendRef,
  });

  let handleEditorReady = useCallback((editor: LiveMdEditorElement | null) => {
    editorElementRef.current = editor;
  }, []);

  let {
    closeSaveAsDropboxDialog,
    downloadCurrentMarkdownCopy,
    exportCurrentFileAsHtml,
    openSaveAsDropboxDialog,
    printCurrentFileAsPdf,
    saveAsDropboxDialogOpen,
    saveAsDropboxError,
    saveAsDropboxPath,
    saveSingleFileAsLocal,
    setSaveAsDropboxPath,
    submitSaveAsDropbox,
  } = useWorkspaceFileActions({
    activateSingleFileDocument,
    collabDocumentRef,
    createDropboxBackend,
    discardMaterializedDraft,
    editorElementRef,
    editorValueRef,
    loadTree,
    localFileHandleRef,
    refreshWorkspaceForCurrentEditor,
    resolveImageAssetFile,
    saveCurrentFile,
    selectedFileRef,
    setBusy,
    setDropboxConnecting,
    setErrorMessage,
    setRetryLoadPath,
    setWorkspaceBackend,
    singleFileSourceRef,
    storedDropboxConfig,
    t,
    workspaceBackendRef,
  });

  let saveLabel = useMemo(
    () => saveStateLabel(saveState, selectedFile, singleFileSource, t),
    [saveState, selectedFile, singleFileSource, t],
  );
  let languageToggleLabel =
    locale == "en" ? t("actions.switchToChinese") : t("actions.switchToEnglish");
  let restoreAvailable = Boolean(storedLocalWorkspace);
  let dropboxRestoreAvailable = Boolean(storedDropboxConfig);

  return (
    <TooltipProvider>
      <div className="flex h-svh min-h-0 overflow-hidden bg-background text-foreground">
        <WorkspaceSidebar
          browserSupported={browserSupported}
          busy={busy}
          dropboxConnecting={dropboxConnecting}
          dropboxRestoreAvailable={dropboxRestoreAvailable}
          files={files}
          open={sidebarOpen}
          restoreAvailable={restoreAvailable}
          restoreChecking={restoreChecking}
          rootName={rootName}
          selectedPath={selectedPath}
          tree={tree}
          workspaceOpen={Boolean(workspaceBackend)}
          onCreateEntry={openCreateDialog}
          onDeleteEntry={requestDeleteEntry}
          onOpenDropbox={connectDropbox}
          onOpenFolder={() => void openWorkspace()}
          onRenameEntry={openRenameDialog}
          onRestoreDropbox={() => void restoreDropboxWorkspace()}
          onRestoreFolder={() => void restoreStoredWorkspace()}
          onSelectEntry={setTreeSelection}
          onSelectFile={selectFile}
        />

        {sidebarOpen && (
          <button
            type="button"
            aria-label={t("actions.closeSidebar")}
            className="fixed inset-0 z-20 bg-background/70 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <input
            ref={imageInputRef}
            className="sr-only"
            type="file"
            accept="image/*"
            multiple
            onChange={handleImageInputChange}
          />
          <WorkspaceHeader
            activeShare={Boolean(activeShareForSelectedFile)}
            busy={busy}
            canExport={Boolean(selectedFile)}
            canInsertImage={canInsertImage}
            canRefresh={canRefreshWorkspace}
            canSaveAs={Boolean(selectedFile)}
            canSaveToDevice={supportsSaveFilePicker()}
            canShare={canShareFile}
            dropboxConnecting={dropboxConnecting}
            languageToggleLabel={languageToggleLabel}
            saveLabel={saveLabel}
            saveState={saveState}
            sidebarOpen={sidebarOpen}
            subtitle={headerSubtitle}
            title={headerTitle}
            onDownloadCopy={downloadCurrentMarkdownCopy}
            onExportHtml={() => void exportCurrentFileAsHtml()}
            onInsertImage={() => imageInputRef.current?.click()}
            onPrintPdf={() => void printCurrentFileAsPdf()}
            onRefresh={() => void refreshWorkspace()}
            onSaveAsDropbox={openSaveAsDropboxDialog}
            onSaveAsLocal={() => void saveSingleFileAsLocal()}
            onShareFile={openShareDialog}
            onToggleLanguage={toggleLocale}
            onToggleSidebar={toggleSidebar}
          />

          <WorkspaceErrorBanner
            busy={busy}
            message={errorMessage}
            retryPath={retryLoadPath}
            onRetry={() => void retryUnavailableCollabFile()}
          />

          <WorkspaceEditorPane
            document={editorDocument}
            extensions={collabDocument?.extensions ?? emptyEditorExtensions}
            imageSource={resolveImageSource}
            placeholder={t("workspace.placeholder")}
            selected={Boolean(selectedFile) && fileDialogMode == null}
            onEditorReady={handleEditorReady}
            onImageFiles={handleEditorImageFiles}
            onInput={handleEditorInput}
          />
        </main>

        <WorkspaceDialogs
          fileNameDialog={{
            busy,
            error: fileDialogError,
            mode: fileDialogMode,
            value: fileDialogValue,
            onOpenChange: closeFileDialog,
            onSubmit: submitFileDialog,
            onValueChange: setFileDialogValue,
          }}
          shareDialog={{
            activeShare: activeShareForSelectedFile,
            busy: busy || shareCreating,
            copied: shareCopied,
            error: shareError,
            expiration: shareExpiration,
            file: selectedFile,
            link: createdShare?.link ?? "",
            open: shareDialogOpen,
            shared: Boolean(activeShareForSelectedFile),
            onCopyLink: copySharedFileLink,
            onCreateLink: createSharedFileLink,
            onExpirationChange: setShareExpiration,
            onOpenChange: closeShareDialog,
            onRotateLink: rotateSharedFileLink,
            onStopSharing: stopSharingFile,
          }}
          saveAsDropboxDialog={{
            busy: busy || dropboxConnecting,
            error: saveAsDropboxError,
            open: saveAsDropboxDialogOpen,
            value: saveAsDropboxPath,
            onOpenChange: closeSaveAsDropboxDialog,
            onSubmit: submitSaveAsDropbox,
            onValueChange: setSaveAsDropboxPath,
          }}
          commandPalette={{
            browserSupported,
            busy,
            canInsertImage,
            canSaveAs: Boolean(selectedFile),
            canSaveAsLocal: supportsSaveFilePicker(),
            disabled:
              fileDialogMode != null ||
              shareDialogOpen ||
              saveAsDropboxDialogOpen ||
              deleteTarget != null,
            dropboxConnecting,
            files,
            selectedPath,
            sidebarOpen,
            onConnectDropbox: connectDropbox,
            onDownloadCopy: downloadCurrentMarkdownCopy,
            onInsertImage: () => imageInputRef.current?.click(),
            onNewDraft: () => void openSingleFileDraft(),
            onOpenFolder: () => void openWorkspace(),
            onSaveAsDropbox: openSaveAsDropboxDialog,
            onSaveAsLocal: () => void saveSingleFileAsLocal(),
            onSelectFile: selectFile,
            onToggleSidebar: toggleSidebar,
          }}
          deleteDialog={{
            busy,
            target: deleteTarget,
            onConfirm: () => void deleteWorkspaceEntry(),
            onOpenChange: closeDeleteDialog,
          }}
        />
      </div>
    </TooltipProvider>
  );
}
