import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveMdEditorElement, LiveMdPlugin } from "@codemirror-treesitter/live-md";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileTreeDeleteTarget } from "@/components/FileTree";
import { WorkspaceDialogs } from "@/components/workspace/WorkspaceDialogs";
import { WorkspaceEditorPane } from "@/components/workspace/WorkspaceEditorPane";
import { WorkspaceErrorBanner } from "@/components/workspace/WorkspaceErrorBanner";
import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { WorkspaceSidebar } from "@/components/workspace/WorkspaceSidebar";
import { useDropboxWorkspaceBackend } from "@/hooks/workspace/useDropboxWorkspaceBackend";
import { useOwnerShareHost } from "@/hooks/workspace/useOwnerShareHost";
import { useWorkspaceDocumentActions } from "@/hooks/workspace/useWorkspaceDocumentActions";
import { useWorkspaceEntryDialogs } from "@/hooks/workspace/useWorkspaceEntryDialogs";
import { useWorkspaceFileActions } from "@/hooks/workspace/useWorkspaceFileActions";
import { useWorkspaceImageAssets } from "@/hooks/workspace/useWorkspaceImageAssets";
import { useWorkspaceOpeners } from "@/hooks/workspace/useWorkspaceOpeners";
import { useWorkspaceShareActions } from "@/hooks/workspace/useWorkspaceShareActions";
import { useWorkspaceShareState } from "@/hooks/workspace/useWorkspaceShareState";
import { useWorkspaceStartup } from "@/hooks/workspace/useWorkspaceStartup";
import { useWorkspaceTree } from "@/hooks/workspace/useWorkspaceTree";
import { completeDropboxPopupOAuthIfPresent } from "@/lib/dropbox-oauth";
import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import { isMobileBrowser } from "@/lib/browser-support";
import {
  supportsDirectoryPicker,
  supportsSaveFilePicker,
  type AccessDirectoryHandle,
  type AccessFileHandle,
} from "@/lib/file-system";
import {
  findMarkdownFile,
  type MarkdownDirectoryNode,
  type MarkdownFileNode,
  type WorkspaceBackend,
} from "@/lib/workspace-backend";
import { useI18n } from "@/lib/i18n";
import { useLiveMdPreloadError } from "@/lib/live-md-preload";
import { defaultSidebarOpen, isMobileSidebarViewport } from "@/lib/workspace/constants";
import { defaultDropboxAppKey, defaultDropboxRoot } from "@/lib/workspace/dropbox-config";
import { errorToMessage } from "@/lib/workspace/errors";
import { createEphemeralLocalWorkspaceRecord, saveStateLabel } from "@/lib/workspace/state";
import type { EditorDocument, SaveState, SingleFileSource } from "@/lib/workspace/types";
import {
  loadStoredDropboxWorkspaceConfig,
  loadStoredWorkspaceKind,
  rememberStoredLocalWorkspace,
  saveStoredWorkspaceKind,
  type StoredLocalWorkspaceRecord,
  type StoredDropboxWorkspaceConfig,
  type StoredWorkspaceKind,
} from "@/lib/workspace-store";

const emptyEditorPlugins: readonly LiveMdPlugin[] = [];

export function LocalWorkspaceApp() {
  let { locale, t, toggleLocale } = useI18n();
  let liveMdPreloadError = useLiveMdPreloadError();
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
  let editorValueRef = useRef("");
  let cleanValueRef = useRef("");
  let dirtyRef = useRef(false);
  let editVersionRef = useRef(0);
  let saveStateRef = useRef<SaveState>("idle");
  let saveTimerRef = useRef<number | null>(null);
  let scheduleAutoSaveRef = useRef<() => void>(() => {});
  let saveOperationRef = useRef(0);
  let activeDocumentGenerationRef = useRef(0);
  let loadFileRequestRef = useRef(0);
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
  let headerSubtitle = singleFileSource ? "" : selectedFile ? selectedPathLabel : "";
  let browserSupported = supportsDirectoryPicker();
  let canShareFile = Boolean(!singleFileSource && workspaceBackend && selectedFile);
  let canRefreshWorkspace = Boolean(workspaceBackend);
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
    selectedFile,
    selectedFileRef,
    setBusy,
    setErrorMessage,
    singleFileSource,
    singleFileSourceRef,
    workspaceBackend,
    workspaceBackendRef,
  });
  let editorPlugins = useMemo(
    () => [imagePlugin, ...(collabDocument?.plugins ?? emptyEditorPlugins)],
    [collabDocument?.plugins, imagePlugin],
  );
  let { clearDropboxAccessToken, createDropboxBackend, setDropboxRedirectAccessToken } =
    useDropboxWorkspaceBackend({
      dirtyRef,
      editorValueRef,
      selectedFileRef,
      setStoredDropboxConfig,
      setStoredWorkspaceKind,
      t,
      workspaceBackendRef,
    });

  let setSaveStateSynced = useCallback((nextState: SaveState) => {
    if (saveStateRef.current == nextState) return;
    saveStateRef.current = nextState;
    setSaveState(nextState);
  }, []);

  let {
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
    discardMaterializedDraft,
    ensureSelectedCollabDocument,
    handleEditorInput,
    loadFile,
    openSingleFileDraft,
    restoreDropboxRedirectEditorDraft,
    saveCurrentFile,
  } = useWorkspaceDocumentActions({
    activeDocumentGenerationRef,
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
    saveTimerRef,
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
  });

  let { loadDirectory, loadTree, refreshWorkspaceForCurrentEditor } = useWorkspaceTree({
    clearActiveDocument,
    loadFile,
    localFileHandleRef,
    selectedFileBackendRef,
    selectedFileRef,
    setTree,
    setTreeSelection,
    singleFileSourceRef,
  });

  let loadTreeDirectory = useCallback(
    async (path: string) => {
      if (!workspaceBackend) return;
      try {
        await loadDirectory(workspaceBackend, path);
      } catch (error) {
        setErrorMessage(errorToMessage(error));
      }
    },
    [loadDirectory, setErrorMessage, workspaceBackend],
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
    createDropboxBackend,
    folderAccessUnavailableMessage,
    loadTree,
    refreshWorkspaceForCurrentEditor,
    rememberWorkspaceHandle,
    restoreDropboxRedirectEditorDraft,
    saveCurrentFile,
    setBusy,
    setDropboxConnecting,
    setErrorMessage,
    setRetryLoadPath,
    setSidebarOpen,
    setWorkspaceBackend,
    storedDropboxConfig,
    storedLocalWorkspace,
    workspaceBackend,
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
    setWorkspaceBackend,
    storedDropboxConfig,
    storedLocalWorkspace,
    storedWorkspaceKind,
    workspaceBackend,
  });

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

    let file = findMarkdownFile(tree, retryPath);
    if (!file) {
      await refreshWorkspace();
      return;
    }

    await loadFile(backend, file, { saveCurrent: false });
  }, [loadFile, refreshWorkspace, retryLoadPath, tree, workspaceBackend]);

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
          workspaceOpen={Boolean(workspaceBackend)}
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
          />

          <WorkspaceErrorBanner
            busy={busy}
            message={visibleErrorMessage}
            retryPath={errorMessage ? retryLoadPath : null}
            onRetry={() => void retryUnavailableCollabFile()}
          />

          <WorkspaceEditorPane
            document={editorDocument}
            placeholder={t("workspace.placeholder")}
            plugins={editorPlugins}
            selected={Boolean(selectedFile) && fileDialogMode == null}
            onEditorReady={handleEditorReady}
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
