import { useCallback, useState, type RefObject } from "react";
import type { LiveMdEditorElement, LiveMdMarkdownConfig } from "@codemirror-treesitter/live-md";
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
  writeNewWorkspaceFile,
  type MarkdownFileNode,
  type WorkspaceBackend,
} from "@/lib/workspace-backend";
import type { StoredDropboxWorkspaceConfig } from "@/lib/workspace-store";

type MutableRef<T> = {
  current: T;
};

type MarkdownHtmlExportInput = {
  documentPath: string;
  fileName: string;
  markdown: string;
  markdownConfig: LiveMdMarkdownConfig | null;
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
  discardMaterializedDraft: (source: SingleFileSource | null) => void;
  documentTargetGenerationRef: MutableRef<number>;
  editorElementRef: RefObject<LiveMdEditorElement | null>;
  editorValueRef: MutableRef<string>;
  loadTree: (
    backend: WorkspaceBackend,
    nextSelectedPath?: null | string,
    options?: { saveBeforeSelect?: boolean },
  ) => Promise<void>;
  localFileHandleRef: MutableRef<AccessFileHandle | null>;
  markdownConfig?: LiveMdMarkdownConfig | null;
  refreshWorkspaceForCurrentEditor: (backend: WorkspaceBackend) => Promise<void>;
  resolveImageAssetFile: NonNullable<MarkdownHtmlExportOptions["resolveAsset"]>;
  saveCurrentFile: () => Promise<boolean>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setBusy: (busy: boolean) => void;
  setDropboxConnecting: (connecting: boolean) => void;
  setErrorMessage: (message: string) => void;
  setRetryLoadPath: (path: string | null) => void;
  setWorkspaceBackend: (backend: WorkspaceBackend) => void;
  singleFileSourceRef: MutableRef<SingleFileSource | null>;
  storedDropboxConfig: StoredDropboxWorkspaceConfig | null;
  t: TFunction;
  workspaceBackendRef: MutableRef<WorkspaceBackend | null>;
};

export function useWorkspaceFileActions({
  activateSingleFileDocument,
  collabDocumentRef,
  createDropboxBackend,
  discardMaterializedDraft,
  documentTargetGenerationRef,
  editorElementRef,
  editorValueRef,
  loadTree,
  localFileHandleRef,
  markdownConfig = null,
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
}: UseWorkspaceFileActionsOptions) {
  let [saveAsDropboxDialogOpen, setSaveAsDropboxDialogOpen] = useState(false);
  let [saveAsDropboxPath, setSaveAsDropboxPath] = useState("");
  let [saveAsDropboxError, setSaveAsDropboxError] = useState("");

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
        markdownConfig,
        resolveAsset: resolveImageAssetFile,
        theme: snapshotMarkdownHtmlExportTheme(editorElementRef.current),
        title: htmlExportTitle(file.name, t),
      };
    },
    [
      currentMarkdownValue,
      editorElementRef,
      markdownConfig,
      resolveImageAssetFile,
      selectedFileRef,
      t,
    ],
  );

  let createCurrentFileHtmlExport = useCallback(async (input: MarkdownHtmlExportInput) => {
    return createStandaloneMarkdownHtml({
      documentPath: input.documentPath,
      markdown: input.markdown,
      markdownConfig: input.markdownConfig,
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
    documentTargetGenerationRef.current += 1;
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
    documentTargetGenerationRef,
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

      documentTargetGenerationRef.current += 1;
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
        await writeNewWorkspaceFile(backend, path, value);
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
      documentTargetGenerationRef,
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

  return {
    saveAsDropboxDialogOpen,
    saveAsDropboxError,
    saveAsDropboxPath,
    closeSaveAsDropboxDialog,
    currentMarkdownValue,
    downloadCurrentMarkdownCopy,
    exportCurrentFileAsHtml,
    openSaveAsDropboxDialog,
    printCurrentFileAsPdf,
    saveSingleFileAsLocal,
    setSaveAsDropboxPath,
    submitSaveAsDropbox,
  };
}
