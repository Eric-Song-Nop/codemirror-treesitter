import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveMdConfig, LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import { useStore } from "zustand";
import { useWorkspaceApplication } from "@/app/WorkspaceApplicationProvider";
import { createWorkspaceAppSetters } from "@/app/workspace-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceDialogs } from "@/components/workspace/WorkspaceDialogs";
import type { DocumentRecoveryAction } from "@/components/workspace/DocumentRecoveryDialogs";
import { WorkspaceEditorPane } from "@/components/workspace/WorkspaceEditorPane";
import { WorkspaceErrorBanner } from "@/components/workspace/WorkspaceErrorBanner";
import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { WorkspaceSettingsDialog } from "@/components/workspace/WorkspaceSettingsDialog";
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
import type { WorkspaceCollaborativeDocument } from "@/lib/workspace/documents";
import { isMobileBrowser } from "@/lib/platform/browser-support";
import {
  supportsDirectoryPicker,
  supportsSaveFilePicker,
  type AccessDirectoryHandle,
  type AccessFileHandle,
} from "@/lib/workspace/file-system";
import { findMarkdownFile, type MarkdownFileNode } from "@/lib/workspace/tree";
import { useI18n } from "@/lib/i18n";
import { useLiveMdPreload } from "@/lib/editor/live-md-preload";
import { isMobileSidebarViewport } from "@/lib/workspace/constants";
import { defaultDropboxAppKey, defaultDropboxRoot } from "@/lib/workspace/providers/dropbox/config";
import { errorToMessage } from "@/lib/workspace/errors";
import { createEphemeralLocalWorkspaceRecord, saveStateLabel } from "@/lib/workspace/state";
import type {
  SelectedFileSource,
  SaveState,
  SingleFileSource,
  SourceAutoSaveTask,
} from "@/lib/workspace/types";
import { rememberStoredLocalWorkspace, saveStoredWorkspaceKind } from "@/lib/workspace/store";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";
import { transitionWorkspaceRuntime } from "@/lib/workspace/runtime/runtime-lifecycle";

const emptyLiveMdConfig: LiveMdConfig = {};
const emptyLiveMdPlugins: NonNullable<LiveMdConfig["plugins"]> = [];
const WorkspaceAgentFeature = lazy(async () => {
  let module = await import("@/features/workspace-agent/WorkspaceAgentFeature");
  return { default: module.WorkspaceAgentFeature };
});

