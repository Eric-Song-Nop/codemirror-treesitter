import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
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
import { workspaceMutationKeys } from "@/lib/workspace-query-keys";
import type {
  StoredDropboxWorkspaceConfig,
  StoredLocalWorkspaceRecord,
} from "@/lib/workspace-store";
import type { WorkspaceBackend } from "@/lib/workspace-backend";

type UseWorkspaceOpenersOptions = {
  clearDropboxAccessToken: () => void;
  createDropboxBackend: (config: StoredDropboxWorkspaceConfig) => Promise<WorkspaceBackend>;
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

type OpenDropboxWorkspaceInput = {
  config: StoredDropboxWorkspaceConfig;
  options?: {
    restoreDraft?: DropboxRedirectDraft | null;
    skipSaveCurrent?: boolean;
  };
};

export function useWorkspaceOpeners({
  clearDropboxAccessToken,
  createDropboxBackend,
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
  let openWorkspaceImpl = useCallback(async () => {
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

  let openDropboxWorkspaceImpl = useCallback(
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

  let restoreStoredWorkspaceImpl = useCallback(async () => {
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
    loadTree,
    setBusy,
    setErrorMessage,
    setRetryLoadPath,
    setSidebarOpen,
    setWorkspaceBackend,
    storedLocalWorkspace,
  ]);

  let { mutateAsync: openWorkspaceMutation } = useMutation({
    mutationKey: workspaceMutationKeys.openWorkspace,
    mutationFn: openWorkspaceImpl,
  });

  let { mutateAsync: openDropboxWorkspaceMutation } = useMutation({
    mutationKey: workspaceMutationKeys.openDropboxWorkspace,
    mutationFn: ({ config, options }: OpenDropboxWorkspaceInput) =>
      openDropboxWorkspaceImpl(config, options),
  });

  let { mutateAsync: restoreStoredWorkspaceMutation } = useMutation({
    mutationKey: workspaceMutationKeys.restoreWorkspace,
    mutationFn: restoreStoredWorkspaceImpl,
  });

  let openWorkspace = useCallback(() => openWorkspaceMutation(), [openWorkspaceMutation]);

  let openDropboxWorkspace = useCallback(
    (
      config: StoredDropboxWorkspaceConfig,
      options?: {
        restoreDraft?: DropboxRedirectDraft | null;
        skipSaveCurrent?: boolean;
      },
    ) => openDropboxWorkspaceMutation({ config, options }),
    [openDropboxWorkspaceMutation],
  );

  let restoreStoredWorkspace = useCallback(
    () => restoreStoredWorkspaceMutation(),
    [restoreStoredWorkspaceMutation],
  );

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

  let refreshWorkspaceImpl = useCallback(async () => {
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

  let { mutateAsync: refreshWorkspaceMutation } = useMutation({
    mutationKey: workspaceMutationKeys.refreshWorkspace,
    mutationFn: refreshWorkspaceImpl,
  });

  let refreshWorkspace = useCallback(() => refreshWorkspaceMutation(), [refreshWorkspaceMutation]);

  return {
    openDropboxWorkspace,
    openWorkspace,
    refreshWorkspace,
    restoreDropboxWorkspace,
    restoreStoredWorkspace,
  };
}
