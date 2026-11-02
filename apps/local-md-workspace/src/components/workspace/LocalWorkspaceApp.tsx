import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import { useWorkspaceApplication } from "@/app/WorkspaceApplicationProvider";
import { createWorkspaceAppSetters } from "@/app/workspace-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DocumentRecoveryAction } from "@/components/workspace/DocumentRecoveryDialogs";
import {
  WorkspaceDialogsContainer,
  WorkspaceEditorPaneContainer,
  WorkspaceErrorBannerContainer,
  WorkspaceHeaderContainer,
  WorkspacePermissionBanner,
  WorkspaceSidebarContainer,
} from "@/components/workspace/WorkspaceChrome";
import { WorkspaceSettingsDialog } from "@/components/workspace/WorkspaceSettingsDialog";
import { useDropboxWorkspaceRuntime } from "@/hooks/workspace/useDropboxWorkspaceRuntime";
import { useOwnerShareHost } from "@/hooks/workspace/useOwnerShareHost";
import { useWorkspaceEditorSession } from "@/hooks/workspace/useWorkspaceEditorSession";
import { useWorkspaceEntryDialogs } from "@/hooks/workspace/useWorkspaceEntryDialogs";
import { useWorkspaceFileActions } from "@/hooks/workspace/useWorkspaceFileActions";
import { useWorkspaceImageAssets } from "@/hooks/workspace/useWorkspaceImageAssets";
import { useWorkspaceOpeners } from "@/hooks/workspace/useWorkspaceOpeners";
import { useWorkspacePersistenceLifecycle } from "@/hooks/workspace/useWorkspacePersistenceLifecycle";
import { useWorkspaceRootState } from "@/hooks/workspace/useWorkspaceRootState";
import { useWorkspaceShareActions } from "@/hooks/workspace/useWorkspaceShareActions";
import { useWorkspaceShareState } from "@/hooks/workspace/useWorkspaceShareState";
import { useWorkspaceStartup } from "@/hooks/workspace/useWorkspaceStartup";
import { useWorkspaceTree } from "@/hooks/workspace/useWorkspaceTree";
import { completeDropboxPopupOAuthIfPresent } from "@/lib/workspace/providers/dropbox/oauth";
import { isMobileBrowser } from "@/lib/platform/browser-support";
import {
  supportsDirectoryPicker,
  supportsSaveFilePicker,
  type AccessDirectoryHandle,
} from "@/lib/workspace/file-system";
import { findMarkdownFile, type MarkdownFileNode } from "@/lib/workspace/tree";
import { useI18n } from "@/lib/i18n";
import { useLiveMdPreload } from "@/lib/editor/live-md-preload";
import { isMobileSidebarViewport } from "@/lib/workspace/constants";
import { defaultDropboxAppKey, defaultDropboxRoot } from "@/lib/workspace/providers/dropbox/config";
import { errorToMessage } from "@/lib/workspace/errors";
import { createEphemeralLocalWorkspaceRecord } from "@/lib/workspace/state";
import { rememberStoredLocalWorkspace, saveStoredWorkspaceKind } from "@/lib/workspace/store";

const WorkspaceAgentFeature = lazy(async () => {
  let module = await import("@/features/workspace-agent/WorkspaceAgentFeature");
  return { default: module.WorkspaceAgentFeature };
});

/**
 * Workspace root. It wires the editor session and feature hooks together and
 * renders from {@link useWorkspaceRootState}, which excludes high-frequency
 * fields; the chrome containers subscribe to those themselves.
 */
