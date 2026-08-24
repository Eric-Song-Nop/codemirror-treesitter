import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveMdConfig, LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileTreeDeleteTarget } from "@/components/FileTree";
import { WorkspaceDialogs } from "@/components/workspace/WorkspaceDialogs";
import { WorkspaceAgentFeature } from "@/components/workspace/WorkspaceAgentFeature";
import type { DocumentRecoveryAction } from "@/components/workspace/DocumentRecoveryDialogs";
import { WorkspaceEditorPane } from "@/components/workspace/WorkspaceEditorPane";
import { WorkspaceErrorBanner } from "@/components/workspace/WorkspaceErrorBanner";
import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { WorkspaceSidebar } from "@/components/workspace/WorkspaceSidebar";
import { useDropboxWorkspaceRuntime } from "@/hooks/workspace/useDropboxWorkspaceRuntime";
import { useOwnerShareHost } from "@/hooks/workspace/useOwnerShareHost";
import { useWorkspaceDocumentActions } from "@/hooks/workspace/useWorkspaceDocumentActions";
import { useWorkspaceEntryDialogs } from "@/hooks/workspace/useWorkspaceEntryDialogs";
import { useWorkspaceFileActions } from "@/hooks/workspace/useWorkspaceFileActions";
import { useWorkspaceImageAssets } from "@/hooks/workspace/useWorkspaceImageAssets";
import { useWorkspaceOpeners } from "@/hooks/workspace/useWorkspaceOpeners";
import { useWorkspacePersistenceLifecycle } from "@/hooks/workspace/useWorkspacePersistenceLifecycle";
import { useWorkspaceShareActions } from "@/hooks/workspace/useWorkspaceShareActions";
import { useWorkspaceShareState } from "@/hooks/workspace/useWorkspaceShareState";
import { useWorkspaceStartup } from "@/hooks/workspace/useWorkspaceStartup";
import { useWorkspaceTree } from "@/hooks/workspace/useWorkspaceTree";
import { completeDropboxPopupOAuthIfPresent } from "@/lib/workspace/providers/dropbox/oauth";
import {
  flushCollabDocumentPersistence,
  type CollabDocumentState,
} from "@/lib/collaboration/markdown-document";
import { isMobileBrowser } from "@/lib/platform/browser-support";
import {
  supportsDirectoryPicker,
  supportsSaveFilePicker,
  type AccessDirectoryHandle,
  type AccessFileHandle,
} from "@/lib/workspace/file-system";
import {
  findMarkdownFile,
  type MarkdownDirectoryNode,
  type MarkdownFileNode,
} from "@/lib/workspace/tree";
import { useI18n } from "@/lib/i18n";
import { useLiveMdPreload } from "@/lib/editor/live-md-preload";
import { defaultSidebarOpen, isMobileSidebarViewport } from "@/lib/workspace/constants";
import { defaultDropboxAppKey, defaultDropboxRoot } from "@/lib/workspace/providers/dropbox/config";
import { errorToMessage } from "@/lib/workspace/errors";
import { createEphemeralLocalWorkspaceRecord, saveStateLabel } from "@/lib/workspace/state";
import type {
  EditorDocument,
  ActiveDocumentSource,
  SaveState,
  SingleFileSource,
  SourceAutoSaveTask,
} from "@/lib/workspace/types";
import {
  loadStoredDropboxWorkspaceConfig,
  loadStoredWorkspaceKind,
  rememberStoredLocalWorkspace,
  saveStoredWorkspaceKind,
  type StoredLocalWorkspaceRecord,
  type StoredDropboxWorkspaceConfig,
  type StoredWorkspaceKind,
} from "@/lib/workspace/store";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";
import {
  enqueueRuntimeTransition,
  transitionWorkspaceRuntime,
} from "@/lib/workspace/runtime/runtime-lifecycle";

const emptyLiveMdConfig: LiveMdConfig = {};
const emptyLiveMdPlugins: NonNullable<LiveMdConfig["plugins"]> = [];

