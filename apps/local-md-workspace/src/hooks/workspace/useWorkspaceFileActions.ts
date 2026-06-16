import { useCallback, useState, type RefObject } from "react";
import type { LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import {
  getCollabDocumentValue,
  type CollabDocumentState,
} from "@/lib/collaboration/markdown-document";
import { openStandaloneHtmlPrintView } from "@/lib/export/browser-print";
import {
  createStandaloneMarkdownHtml,
  type MarkdownHtmlExportOptions,
  snapshotMarkdownHtmlExportTheme,
} from "@/lib/export/markdown-html";
import {
  saveMarkdownFileAs,
  supportsSaveFilePicker,
  type AccessFileHandle,
} from "@/lib/file-system";
import type { TFunction } from "@/lib/i18n";
import { defaultDropboxAppKey, defaultDropboxRoot } from "@/lib/workspace/dropbox-config";
import {
  defaultGoogleDriveClientId,
  defaultGoogleDriveRoot,
} from "@/lib/workspace/google-drive-config";
import { defaultOneDriveClientId, defaultOneDriveRoot } from "@/lib/workspace/onedrive-config";
import { errorToMessage, isAbortError } from "@/lib/workspace/errors";
import {
  downloadTextFile,
  htmlExportFileName,
  htmlExportTitle,
  markdownHtmlExportWarningMessage,
  markdownPrintWarningMessage,
} from "@/lib/workspace/export";
import {
  createLocalFileBackend,
  markdownDownloadFileName,
  singleFileMarkdownNode,
} from "@/lib/workspace/single-file";
import type { SingleFileSource } from "@/lib/workspace/types";
import {
  normalizeMarkdownPath,
  type MarkdownFileNode,
  type WorkspaceBackend,
} from "@/lib/workspace-backend";
import type {
  StoredDropboxWorkspaceConfig,
  StoredGoogleDriveWorkspaceConfig,
  StoredOneDriveWorkspaceConfig,
} from "@/lib/workspace-store";

type MutableRef<T> = {
  current: T;
};

type MarkdownHtmlExportInput = {
  documentPath: string;
  fileName: string;
  markdown: string;
  resolveAsset: MarkdownHtmlExportOptions["resolveAsset"];
  theme: ReturnType<typeof snapshotMarkdownHtmlExportTheme>;
  title: string;
};

type UseWorkspaceFileActionsOptions = {
  activateSingleFileDocument: (
    source: SingleFileSource,
    backend: WorkspaceBackend,
    file: MarkdownFileNode,
    value: string,
  ) => void;
  collabDocumentRef: MutableRef<CollabDocumentState | null>;
  createDropboxBackend: (config: StoredDropboxWorkspaceConfig) => Promise<WorkspaceBackend>;
  createGoogleDriveBackend: (config: StoredGoogleDriveWorkspaceConfig) => Promise<WorkspaceBackend>;
  createOneDriveBackend: (config: StoredOneDriveWorkspaceConfig) => Promise<WorkspaceBackend>;
  discardMaterializedDraft: (source: SingleFileSource | null) => void;
  editorElementRef: RefObject<LiveMdEditorElement | null>;
  editorValueRef: MutableRef<string>;
  loadTree: (
    backend: WorkspaceBackend,
    nextSelectedPath?: null | string,
    options?: { saveBeforeSelect?: boolean },
  ) => Promise<void>;
  localFileHandleRef: MutableRef<AccessFileHandle | null>;
  refreshWorkspaceForCurrentEditor: (backend: WorkspaceBackend) => Promise<void>;
  resolveImageAssetFile: NonNullable<MarkdownHtmlExportOptions["resolveAsset"]>;
  saveCurrentFile: () => Promise<boolean>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setBusy: (busy: boolean) => void;
  setDropboxConnecting: (connecting: boolean) => void;
  setErrorMessage: (message: string) => void;
  setGoogleDriveConnecting: (connecting: boolean) => void;
  setOneDriveConnecting: (connecting: boolean) => void;
  setRetryLoadPath: (path: string | null) => void;
  setWorkspaceBackend: (backend: WorkspaceBackend) => void;
  singleFileSourceRef: MutableRef<SingleFileSource | null>;
  storedDropboxConfig: StoredDropboxWorkspaceConfig | null;
  storedGoogleDriveConfig: StoredGoogleDriveWorkspaceConfig | null;
  storedOneDriveConfig: StoredOneDriveWorkspaceConfig | null;
  t: TFunction;
  workspaceBackendRef: MutableRef<WorkspaceBackend | null>;
};

export function useWorkspaceFileActions({
  activateSingleFileDocument,
  collabDocumentRef,
  createDropboxBackend,
  createGoogleDriveBackend,
  createOneDriveBackend,
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
  setGoogleDriveConnecting,
  setOneDriveConnecting,
  setRetryLoadPath,
  setWorkspaceBackend,
  singleFileSourceRef,
  storedDropboxConfig,
  storedGoogleDriveConfig,
  storedOneDriveConfig,
  t,
  workspaceBackendRef,
}: UseWorkspaceFileActionsOptions) {
  let [saveAsDropboxDialogOpen, setSaveAsDropboxDialogOpen] = useState(false);
  let [saveAsDropboxPath, setSaveAsDropboxPath] = useState("");
  let [saveAsDropboxError, setSaveAsDropboxError] = useState("");
  let [saveAsGoogleDriveDialogOpen, setSaveAsGoogleDriveDialogOpen] = useState(false);
  let [saveAsGoogleDrivePath, setSaveAsGoogleDrivePath] = useState("");
  let [saveAsGoogleDriveError, setSaveAsGoogleDriveError] = useState("");
  let [saveAsOneDriveDialogOpen, setSaveAsOneDriveDialogOpen] = useState(false);
  let [saveAsOneDrivePath, setSaveAsOneDrivePath] = useState("");
  let [saveAsOneDriveError, setSaveAsOneDriveError] = useState("");

  let currentMarkdownValue = useCallback(() => {
    let activeDocument = collabDocumentRef.current;
    return activeDocument && selectedFileRef.current?.path == activeDocument.path
      ? getCollabDocumentValue(activeDocument)
      : editorValueRef.current;
  }, [collabDocumentRef, editorValueRef, selectedFileRef]);

  let snapshotCurrentFileHtmlExport = useCallback(
    (file: MarkdownFileNode) => {
      if (selectedFileRef.current?.path != file.path) return null;

      return {
        documentPath: file.path,
        fileName: file.name,
        markdown: currentMarkdownValue(),
        resolveAsset: resolveImageAssetFile,
        theme: snapshotMarkdownHtmlExportTheme(editorElementRef.current),
        title: htmlExportTitle(file.name, t),
      };
    },
    [currentMarkdownValue, editorElementRef, resolveImageAssetFile, selectedFileRef, t],
  );

  let createCurrentFileHtmlExport = useCallback(async (input: MarkdownHtmlExportInput) => {
    return createStandaloneMarkdownHtml({
      documentPath: input.documentPath,
      markdown: input.markdown,
      resolveAsset: input.resolveAsset,
      theme: input.theme,
      title: input.title,
    });
  }, []);

  let exportCurrentFileAsHtml = useCallback(async () => {
    let file = selectedFileRef.current;
    if (!file) return;
    if (!(await saveCurrentFile())) return;
    let exportInput = snapshotCurrentFileHtmlExport(file);
    if (!exportInput) return;

    setBusy(true);
    setErrorMessage("");
    try {
      let result = await createCurrentFileHtmlExport(exportInput);
      downloadTextFile(
        htmlExportFileName(exportInput.fileName, t),
        result.html,
        "text/html;charset=utf-8",
      );
      if (result.warnings.length) {
        setErrorMessage(markdownHtmlExportWarningMessage(result.warnings.length, t));
      }
    } catch (error) {
      setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [
    createCurrentFileHtmlExport,
    saveCurrentFile,
    selectedFileRef,
    setBusy,
    setErrorMessage,
    snapshotCurrentFileHtmlExport,
    t,
  ]);

  let printCurrentFileAsPdf = useCallback(async () => {
    let file = selectedFileRef.current;
    if (!file) return;

    let printView: ReturnType<typeof openStandaloneHtmlPrintView>;
    try {
      printView = openStandaloneHtmlPrintView({ title: htmlExportTitle(file.name, t) });
    } catch (error) {
      setErrorMessage(errorToMessage(error));
      return;
    }

    if (!(await saveCurrentFile())) {
      printView.close();
      return;
    }
    let exportInput = snapshotCurrentFileHtmlExport(file);
    if (!exportInput) {
      printView.close();
      return;
    }

    setBusy(true);
    setErrorMessage("");
    try {
      let result = await createCurrentFileHtmlExport(exportInput);
      await printView.printHtml(result.html);
      if (result.warnings.length) {
        setErrorMessage(markdownPrintWarningMessage(result.warnings.length, t));
      }
    } catch (error) {
      printView.close();
      setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [
    createCurrentFileHtmlExport,
    saveCurrentFile,
    selectedFileRef,
    setBusy,
    setErrorMessage,
    snapshotCurrentFileHtmlExport,
    t,
  ]);

  let downloadCurrentMarkdownCopy = useCallback(() => {
    let fileName =
      singleFileSourceRef.current?.name ?? selectedFileRef.current?.name ?? "Untitled.md";
    downloadTextFile(
      markdownDownloadFileName(fileName),
      currentMarkdownValue(),
      "text/markdown;charset=utf-8",
    );
  }, [currentMarkdownValue, selectedFileRef, singleFileSourceRef]);

  let saveSingleFileAsLocal = useCallback(async () => {
    let file = selectedFileRef.current;
    if (!file) return;
    if (!supportsSaveFilePicker()) {
      downloadCurrentMarkdownCopy();
      return;
    }

    let source = singleFileSourceRef.current;
    let value = currentMarkdownValue();
    setBusy(true);
    setErrorMessage("");
    setRetryLoadPath(null);
    try {
      let handle = await saveMarkdownFileAs({
        suggestedName: markdownDownloadFileName(source?.name ?? file.name),
        value,
      });
      let nextName = handle.name || markdownDownloadFileName(source?.name ?? file.name);
      let nextFile = singleFileMarkdownNode(nextName);
      localFileHandleRef.current = handle;
      activateSingleFileDocument(
        { kind: "local-file", name: nextName },
        createLocalFileBackend(handle),
        nextFile,
        value,
      );
      discardMaterializedDraft(source);
      let backend = workspaceBackendRef.current;
      if (backend) await refreshWorkspaceForCurrentEditor(backend);
    } catch (error) {
      if (!isAbortError(error)) setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [
    activateSingleFileDocument,
    currentMarkdownValue,
    discardMaterializedDraft,
    downloadCurrentMarkdownCopy,
    localFileHandleRef,
    refreshWorkspaceForCurrentEditor,
    selectedFileRef,
    setBusy,
    setErrorMessage,
    setRetryLoadPath,
    singleFileSourceRef,
    workspaceBackendRef,
  ]);

  let openSaveAsDropboxDialog = useCallback(() => {
    let fileName =
      singleFileSourceRef.current?.name ?? selectedFileRef.current?.name ?? "Untitled.md";
    setSaveAsDropboxPath(markdownDownloadFileName(fileName));
    setSaveAsDropboxError("");
    setSaveAsDropboxDialogOpen(true);
  }, [selectedFileRef, singleFileSourceRef]);

  let closeSaveAsDropboxDialog = useCallback((open: boolean) => {
    setSaveAsDropboxDialogOpen(open);
    if (!open) setSaveAsDropboxError("");
  }, []);

  let openSaveAsGoogleDriveDialog = useCallback(() => {
    let fileName =
      singleFileSourceRef.current?.name ?? selectedFileRef.current?.name ?? "Untitled.md";
    setSaveAsGoogleDrivePath(markdownDownloadFileName(fileName));
    setSaveAsGoogleDriveError("");
    setSaveAsGoogleDriveDialogOpen(true);
  }, [selectedFileRef, singleFileSourceRef]);

  let closeSaveAsGoogleDriveDialog = useCallback((open: boolean) => {
    setSaveAsGoogleDriveDialogOpen(open);
    if (!open) setSaveAsGoogleDriveError("");
  }, []);

  let openSaveAsOneDriveDialog = useCallback(() => {
    let fileName =
      singleFileSourceRef.current?.name ?? selectedFileRef.current?.name ?? "Untitled.md";
    setSaveAsOneDrivePath(markdownDownloadFileName(fileName));
    setSaveAsOneDriveError("");
    setSaveAsOneDriveDialogOpen(true);
  }, [selectedFileRef, singleFileSourceRef]);

  let closeSaveAsOneDriveDialog = useCallback((open: boolean) => {
    setSaveAsOneDriveDialogOpen(open);
    if (!open) setSaveAsOneDriveError("");
  }, []);

  let submitSaveAsDropbox = useCallback(
    async (rawPath: string) => {
      let source = singleFileSourceRef.current;
      let value = currentMarkdownValue();
      let appKey = defaultDropboxAppKey();
      if (!appKey) {
        setSaveAsDropboxError(
          "Dropbox workspace is not configured. Set VITE_DROPBOX_APP_KEY for this app.",
        );
        return;
      }

      setBusy(true);
      setDropboxConnecting(true);
      setSaveAsDropboxError("");
      setErrorMessage("");
      setRetryLoadPath(null);
      try {
        let path = normalizeMarkdownPath(rawPath);
        let backend =
          workspaceBackendRef.current?.kind == "opendal-dropbox"
            ? workspaceBackendRef.current
            : await createDropboxBackend({
                appKey,
                root: storedDropboxConfig?.root ?? defaultDropboxRoot(),
              });
        await backend.writeFile(path, value);
        setWorkspaceBackend(backend);
        await loadTree(backend, path, { saveBeforeSelect: false });
        discardMaterializedDraft(source);
        setSaveAsDropboxDialogOpen(false);
      } catch (error) {
        setSaveAsDropboxError(errorToMessage(error));
      } finally {
        setDropboxConnecting(false);
        setBusy(false);
      }
    },
    [
      createDropboxBackend,
      currentMarkdownValue,
      discardMaterializedDraft,
      loadTree,
      setBusy,
      setDropboxConnecting,
      setErrorMessage,
      setRetryLoadPath,
      setWorkspaceBackend,
      singleFileSourceRef,
      storedDropboxConfig,
      workspaceBackendRef,
    ],
  );

  let submitSaveAsGoogleDrive = useCallback(
    async (rawPath: string) => {
      let source = singleFileSourceRef.current;
      let value = currentMarkdownValue();
      let clientId = defaultGoogleDriveClientId();
      if (!clientId) {
        setSaveAsGoogleDriveError(
          "Google Drive workspace is not configured. Set VITE_GOOGLE_DRIVE_CLIENT_ID for this app.",
        );
        return;
      }

      setBusy(true);
      setGoogleDriveConnecting(true);
      setSaveAsGoogleDriveError("");
      setErrorMessage("");
      setRetryLoadPath(null);
      try {
        let path = normalizeMarkdownPath(rawPath);
        let backend =
          workspaceBackendRef.current?.kind == "opendal-gdrive"
            ? workspaceBackendRef.current
            : await createGoogleDriveBackend({
                clientId,
                root: storedGoogleDriveConfig?.root ?? defaultGoogleDriveRoot(),
              });
        await backend.writeFile(path, value);
        setWorkspaceBackend(backend);
        await loadTree(backend, path, { saveBeforeSelect: false });
        discardMaterializedDraft(source);
        setSaveAsGoogleDriveDialogOpen(false);
      } catch (error) {
        setSaveAsGoogleDriveError(errorToMessage(error));
      } finally {
        setGoogleDriveConnecting(false);
        setBusy(false);
      }
    },
    [
      createGoogleDriveBackend,
      currentMarkdownValue,
      discardMaterializedDraft,
      loadTree,
      setBusy,
      setErrorMessage,
      setGoogleDriveConnecting,
      setRetryLoadPath,
      setWorkspaceBackend,
      singleFileSourceRef,
      storedGoogleDriveConfig,
      workspaceBackendRef,
    ],
  );

  let submitSaveAsOneDrive = useCallback(
    async (rawPath: string) => {
      let source = singleFileSourceRef.current;
      let value = currentMarkdownValue();
      let clientId = defaultOneDriveClientId();
      if (!clientId) {
        setSaveAsOneDriveError(
          "OneDrive workspace is not configured. Set VITE_ONEDRIVE_CLIENT_ID for this app.",
        );
        return;
      }

      setBusy(true);
      setOneDriveConnecting(true);
      setSaveAsOneDriveError("");
      setErrorMessage("");
      setRetryLoadPath(null);
      try {
        let path = normalizeMarkdownPath(rawPath);
        let backend =
          workspaceBackendRef.current?.kind == "opendal-onedrive"
            ? workspaceBackendRef.current
            : await createOneDriveBackend({
                clientId,
                root: storedOneDriveConfig?.root ?? defaultOneDriveRoot(),
              });
        await backend.writeFile(path, value);
        setWorkspaceBackend(backend);
        await loadTree(backend, path, { saveBeforeSelect: false });
        discardMaterializedDraft(source);
        setSaveAsOneDriveDialogOpen(false);
      } catch (error) {
        setSaveAsOneDriveError(errorToMessage(error));
      } finally {
        setOneDriveConnecting(false);
        setBusy(false);
      }
    },
    [
      createOneDriveBackend,
      currentMarkdownValue,
      discardMaterializedDraft,
      loadTree,
      setBusy,
      setErrorMessage,
      setOneDriveConnecting,
      setRetryLoadPath,
      setWorkspaceBackend,
      singleFileSourceRef,
      storedOneDriveConfig,
      workspaceBackendRef,
    ],
  );

  return {
    saveAsDropboxDialogOpen,
    saveAsDropboxError,
    saveAsDropboxPath,
    saveAsGoogleDriveDialogOpen,
    saveAsGoogleDriveError,
    saveAsGoogleDrivePath,
    saveAsOneDriveDialogOpen,
    saveAsOneDriveError,
    saveAsOneDrivePath,
    closeSaveAsDropboxDialog,
    closeSaveAsGoogleDriveDialog,
    closeSaveAsOneDriveDialog,
    currentMarkdownValue,
    downloadCurrentMarkdownCopy,
    exportCurrentFileAsHtml,
    openSaveAsDropboxDialog,
    openSaveAsGoogleDriveDialog,
    openSaveAsOneDriveDialog,
    printCurrentFileAsPdf,
    saveSingleFileAsLocal,
    setSaveAsDropboxPath,
    setSaveAsGoogleDrivePath,
    setSaveAsOneDrivePath,
    submitSaveAsDropbox,
    submitSaveAsGoogleDrive,
    submitSaveAsOneDrive,
  };
}