export function LocalWorkspaceApp() {
  let { t } = useI18n();
  let {
    error: liveMdPreloadError,
    retry: retryLiveMdPreload,
    retrying: liveMdPreloadRetrying,
  } = useLiveMdPreload();
  let application = useWorkspaceApplication();
  let { documentViews, store: workspaceAppStore } = application;
  let {
    agentActivated,
    agentOpen,
    collabDocument,
    documentSourceKind,
    editorDocumentPath,
    recoveryDialogAction,
    selectedFile,
    sidebarOpen,
    singleFileSource,
    storedDropboxConfig,
    storedLocalWorkspace,
    storedWorkspaceKind,
    tree,
    treeSelection,
    workspaceRuntime,
  } = useWorkspaceRootState(workspaceAppStore);
  let {
    setAgentActivated,
    setAgentOpen,
    setBusy,
    setDropboxConnecting,
    setErrorMessage,
    setRecoveryCopyPath,
    setRecoveryDialogAction,
    setRecoveryDialogError,
    setRestoreChecking,
    setRetryLoadPath,
    setSidebarOpen,
    setStoredDropboxConfig,
    setStoredLocalWorkspace,
    setStoredWorkspaceKind,
    setTree,
    setTreeSelection,
  } = useMemo(() => createWorkspaceAppSetters(workspaceAppStore), [workspaceAppStore]);

  let editorElementRef = useRef<LiveMdEditorElement | null>(null);
  let agentButtonRef = useRef<HTMLButtonElement | null>(null);
  let [settingsOpen, setSettingsOpen] = useState(false);
  let agentWorkspaceKey = singleFileSource ? "" : (workspaceRuntime?.identity.id ?? "");
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

  let { flushOwnerShareHost, startOwnerShareHost, stopOwnerShareHost } = useOwnerShareHost({
    setActiveShareRecord,
    setShareError,
  });

  let session = useWorkspaceEditorSession(application, {
    setActiveShareRecord,
    setCreatedShare,
    startOwnerShareHost,
  });
  let {
    autoSaveTaskRef,
    collabDocumentRef,
    dirtyRef,
    editorValueRef,
    imageUploadAbortRef,
    localFileHandleRef,
    saveOperationRef,
    selectedFileRef,
    selectedFileSourceRef,
    singleFileSourceRef,
    workspaceRuntimeRef,
  } = session.refs;
  let {
    activateSingleFileDocument,
    beginDocumentViewChange,
    cancelImageUpload,
    clearDocumentView,
    discardMaterializedDraft,
    ensureSelectedCollabDocument,
    finishDocumentViewChange,
    handleEditorInput,
    keepCurrentDocumentAs,
    loadFile,
    openSingleFileDraft,
    recreateCurrentDocumentSource,
    regrantWorkspaceAccess,
    replaceWorkspaceRuntime,
    resolveCurrentDocumentUseExternal,
    restoreCloudRedirectEditorDraft,
    saveCurrentFile,
  } = session;

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
  let editorDocument = useMemo(() => ({ path: editorDocumentPath }), [editorDocumentPath]);
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
  let markdownConfig = collabDocument?.liveMdConfig?.markdown ?? null;
  let { clearDropboxAccessToken, openDropboxRuntime, setDropboxRedirectAccessToken } =
    useDropboxWorkspaceRuntime({
      dirtyRef,
      editorValueRef,
      selectedFileRef,
      setStoredDropboxConfig,
      setStoredWorkspaceKind,
      t,
      workspaceRuntimeRef,
    });

  useWorkspacePersistenceLifecycle({
    autoSaveTaskRef,
    clearDocumentView,
    collabDocumentRef,
    dirtyRef,
    setErrorMessage,
  });

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
    [selectedFile, setRecoveryCopyPath, setRecoveryDialogAction, setRecoveryDialogError],
  );

  let closeDocumentRecovery = useCallback(() => {
    setRecoveryDialogAction(null);
    setRecoveryDialogError("");
  }, [setRecoveryDialogAction, setRecoveryDialogError]);

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
    [
      collabDocument,
      keepCurrentDocumentAs,
      loadTree,
      selectedFile,
      setBusy,
      setRecoveryDialogAction,
      setRecoveryDialogError,
      workspaceRuntime,
    ],
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
    setBusy,
    setRecoveryDialogAction,
    setRecoveryDialogError,
    workspaceRuntime,
  ]);

  let recoveryKind =
    documentSourceKind == "missing" || documentSourceKind == "recovery-required"
      ? documentSourceKind
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

  let rememberWorkspaceHandle = useCallback(
    async (handle: AccessDirectoryHandle) => {
      let record = await rememberStoredLocalWorkspace(handle);
      let nextRecord = record ?? createEphemeralLocalWorkspaceRecord(handle);
      setStoredLocalWorkspace(nextRecord);
      setStoredWorkspaceKind("local");
      saveStoredWorkspaceKind("local");
      return nextRecord;
    },
    [setStoredLocalWorkspace, setStoredWorkspaceKind],
  );

  let {
    openDropboxWorkspace,
    openWorkspace,
    refreshWorkspace,
    restoreDropboxWorkspace,
    restoreStoredWorkspace,
  } = useWorkspaceOpeners({
    cancelImageUpload,
    clearDropboxAccessToken,
    openDropboxRuntime,
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
    [loadFile, setSidebarOpen, workspaceRuntime],
  );

  let toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => !open);
  }, [setSidebarOpen]);

  let toggleAgent = useCallback(() => {
    setAgentActivated(true);
    setAgentOpen((open) => !open);
  }, [setAgentActivated, setAgentOpen]);

  let closeAgent = useCallback(() => {
    setAgentOpen(false);
    requestAnimationFrame(() => agentButtonRef.current?.focus());
  }, [setAgentOpen]);

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
    let retryPath = workspaceAppStore.getState().retryLoadPath;
    if (!runtime || !retryPath) return;

    let file = findMarkdownFile(tree, retryPath);
    if (!file) {
      await refreshWorkspace();
      return;
    }

    await loadFile(runtime, file, { saveCurrent: false });
  }, [loadFile, refreshWorkspace, tree, workspaceAppStore, workspaceRuntime]);

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
    openDropboxRuntime,
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

  let restoreAvailable = Boolean(storedLocalWorkspace);
  let dropboxRestoreAvailable = Boolean(storedDropboxConfig);
  let openSettings = useCallback(() => setSettingsOpen(true), []);

  return (
    <TooltipProvider>
      <div className="flex h-svh min-h-0 overflow-hidden bg-background text-foreground">
        <WorkspaceSidebarContainer
          browserSupported={browserSupported}
          canRefresh={canRefreshWorkspace}
          dropboxRestoreAvailable={dropboxRestoreAvailable}
          open={sidebarOpen}
          restoreAvailable={restoreAvailable}
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
          <WorkspaceHeaderContainer
            activeShare={Boolean(activeShareForSelectedFile)}
            agentButtonRef={agentButtonRef}
            agentOpen={agentOpen}
            canExport={Boolean(selectedFile)}
            canInsertImage={canInsertImage}
            canSaveAs={Boolean(selectedFile)}
            canSaveToDevice={supportsSaveFilePicker()}
            canShare={canShareFile}
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

          <WorkspacePermissionBanner onRegrant={() => void regrantWorkspaceAccess()} />

          <WorkspaceErrorBannerContainer
            liveMdPreloadError={liveMdPreloadError}
            liveMdPreloadRetrying={liveMdPreloadRetrying}
            recoveryKind={recoveryKind}
            onRetryDocument={() => void retryUnavailableCollabFile()}
            onRetryLiveMd={() => void retryLiveMdPreload()}
            onKeepLocalAs={() => openDocumentRecovery("keep-local-as")}
            onRecreate={() => openDocumentRecovery("recreate")}
            onUseExternal={() => openDocumentRecovery("use-external")}
          />

          <WorkspaceEditorPaneContainer
            editorBlocked={fileDialogMode != null}
            imagePlugin={imagePlugin}
            placeholder={t("workspace.placeholder")}
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

        <WorkspaceDialogsContainer
          fileNameDialog={{
            error: fileDialogError,
            mode: fileDialogMode,
            value: fileDialogValue,
            onOpenChange: closeFileDialog,
            onSubmit: submitFileDialog,
            onValueChange: setFileDialogValue,
          }}
          recoveryDialog={{
            action: recoveryDialogAction,
            onClose: closeDocumentRecovery,
            onConfirm: confirmDocumentRecovery,
            onCopyPathChange: setRecoveryCopyPath,
            onKeepLocalAs: submitRecoveryCopy,
          }}
          shareDialog={{
            activeShare: activeShareForSelectedFile,
            copied: shareCopied,
            creating: shareCreating,
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
            error: saveAsDropboxError,
            open: saveAsDropboxDialogOpen,
            value: saveAsDropboxPath,
            onOpenChange: closeSaveAsDropboxDialog,
            onSubmit: submitSaveAsDropbox,
            onValueChange: setSaveAsDropboxPath,
          }}
          commandPalette={{
            browserSupported,
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
