import { useCallback } from "react";
import type { DropboxRedirectDraft } from "@/lib/dropbox-redirect-draft";
import type { GoogleDriveRedirectDraft } from "@/lib/google-drive-redirect-draft";
import type { OneDriveRedirectDraft } from "@/lib/onedrive-redirect-draft";
import {
  type AccessDirectoryHandle,
  createLocalWorkspaceBackend,
  ensureReadWritePermission,
  pickWorkspaceDirectory,
  supportsDirectoryPicker,
} from "@/lib/file-system";
import { defaultSidebarOpen } from "@/lib/workspace/constants";
import { defaultDropboxAppKey } from "@/lib/workspace/dropbox-config";
import { defaultGoogleDriveClientId } from "@/lib/workspace/google-drive-config";
import { defaultOneDriveClientId } from "@/lib/workspace/onedrive-config";
import { errorToMessage, isAbortError } from "@/lib/workspace/errors";
import { loadWorkspaceSelectedPath } from "@/lib/workspace/state";
import type {
  StoredDropboxWorkspaceConfig,
  StoredGoogleDriveWorkspaceConfig,
  StoredLocalWorkspaceRecord,
  StoredOneDriveWorkspaceConfig,
} from "@/lib/workspace-store";
import type { WorkspaceBackend } from "@/lib/workspace-backend";

type UseWorkspaceOpenersOptions = {
  clearDropboxAccessToken: () => void;
  clearGoogleDriveAccessToken: () => void;
  clearOneDriveAccessToken: () => void;
  createDropboxBackend: (config: StoredDropboxWorkspaceConfig) => Promise<WorkspaceBackend>;
  createGoogleDriveBackend: (config: StoredGoogleDriveWorkspaceConfig) => Promise<WorkspaceBackend>;
  createOneDriveBackend: (config: StoredOneDriveWorkspaceConfig) => Promise<WorkspaceBackend>;
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
    draft: DropboxRedirectDraft | GoogleDriveRedirectDraft | OneDriveRedirectDraft,
  ) => boolean;
  saveCurrentFile: () => Promise<boolean>;
  setBusy: (busy: boolean) => void;
  setDropboxConnecting: (connecting: boolean) => void;
  setErrorMessage: (message: string) => void;
  setGoogleDriveConnecting: (connecting: boolean) => void;
  setOneDriveConnecting: (connecting: boolean) => void;
  setRetryLoadPath: (path: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  setWorkspaceBackend: (backend: WorkspaceBackend) => void;
  storedDropboxConfig: StoredDropboxWorkspaceConfig | null;
  storedGoogleDriveConfig: StoredGoogleDriveWorkspaceConfig | null;
  storedLocalWorkspace: StoredLocalWorkspaceRecord | null;
  storedOneDriveConfig: StoredOneDriveWorkspaceConfig | null;
  workspaceBackend: WorkspaceBackend | null;
};