export function LocalWorkspaceApp() {
  let { locale, t, toggleLocale } = useI18n();
  let {
    error: liveMdPreloadError,
    retry: retryLiveMdPreload,
    retrying: liveMdPreloadRetrying,
  } = useLiveMdPreload();
  let [workspaceRuntime, setWorkspaceRuntime] = useState<WorkspaceRuntime | null>(null);
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
  let [recoveryDialogAction, setRecoveryDialogAction] = useState<DocumentRecoveryAction | null>(
    null,
  );
  let [recoveryCopyPath, setRecoveryCopyPath] = useState("");
  let [recoveryDialogError, setRecoveryDialogError] = useState("");
  let [sidebarOpen, setSidebarOpen] = useState(() => defaultSidebarOpen());
  let [agentOpen, setAgentOpen] = useState(false);

  let editorElementRef = useRef<LiveMdEditorElement | null>(null);
  let agentButtonRef = useRef<HTMLButtonElement | null>(null);
  let workspaceRuntimeRef = useRef<WorkspaceRuntime | null>(null);
  let workspaceRuntimeTransitionRef = useRef<Promise<void>>(Promise.resolve());
  let selectedFileSourceRef = useRef<ActiveDocumentSource | null>(null);
  let selectedFileRef = useRef<MarkdownFileNode | null>(null);
  let singleFileSourceRef = useRef<SingleFileSource | null>(null);
  let localFileHandleRef = useRef<AccessFileHandle | null>(null);
  let collabDocumentRef = useRef<CollabDocumentState | null>(null);
  let collabSyncCleanupRef = useRef<() => void>(() => {});
  let editorValueRef = useRef("");
  let cleanValueRef = useRef("");
  let dirtyRef = useRef(false);
  let editVersionRef = useRef(0);
  let saveStateRef = useRef<SaveState>("idle");
  let autoSaveTaskRef = useRef<SourceAutoSaveTask | null>(null);
  let scheduleAutoSaveRef = useRef<() => void>(() => {});
  let saveOperationRef = useRef(0);
  let activeDocumentGenerationRef = useRef(0);
  let documentTargetGenerationRef = useRef(0);
  let loadFileRequestRef = useRef(0);
  let agentWorkspaceKey = singleFileSource ? "" : (workspaceRuntime?.identity.id ?? "");
  let agentScopeKey = [
    agentWorkspaceKey,
    selectedFile?.path ?? "",
    collabDocument?.docId ?? "",
    singleFileSource?.kind ?? "",
    activeDocumentGenerationRef.current,
    documentTargetGenerationRef.current,
  ].join("\u0000");
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
    workspaceRuntime,
  });

  useEffect(() => {
    workspaceRuntimeRef.current = workspaceRuntime;
  }, [workspaceRuntime]);

  useEffect(
    () => () => {
      void workspaceRuntimeRef.current?.dispose();
      workspaceRuntimeRef.current = null;
    },
    [],
  );

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  useEffect(() => {
    singleFileSourceRef.current = singleFileSource;
  }, [singleFileSource]);

  useEffect(() => {
    collabDocumentRef.current = collabDocument;
  }, [collabDocument]);

  useWorkspacePersistenceLifecycle({
    autoSaveTaskRef,
    collabDocumentRef,
    collabSyncCleanupRef,
    dirtyRef,
    flushCollabDocument: flushCollabDocumentPersistence,
    setErrorMessage,
  });

  useEffect(() => {
    completeDropboxPopupOAuthIfPresent();
  }, []);

  let selectedPath = singleFileSource ? null : (selectedFile?.path ?? null);
  let rootName =
    tree?.name ?? workspaceRuntime?.identity.name ?? storedLocalWorkspace?.name ?? "Grove";
  let selectedPathLabel = selectedFile
    ? selectedFile.path == selectedFile.name
      ? ""
      : selectedFile.path
    : "";
  let headerTitle = singleFileSource?.name ?? selectedFile?.name ?? rootName;
  let headerSubtitle = singleFileSource ? "" : selectedFile ? selectedPathLabel : "";
  let browserSupported = supportsDirectoryPicker();
  let canShareFile = Boolean(!singleFileSource && workspaceRuntime && selectedFile);
  let canRefreshWorkspace = Boolean(workspaceRuntime);
  let folderAccessUnavailableMessage = browserSupported
    ? ""
    : isMobileBrowser()
      ? t("errors.fileSystemAccessUnavailableMobile")
      : t("errors.fileSystemAccessUnavailableDesktop");
  let visibleErrorMessage = errorMessage || liveMdPreloadError;
  let {
    canInsertImage,
    handleImageInputChange,
    imagePlugin,
    imageInputRef,
    resolveImageAssetFile,
  } = useWorkspaceImageAssets({
    documentTargetGenerationRef,
    editorDocument,
    editorElementRef,
    selectedFile,
    selectedFileSourceRef,
    selectedFileRef,
    setBusy,
    setErrorMessage,
    singleFileSource,
    singleFileSourceRef,
    workspaceRuntime,
    workspaceRuntimeRef,
  });
  let collabLiveMdConfig = collabDocument?.liveMdConfig;
  let markdownConfig = collabLiveMdConfig?.markdown ?? null;
  let liveMdConfig = useMemo<LiveMdConfig>(
    () => ({
      markdown: collabLiveMdConfig?.markdown,
      plugins: [imagePlugin, ...(collabLiveMdConfig?.plugins ?? emptyLiveMdPlugins)],
    }),
    [collabLiveMdConfig?.markdown, collabLiveMdConfig?.plugins, imagePlugin],
  );
  let { clearDropboxAccessToken, createDropboxRuntime, setDropboxRedirectAccessToken } =
    useDropboxWorkspaceRuntime({
      dirtyRef,
      editorValueRef,
      selectedFileRef,
      setStoredDropboxConfig,
      setStoredWorkspaceKind,
      t,
      workspaceRuntimeRef,
    });

  let setSaveStateSynced = useCallback((nextState: SaveState) => {
    if (saveStateRef.current == nextState) return;
    saveStateRef.current = nextState;
    setSaveState(nextState);
  }, []);

  let {
    flushOwnerShareHost,
    isOwnerShareHostPath,
    sendHostDocumentUpdate,
    sendHostSaveAck,
    startOwnerShareHost,
    stopOwnerShareHost,
  } = useOwnerShareHost({
    dirtyRef,
    editorValueRef,
    editVersionRef,
    scheduleAutoSaveRef,
    setActiveShareRecord,
    setSaveStateSynced,
    setShareError,
  });

  let {
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
  } = useWorkspaceDocumentActions({
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
  });

  let replaceWorkspaceRuntime = useCallback(
    (nextRuntime: WorkspaceRuntime) =>
      enqueueRuntimeTransition(workspaceRuntimeTransitionRef, () =>
        transitionWorkspaceRuntime({
          activate: (runtime) => {
            workspaceRuntimeRef.current = runtime;
            setWorkspaceRuntime(runtime);
          },
          closeActiveDocument: clearActiveDocument,
          current: workspaceRuntimeRef.current,
          next: nextRuntime,
        }),
      ),
    [clearActiveDocument],
  );

  useEffect(() => {
    if (!workspaceRuntime || !selectedFile || !collabDocument || singleFileSource) return;
    let changes = workspaceRuntime.currentDocumentChanges;
    if (!changes) return;
    let documentGeneration = activeDocumentGenerationRef.current;
    let subscription = changes.subscribe(selectedFile.path, () => {
      void reconcileCurrentDocumentSource(
        workspaceRuntime,
        selectedFile,
        collabDocument,
        documentGeneration,
      );
    });
    return () => subscription.dispose();
  }, [
    collabDocument,
    reconcileCurrentDocumentSource,
    selectedFile,
    singleFileSource,
    workspaceRuntime,
  ]);

  let { loadDirectory, loadTree, refreshWorkspaceForCurrentEditor } = useWorkspaceTree({
    clearActiveDocument,
    documentTargetGenerationRef,
    loadFile,
    localFileHandleRef,
    selectedFileSourceRef,
    selectedFileRef,
    setTree,
    setTreeSelection,
    singleFileSourceRef,
  });

  let openDocumentRecovery = useCallback(
    (action: DocumentRecoveryAction) => {
      setRecoveryDialogError("");
      if (action == "keep-local-as" && selectedFile) {
        setRecoveryCopyPath(recoveredCopyPath(selectedFile.path));
      }
      setRecoveryDialogAction(action);
    },
    [selectedFile],
  );

  let closeDocumentRecovery = useCallback(() => {
    setRecoveryDialogAction(null);
    setRecoveryDialogError("");
  }, []);

  let submitRecoveryCopy = useCallback(
    async (path: string) => {
      if (!workspaceRuntime || !selectedFile || !collabDocument) return;
      setBusy(true);
      setRecoveryDialogError("");
      try {
        let targetPath = await keepCurrentDocumentAs(
          workspaceRuntime,
          selectedFile,
          collabDocument,
          path,
          activeDocumentGenerationRef.current,
        );
        setRecoveryDialogAction(null);
        await loadTree(workspaceRuntime, targetPath, { saveBeforeSelect: false });
      } catch (error) {
        setRecoveryDialogError(errorToMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [collabDocument, keepCurrentDocumentAs, loadTree, selectedFile, workspaceRuntime],
  );

  let confirmDocumentRecovery = useCallback(async () => {
    if (!workspaceRuntime || !selectedFile || !collabDocument || !recoveryDialogAction) return;
    setBusy(true);
    setRecoveryDialogError("");
    try {
      let generation = activeDocumentGenerationRef.current;
      if (recoveryDialogAction == "use-external") {
        await resolveCurrentDocumentUseExternal(
          workspaceRuntime,
          selectedFile,
          collabDocument,
          generation,
        );
      } else if (recoveryDialogAction == "recreate") {
        await recreateCurrentDocumentSource(
          workspaceRuntime,
          selectedFile,
          collabDocument,
          generation,
        );
      }
      setRecoveryDialogAction(null);
    } catch (error) {
      setRecoveryDialogError(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [
    collabDocument,
    recreateCurrentDocumentSource,
    recoveryDialogAction,
    resolveCurrentDocumentUseExternal,
    selectedFile,
    workspaceRuntime,
  ]);

  let recoveryKind =
    collabDocument?.source.kind == "missing" || collabDocument?.source.kind == "recovery-required"
      ? collabDocument.source.kind
      : undefined;

  useEffect(() => {
    if (!recoveryDialogAction) return;
    if (
      (recoveryDialogAction == "use-external" && recoveryKind != "recovery-required") ||
      (recoveryDialogAction == "recreate" && recoveryKind != "missing") ||
      !collabDocument
    ) {
      closeDocumentRecovery();
    }
  }, [closeDocumentRecovery, collabDocument, recoveryDialogAction, recoveryKind]);

  let loadTreeDirectory = useCallback(
    async (path: string) => {
      if (!workspaceRuntime) return;
      try {
        await loadDirectory(workspaceRuntime, path);
      } catch (error) {
        setErrorMessage(errorToMessage(error));
      }
    },
    [loadDirectory, setErrorMessage, workspaceRuntime],
  );

  let rememberWorkspaceHandle = useCallback(async (handle: AccessDirectoryHandle) => {
    let record = await rememberStoredLocalWorkspace(handle);
    let nextRecord = record ?? createEphemeralLocalWorkspaceRecord(handle);
    setStoredLocalWorkspace(nextRecord);
    setStoredWorkspaceKind("local");
    saveStoredWorkspaceKind("local");
    return nextRecord;
  }, []);

  let {
    openDropboxWorkspace,
    openWorkspace,
    refreshWorkspace,
    restoreDropboxWorkspace,
    restoreStoredWorkspace,
  } = useWorkspaceOpeners({
    clearDropboxAccessToken,
    createDropboxRuntime,
    documentTargetGenerationRef,
    folderAccessUnavailableMessage,
    loadTree,
    refreshWorkspaceForCurrentEditor,
    rememberWorkspaceHandle,
    restoreCloudRedirectEditorDraft,
    saveCurrentFile,
    setBusy,
    setDropboxConnecting,
    setErrorMessage,
    setRetryLoadPath,
    setSidebarOpen,
    replaceWorkspaceRuntime,
    storedDropboxConfig,
    storedLocalWorkspace,
    workspaceRuntime,
  });

  useWorkspaceStartup({
    browserSupported,
    clearDropboxAccessToken,
    loadTree,
    openDropboxWorkspace,
    openSingleFileDraft,
    selectedFile,
    selectedFileRef,
    setBusy,
    setDropboxConnecting,
    setDropboxRedirectAccessToken,
    setErrorMessage,
    setRestoreChecking,
    setRetryLoadPath,
    setSidebarOpen,
    setStoredLocalWorkspace,
    replaceWorkspaceRuntime,
    storedDropboxConfig,
    storedLocalWorkspace,
    storedWorkspaceKind,
    workspaceRuntime,
  });

  let selectFile = useCallback(
    (file: MarkdownFileNode) => {
      if (!workspaceRuntime) return;
      void loadFile(workspaceRuntime, file);
      if (isMobileSidebarViewport()) setSidebarOpen(false);
    },
    [loadFile, workspaceRuntime],
  );

  let toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => !open);
  }, []);

  let toggleAgent = useCallback(() => {
    setAgentOpen((open) => !open);
  }, []);

  let closeAgent = useCallback(() => {
    setAgentOpen(false);
    requestAnimationFrame(() => agentButtonRef.current?.focus());
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
    autoSaveTaskRef,
    beginDocumentTransition,
    clearActiveDocument,
    closeActiveDocumentSession,
    collabDocumentRef,
    documentTargetGenerationRef,
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
    let runtime = workspaceRuntime;
    let retryPath = retryLoadPath;
    if (!runtime || !retryPath) return;

    let file = findMarkdownFile(tree, retryPath);
    if (!file) {
      await refreshWorkspace();
      return;
    }

    await loadFile(runtime, file, { saveCurrent: false });
  }, [loadFile, refreshWorkspace, retryLoadPath, tree, workspaceRuntime]);

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
    flushOwnerShareHost,
    startOwnerShareHost,
    stopOwnerShareHost,
    workspaceRuntimeRef,
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
    createDropboxRuntime,
    discardMaterializedDraft,
    documentTargetGenerationRef,
    editorElementRef,
    editorValueRef,
    loadTree,
    localFileHandleRef,
    markdownConfig,
    refreshWorkspaceForCurrentEditor,
    resolveImageAssetFile,
    saveCurrentFile,
    selectedFileRef,
    setBusy,
    setDropboxConnecting,
    setErrorMessage,
    setRetryLoadPath,
    replaceWorkspaceRuntime,
    singleFileSourceRef,
    storedDropboxConfig,
    t,
    workspaceRuntimeRef,
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
          canRefresh={canRefreshWorkspace}
          dropboxConnecting={dropboxConnecting}
          dropboxRestoreAvailable={dropboxRestoreAvailable}
          languageToggleLabel={languageToggleLabel}
          open={sidebarOpen}
          restoreAvailable={restoreAvailable}
          restoreChecking={restoreChecking}
          rootName={rootName}
          selectedPath={selectedPath}
          tree={tree}
          workspaceOpen={Boolean(workspaceRuntime)}
          onCreateEntry={openCreateDialog}
          onDeleteEntry={requestDeleteEntry}
          onLoadDirectory={loadTreeDirectory}
          onOpenDropbox={connectDropbox}
          onOpenFolder={() => void openWorkspace()}
          onRefresh={() => void refreshWorkspace()}
          onRenameEntry={openRenameDialog}
          onRestoreDropbox={() => void restoreDropboxWorkspace()}
          onRestoreFolder={() => void restoreStoredWorkspace()}
          onSelectEntry={setTreeSelection}
          onSelectFile={selectFile}
          onToggleLanguage={toggleLocale}
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
            agentButtonRef={agentButtonRef}
            agentOpen={agentOpen}
            busy={busy}
            canExport={Boolean(selectedFile)}
            canInsertImage={canInsertImage}
            canSaveAs={Boolean(selectedFile)}
            canSaveToDevice={supportsSaveFilePicker()}
            canShare={canShareFile}
            dropboxConnecting={dropboxConnecting}
            saveLabel={saveLabel}
            saveState={saveState}
            sidebarOpen={sidebarOpen}
            subtitle={headerSubtitle}
            title={headerTitle}
            onDownloadCopy={downloadCurrentMarkdownCopy}
            onExportHtml={() => void exportCurrentFileAsHtml()}
            onInsertImage={() => imageInputRef.current?.click()}
            onPrintPdf={() => void printCurrentFileAsPdf()}
            onSaveAsDropbox={openSaveAsDropboxDialog}
            onSaveAsLocal={() => void saveSingleFileAsLocal()}
            onShareFile={openShareDialog}
            onToggleSidebar={toggleSidebar}
            onToggleAgent={toggleAgent}
          />

          <WorkspaceErrorBanner
            busy={busy || liveMdPreloadRetrying}
            message={visibleErrorMessage}
            recoveryKind={recoveryKind}
            retryPath={errorMessage ? retryLoadPath : liveMdPreloadError ? "live-md" : null}
            onRetry={() => {
              if (!errorMessage && liveMdPreloadError) {
                void retryLiveMdPreload();
              } else {
                void retryUnavailableCollabFile();
              }
            }}
            onKeepLocalAs={() => openDocumentRecovery("keep-local-as")}
            onRecreate={() => openDocumentRecovery("recreate")}
            onUseExternal={() => openDocumentRecovery("use-external")}
          />

          <WorkspaceEditorPane
            liveMdConfig={selectedFile ? liveMdConfig : emptyLiveMdConfig}
            document={editorDocument}
            loadingLabel={
              loadingFilePath ? t("workspace.loadingFile", { path: loadingFilePath }) : undefined
            }
            placeholder={t("workspace.placeholder")}
            selected={Boolean(selectedFile) && fileDialogMode == null}
            onEditorReady={handleEditorReady}
            onInput={handleEditorInput}
          />
        </main>

        <WorkspaceAgentFeature
          activeDocumentGenerationRef={activeDocumentGenerationRef}
          collabDocumentRef={collabDocumentRef}
          dirtyRef={dirtyRef}
          documentTargetGenerationRef={documentTargetGenerationRef}
          editorElementRef={editorElementRef}
          editVersionRef={editVersionRef}
          open={agentOpen}
          scopeKey={agentScopeKey}
          selectedFileRef={selectedFileRef}
          selectedFileSourceRef={selectedFileSourceRef}
          singleFileSourceRef={singleFileSourceRef}
          workspaceAvailable={Boolean(workspaceRuntime && !singleFileSource)}
          workspaceKey={agentWorkspaceKey}
          workspaceRuntimeRef={workspaceRuntimeRef}
          onClose={closeAgent}
        />

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
          recoveryDialog={{
            action: recoveryDialogAction,
            busy,
            copyPath: recoveryCopyPath,
            error: recoveryDialogError,
            onClose: closeDocumentRecovery,
            onConfirm: confirmDocumentRecovery,
            onCopyPathChange: setRecoveryCopyPath,
            onKeepLocalAs: submitRecoveryCopy,
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
              recoveryDialogAction != null ||
              deleteTarget != null,
            dropboxConnecting,
            selectedPath,
            sidebarOpen,
            tree,
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

function recoveredCopyPath(path: string) {
  let extensionIndex = path.toLowerCase().lastIndexOf(".md");
  let base = extensionIndex == path.length - 3 ? path.slice(0, -3) : path;
  return `${base}-recovered.md`;
}
