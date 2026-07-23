import { useCallback } from "react";
import type { DropboxRedirectDraft } from "@/lib/dropbox-redirect-draft";
import {
  type AccessDirectoryHandle,
  createLocalWorkspaceBackend,
  ensureReadWritePermission,
  pickWorkspaceDirectory,
  supportsDirectoryPicker,
} from "@/lib/file-system";
import { defaultSidebarOpen } from "@/lib/workspace/constants";
import { defaultDropboxAppKey } from "@/lib/workspace/dropbox-config";
import { errorToMessage, isAbortError } from "@/lib/workspace/errors";
import { loadWorkspaceSelectedPath } from "@/lib/workspace/state";
import type {
  StoredDropboxWorkspaceConfig,
  StoredLocalWorkspaceRecord,
} from "@/lib/workspace-store";
import type { WorkspaceBackend } from "@/lib/workspace-backend";

type MutableRef<T> = {
  current: T;
};

type UseWorkspaceOpenersOptions = {
  clearDropboxAccessToken: () => void;
  createDropboxBackend: (config: StoredDropboxWorkspaceConfig) => Promise<WorkspaceBackend>;
  documentTargetGenerationRef: MutableRef<number>;
  folderAccessUnavailableMessage: string;
  loadTree: (
    backend: WorkspaceBackend,
    nextSelectedPath?: null | string,
    options?: { saveBeforeSelect?: boolean },
  ) => Promise<void>;
  refreshWorkspaceForCurrentEditor: (backend: WorkspaceBackend) => Promise<void>;
  rememberWorkspaceHandle: (handle: AccessDirectoryHandle) => Promise<StoredLocalWorkspaceRecord>;
  restoreCloudRedirectEditorDraft: (
    backend: WorkspaceBackend,
    draft: DropboxRedirectDraft,
  ) => boolean;
  saveCurrentFile: () => Promise<boolean>;
  setBusy: (busy: boolean) => void;
  setDropboxConnecting: (connecting: boolean) => void;
  setErrorMessage: (message: string) => void;
  setRetryLoadPath: (path: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  setWorkspaceBackend: (backend: WorkspaceBackend) => void;
  storedDropboxConfig: StoredDropboxWorkspaceConfig | null;
  storedLocalWorkspace: StoredLocalWorkspaceRecord | null;
  workspaceBackend: WorkspaceBackend | null;
};

export function useWorkspaceOpeners({
  clearDropboxAccessToken,
  createDropboxBackend,
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
  setWorkspaceBackend,
  storedDropboxConfig,
  storedLocalWorkspace,
  workspaceBackend,
}: UseWorkspaceOpenersOptions) {
  let openWorkspace = useCallback(async () => {
    setErrorMessage("");
    setRetryLoadPath(null);
    documentTargetGenerationRef.current += 1;
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
      clearDropboxAccessToken();
      setWorkspaceBackend(backend);
      setSidebarOpen(defaultSidebarOpen());
      await loadTree(backend, loadWorkspaceSelectedPath(backend));
    } catch (error) {
      if (!isAbortError(error)) setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [
    clearDropboxAccessToken,
    documentTargetGenerationRef,
    folderAccessUnavailableMessage,
    loadTree,
    rememberWorkspaceHandle,
    saveCurrentFile,
    setBusy,
    setErrorMessage,
    setRetryLoadPath,
    setSidebarOpen,
    setWorkspaceBackend,
  ]);

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
      documentTargetGenerationRef.current += 1;
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
        if (options.restoreDraft) restoreCloudRedirectEditorDraft(backend, options.restoreDraft);
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
    [
      createDropboxBackend,
      documentTargetGenerationRef,
      loadTree,
      restoreCloudRedirectEditorDraft,
      saveCurrentFile,
      setBusy,
      setDropboxConnecting,
      setErrorMessage,
      setRetryLoadPath,
      setSidebarOpen,
      setWorkspaceBackend,
    ],
  );

  let restoreStoredWorkspace = useCallback(async () => {
    if (!storedLocalWorkspace) return;

    documentTargetGenerationRef.current += 1;
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
      clearDropboxAccessToken();
      setWorkspaceBackend(backend);
      setSidebarOpen(defaultSidebarOpen());
      await loadTree(backend, loadWorkspaceSelectedPath(backend), { saveBeforeSelect: false });
    } catch (error) {
      setErrorMessage(errorToMessage(error));
      setRetryLoadPath(null);
    } finally {
      setBusy(false);
    }
  }, [
    clearDropboxAccessToken,
    documentTargetGenerationRef,
    loadTree,
    setBusy,
    setErrorMessage,
    setRetryLoadPath,
    setSidebarOpen,
    setWorkspaceBackend,
    storedLocalWorkspace,
  ]);

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
  }, [openDropboxWorkspace, setErrorMessage, setRetryLoadPath, storedDropboxConfig]);

  let refreshWorkspace = useCallback(async () => {
    if (!workspaceBackend) return;

    documentTargetGenerationRef.current += 1;
    if (!(await saveCurrentFile())) return;
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
  }, [
    refreshWorkspaceForCurrentEditor,
    saveCurrentFile,
    documentTargetGenerationRef,
    setBusy,
    setErrorMessage,
    setRetryLoadPath,
    workspaceBackend,
  ]);

  return {
    openDropboxWorkspace,
    openWorkspace,
    refreshWorkspace,
    restoreDropboxWorkspace,
    restoreStoredWorkspace,
  };
}