export function useWorkspaceOpeners({
  clearDropboxAccessToken,
  clearGoogleDriveAccessToken,
  clearOneDriveAccessToken,
  createDropboxBackend,
  createGoogleDriveBackend,
  createOneDriveBackend,
  folderAccessUnavailableMessage,
  loadTree,
  refreshWorkspaceForCurrentEditor,
  rememberWorkspaceHandle,
  restoreCloudRedirectEditorDraft,
  saveCurrentFile,
  setBusy,
  setDropboxConnecting,
  setErrorMessage,
  setGoogleDriveConnecting,
  setOneDriveConnecting,
  setRetryLoadPath,
  setSidebarOpen,
  setWorkspaceBackend,
  storedDropboxConfig,
  storedGoogleDriveConfig,
  storedLocalWorkspace,
  storedOneDriveConfig,
  workspaceBackend,
}: UseWorkspaceOpenersOptions) {
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
      clearDropboxAccessToken();
      clearGoogleDriveAccessToken();
      clearOneDriveAccessToken();
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
    clearGoogleDriveAccessToken,
    clearOneDriveAccessToken,
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

  let openGoogleDriveWorkspace = useCallback(
    async (
      config: StoredGoogleDriveWorkspaceConfig,
      options: {
        restoreDraft?: GoogleDriveRedirectDraft | null;
        skipSaveCurrent?: boolean;
      } = {},
    ) => {
      setErrorMessage("");
      setRetryLoadPath(null);
      if (!options.skipSaveCurrent && !(await saveCurrentFile())) return false;

      setBusy(true);
      setGoogleDriveConnecting(true);

      try {
        let backend = await createGoogleDriveBackend(config);
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
        setGoogleDriveConnecting(false);
        setBusy(false);
      }
    },
    [
      createGoogleDriveBackend,
      loadTree,
      restoreCloudRedirectEditorDraft,
      saveCurrentFile,
      setBusy,
      setErrorMessage,
      setGoogleDriveConnecting,
      setRetryLoadPath,
      setSidebarOpen,
      setWorkspaceBackend,
    ],
  );

  let openOneDriveWorkspace = useCallback(
    async (
      config: StoredOneDriveWorkspaceConfig,
      options: {
        restoreDraft?: OneDriveRedirectDraft | null;
        skipSaveCurrent?: boolean;
      } = {},
    ) => {
      setErrorMessage("");
      setRetryLoadPath(null);
      if (!options.skipSaveCurrent && !(await saveCurrentFile())) return false;

      setBusy(true);
      setOneDriveConnecting(true);

      try {
        let backend = await createOneDriveBackend(config);
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
        setOneDriveConnecting(false);
        setBusy(false);
      }
    },
    [
      createOneDriveBackend,
      loadTree,
      restoreCloudRedirectEditorDraft,
      saveCurrentFile,
      setBusy,
      setErrorMessage,
      setOneDriveConnecting,
      setRetryLoadPath,
      setSidebarOpen,
      setWorkspaceBackend,
    ],
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
      clearDropboxAccessToken();
      clearGoogleDriveAccessToken();
      clearOneDriveAccessToken();
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
    clearGoogleDriveAccessToken,
    clearOneDriveAccessToken,
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

  let restoreGoogleDriveWorkspace = useCallback(async () => {
    if (!storedGoogleDriveConfig) return;
    let clientId = defaultGoogleDriveClientId();
    if (!clientId) {
      setErrorMessage(
        "Google Drive workspace is not configured. Set VITE_GOOGLE_DRIVE_CLIENT_ID for this app.",
      );
      setRetryLoadPath(null);
      return;
    }
    await openGoogleDriveWorkspace({
      clientId,
      root: storedGoogleDriveConfig.root,
    });
  }, [openGoogleDriveWorkspace, setErrorMessage, setRetryLoadPath, storedGoogleDriveConfig]);

  let restoreOneDriveWorkspace = useCallback(async () => {
    if (!storedOneDriveConfig) return;
    let clientId = defaultOneDriveClientId();
    if (!clientId) {
      setErrorMessage(
        "OneDrive workspace is not configured. Set VITE_ONEDRIVE_CLIENT_ID for this app.",
      );
      setRetryLoadPath(null);
      return;
    }
    await openOneDriveWorkspace({
      clientId,
      root: storedOneDriveConfig.root,
    });
  }, [openOneDriveWorkspace, setErrorMessage, setRetryLoadPath, storedOneDriveConfig]);

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
  }, [
    refreshWorkspaceForCurrentEditor,
    saveCurrentFile,
    setBusy,
    setErrorMessage,
    setRetryLoadPath,
    workspaceBackend,
  ]);

  return {
    openDropboxWorkspace,
    openGoogleDriveWorkspace,
    openOneDriveWorkspace,
    openWorkspace,
    refreshWorkspace,
    restoreDropboxWorkspace,
    restoreGoogleDriveWorkspace,
    restoreOneDriveWorkspace,
    restoreStoredWorkspace,
  };
}