export function LocalWorkspaceApp() {
  let { t } = useI18n();
  let {
    error: liveMdPreloadError,
    retry: retryLiveMdPreload,
    retrying: liveMdPreloadRetrying,
  } = useLiveMdPreload();
  let {
    documentViews,
    runtime: workspaceEffectRuntime,
    store: workspaceAppStore,
  } = useWorkspaceApplication();
  let {
    agentActivated,
    agentOpen,
    busy,
    collabDocument,
    dropboxConnecting,
    editorDocument,
    errorMessage,
    openingDocument,
    recoveryCopyPath,
    recoveryDialogAction,
    recoveryDialogError,
    restoreChecking,
    retryLoadPath,
    saveState,
    selectedFile,
    sidebarOpen,
    singleFileSource,
    storedDropboxConfig,
    storedLocalWorkspace,
    storedWorkspaceKind,
    tree,
    treeSelection,
    workspaceRuntime,
  } = useStore(workspaceAppStore);
  let {
    setAgentActivated,
    setAgentOpen,
    setBusy,
    setDropboxConnecting,
    setEditorDocument,
    setErrorMessage,
    setRecoveryCopyPath,
    setRecoveryDialogAction,
    setRecoveryDialogError,
    setRestoreChecking,
    setRetryLoadPath,
    setSaveState,
    setSidebarOpen,
    setStoredDropboxConfig,
    setStoredLocalWorkspace,
    setStoredWorkspaceKind,
    setTree,
    setTreeSelection,
    setWorkspaceRuntime,
  } = useMemo(() => createWorkspaceAppSetters(workspaceAppStore), [workspaceAppStore]);

  let editorElementRef = useRef<LiveMdEditorElement | null>(null);
  let agentButtonRef = useRef<HTMLButtonElement | null>(null);
  let workspaceRuntimeRef = useRef<WorkspaceRuntime | null>(null);
  let selectedFileSourceRef = useRef<SelectedFileSource | null>(null);
  let selectedFileRef = useRef<MarkdownFileNode | null>(null);
  let singleFileSourceRef = useRef<SingleFileSource | null>(null);
  let localFileHandleRef = useRef<AccessFileHandle | null>(null);
  let collabDocumentRef = useRef<WorkspaceCollaborativeDocument | null>(null);
  let editorValueRef = useRef("");
  let cleanValueRef = useRef("");
  let dirtyRef = useRef(false);
  let saveStateRef = useRef<SaveState>("idle");
  let autoSaveTaskRef = useRef<SourceAutoSaveTask | null>(null);
  let scheduleAutoSaveRef = useRef<() => void>(() => {});
  let saveOperationRef = useRef(0);
  let imageUploadAbortRef = useRef<AbortController | null>(null);
  let [settingsOpen, setSettingsOpen] = useState(false);
  let agentWorkspaceKey = singleFileSource ? "" : (workspaceRuntime?.identity.id ?? "");
  let effectiveBusy = busy || openingDocument != null;
  let agentScopeKey = agentWorkspaceKey;
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

  useEffect(
    () => () => {
      void workspaceRuntimeRef.current?.dispose();
      workspaceRuntimeRef.current = null;
    },
    [],
  );

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
    editorDocument,
    editorElementRef,
    imageUploadAbortRef,
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

  let cancelImageUpload = useCallback(() => {
    imageUploadAbortRef.current?.abort();
    imageUploadAbortRef.current = null;
  }, []);

  let finishDocumentViewChange = useCallback(
    (signal: AbortSignal) => documentViews.finish(signal),
    [documentViews],
  );

  let { flushOwnerShareHost, startOwnerShareHost, stopOwnerShareHost } = useOwnerShareHost({
    setActiveShareRecord,
    setShareError,
  });

  let {
    activateSingleFileDocument,
    beginDocumentViewChange,
    clearDocumentView,
    discardMaterializedDraft,
    ensureSelectedCollabDocument,
    handleEditorInput,
    keepCurrentDocumentAs,
    loadFile,
    openSingleFileDraft,
    recreateCurrentDocumentSource,
    restoreCloudRedirectEditorDraft,
    resolveCurrentDocumentUseExternal,
    saveCurrentFile,
  } = useWorkspaceDocumentActions({
    autoSaveTaskRef,
    cancelImageUpload,
    cleanValueRef,
    collabDocumentRef,
    documentViews,
    dirtyRef,
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
  });

  useWorkspacePersistenceLifecycle({
    autoSaveTaskRef,
    clearDocumentView,
    collabDocumentRef,
    dirtyRef,
    setErrorMessage,
  });

  let replaceWorkspaceRuntime = useCallback(
    (nextRuntime: WorkspaceRuntime) =>
      workspaceEffectRuntime.runPromise(
        transitionWorkspaceRuntime({
          activate: (runtime) => {
            workspaceRuntimeRef.current = runtime;
            setWorkspaceRuntime(runtime);
          },
          clearDocumentView,
          current: () => workspaceRuntimeRef.current,
          next: nextRuntime,
        }),
      ),
    [clearDocumentView, setWorkspaceRuntime, workspaceEffectRuntime],
  );

  let { loadDirectory, loadTree, refreshWorkspaceForCurrentEditor } = useWorkspaceTree({
    cancelImageUpload,
    clearDocumentView,
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
      if (recoveryDialogAction == "use-external") {
        await resolveCurrentDocumentUseExternal(workspaceRuntime, selectedFile, collabDocument);
      } else if (recoveryDialogAction == "recreate") {
        await recreateCurrentDocumentSource(workspaceRuntime, selectedFile, collabDocument);
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
    collabDocument?.collabState.source.kind == "missing" ||
    collabDocument?.collabState.source.kind == "recovery-required"
      ? collabDocument.collabState.source.kind
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
    cancelImageUpload,
    clearDropboxAccessToken,
    createDropboxRuntime,
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
    setAgentActivated(true);
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
    beginDocumentViewChange,
    cancelImageUpload,
    clearDocumentView,
    collabDocumentRef,
    finishDocumentViewChange,
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
    beginDocumentViewChange,
    cancelImageUpload,
    collabDocumentRef,
    createDropboxRuntime,
    discardMaterializedDraft,
    documentViews,
    editorElementRef,
    editorValueRef,
    loadTree,
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
  let restoreAvailable = Boolean(storedLocalWorkspace);
  let dropboxRestoreAvailable = Boolean(storedDropboxConfig);
  let openSettings = useCallback(() => setSettingsOpen(true), []);

  return (
    <TooltipProvider>
      <div className="flex h-svh min-h-0 overflow-hidden bg-background text-foreground">
        <WorkspaceSidebar
          browserSupported={browserSupported}
          busy={effectiveBusy}
          canRefresh={canRefreshWorkspace}
          dropboxConnecting={dropboxConnecting}
          dropboxRestoreAvailable={dropboxRestoreAvailable}
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
          onOpenSettings={openSettings}
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
            busy={effectiveBusy}
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
            busy={effectiveBusy || liveMdPreloadRetrying}
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
              openingDocument
                ? t("workspace.loadingFile", { path: openingDocument.path })
                : undefined
            }
            placeholder={t("workspace.placeholder")}
            selected={Boolean(selectedFile) && openingDocument == null && fileDialogMode == null}
            onEditorReady={handleEditorReady}
            onInput={handleEditorInput}
          />
        </main>

        {agentActivated ? (
          <Suspense fallback={null}>
            <WorkspaceAgentFeature
              open={agentOpen}
              scopeKey={agentScopeKey}
              singleFileSourceRef={singleFileSourceRef}
              workspaceAvailable={Boolean(workspaceRuntime && !singleFileSource)}
              workspaceKey={agentWorkspaceKey}
              workspaceRuntimeRef={workspaceRuntimeRef}
              onClose={closeAgent}
              onOpenSettings={openSettings}
            />
          </Suspense>
        ) : null}

        <WorkspaceSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

        <WorkspaceDialogs
          fileNameDialog={{
            busy: effectiveBusy,
            error: fileDialogError,
            mode: fileDialogMode,
            value: fileDialogValue,
            onOpenChange: closeFileDialog,
            onSubmit: submitFileDialog,
            onValueChange: setFileDialogValue,
          }}
          recoveryDialog={{
            action: recoveryDialogAction,
            busy: effectiveBusy,
            copyPath: recoveryCopyPath,
            error: recoveryDialogError,
            onClose: closeDocumentRecovery,
            onConfirm: confirmDocumentRecovery,
            onCopyPathChange: setRecoveryCopyPath,
            onKeepLocalAs: submitRecoveryCopy,
          }}
          shareDialog={{
            activeShare: activeShareForSelectedFile,
            busy: effectiveBusy || shareCreating,
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
            busy: effectiveBusy || dropboxConnecting,
            error: saveAsDropboxError,
            open: saveAsDropboxDialogOpen,
            value: saveAsDropboxPath,
            onOpenChange: closeSaveAsDropboxDialog,
            onSubmit: submitSaveAsDropbox,
            onValueChange: setSaveAsDropboxPath,
          }}
          commandPalette={{
            browserSupported,
            busy: effectiveBusy,
            canInsertImage,
            canSaveAs: Boolean(selectedFile),
            canSaveAsLocal: supportsSaveFilePicker(),
            disabled:
              fileDialogMode != null ||
              shareDialogOpen ||
              saveAsDropboxDialogOpen ||
              settingsOpen ||
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
            busy: effectiveBusy,
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
