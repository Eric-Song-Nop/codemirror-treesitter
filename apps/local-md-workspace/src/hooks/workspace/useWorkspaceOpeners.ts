import { useCallback } from "react";
import type { DropboxRedirectDraft } from "@/lib/workspace/providers/dropbox/redirect-draft";
import {
  type AccessDirectoryHandle,
  ensureReadWritePermission,
  pickWorkspaceDirectory,
  supportsDirectoryPicker,
} from "@/lib/workspace/file-system";
import { defaultSidebarOpen } from "@/lib/workspace/constants";
import { defaultDropboxAppKey } from "@/lib/workspace/providers/dropbox/config";
import { errorToMessage, isAbortError } from "@/lib/workspace/errors";
import { loadWorkspaceSelectedPath } from "@/lib/workspace/state";
import type {
  StoredDropboxWorkspaceConfig,
  StoredLocalWorkspaceRecord,
} from "@/lib/workspace/store";
import { createBrowserLocalWorkspaceRuntime } from "@/lib/workspace/runtime/browser-local-runtime";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

type UseWorkspaceOpenersOptions = {
  cancelImageUpload: () => void;
  clearDropboxAccessToken: () => void;
  createDropboxRuntime: (config: StoredDropboxWorkspaceConfig) => Promise<WorkspaceRuntime>;
  folderAccessUnavailableMessage: string;
  loadTree: (
    runtime: WorkspaceRuntime,
    nextSelectedPath?: null | string,
    options?: { saveBeforeSelect?: boolean },
  ) => Promise<void>;
  refreshWorkspaceForCurrentEditor: (runtime: WorkspaceRuntime) => Promise<void>;
  rememberWorkspaceHandle: (handle: AccessDirectoryHandle) => Promise<StoredLocalWorkspaceRecord>;
  restoreCloudRedirectEditorDraft: (
    runtime: WorkspaceRuntime,
    draft: DropboxRedirectDraft,
  ) => boolean;
  saveCurrentFile: () => Promise<boolean>;
  setBusy: (busy: boolean) => void;
  setDropboxConnecting: (connecting: boolean) => void;
  setErrorMessage: (message: string) => void;
  setRetryLoadPath: (path: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  replaceWorkspaceRuntime: (runtime: WorkspaceRuntime) => Promise<void>;
  storedDropboxConfig: StoredDropboxWorkspaceConfig | null;
  storedLocalWorkspace: StoredLocalWorkspaceRecord | null;
  workspaceRuntime: WorkspaceRuntime | null;
};

export function useWorkspaceOpeners({
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
}: UseWorkspaceOpenersOptions) {
  let openWorkspace = useCallback(async () => {
    setErrorMessage("");
    setRetryLoadPath(null);
    cancelImageUpload();
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
      let runtime = await createBrowserLocalWorkspaceRuntime({ handle, workspaceId: record.id });
      clearDropboxAccessToken();
      await replaceWorkspaceRuntime(runtime);
      setSidebarOpen(defaultSidebarOpen());
      await loadTree(runtime, loadWorkspaceSelectedPath(runtime.identity));
    } catch (error) {
      if (!isAbortError(error)) setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [
    cancelImageUpload,
    clearDropboxAccessToken,
    folderAccessUnavailableMessage,
    loadTree,
    rememberWorkspaceHandle,
    saveCurrentFile,
    setBusy,
    setErrorMessage,
    setRetryLoadPath,
    setSidebarOpen,
    replaceWorkspaceRuntime,
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
      cancelImageUpload();
      if (!options.skipSaveCurrent && !(await saveCurrentFile())) return false;

      setBusy(true);
      setDropboxConnecting(true);

      try {
        let runtime = await createDropboxRuntime(config);
        await replaceWorkspaceRuntime(runtime);
        setSidebarOpen(defaultSidebarOpen());
        await loadTree(
          runtime,
          options.restoreDraft?.selectedPath ?? loadWorkspaceSelectedPath(runtime.identity),
          {
            saveBeforeSelect: false,
          },
        );
        if (options.restoreDraft) restoreCloudRedirectEditorDraft(runtime, options.restoreDraft);
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
      cancelImageUpload,
      createDropboxRuntime,
      loadTree,
      restoreCloudRedirectEditorDraft,
      saveCurrentFile,
      setBusy,
      setDropboxConnecting,
      setErrorMessage,
      setRetryLoadPath,
      setSidebarOpen,
      replaceWorkspaceRuntime,
    ],
  );

  let restoreStoredWorkspace = useCallback(async () => {
    if (!storedLocalWorkspace) return;

    cancelImageUpload();
    setBusy(true);
    setErrorMessage("");
    setRetryLoadPath(null);
    try {
      if (!(await ensureReadWritePermission(storedLocalWorkspace.handle))) {
        setErrorMessage("Read-write folder permission was not granted.");
        setRetryLoadPath(null);
        return;
      }

      let runtime = await createBrowserLocalWorkspaceRuntime({
        handle: storedLocalWorkspace.handle,
        workspaceId: storedLocalWorkspace.id,
      });
      clearDropboxAccessToken();
      await replaceWorkspaceRuntime(runtime);
      setSidebarOpen(defaultSidebarOpen());
      await loadTree(runtime, loadWorkspaceSelectedPath(runtime.identity), {
        saveBeforeSelect: false,
      });
    } catch (error) {
      setErrorMessage(errorToMessage(error));
      setRetryLoadPath(null);
    } finally {
      setBusy(false);
    }
  }, [
    cancelImageUpload,
    clearDropboxAccessToken,
    loadTree,
    setBusy,
    setErrorMessage,
    setRetryLoadPath,
    setSidebarOpen,
    replaceWorkspaceRuntime,
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
    if (!workspaceRuntime) return;

    cancelImageUpload();
    if (!(await saveCurrentFile())) return;
    setBusy(true);
    setErrorMessage("");
    setRetryLoadPath(null);
    try {
      await refreshWorkspaceForCurrentEditor(workspaceRuntime);
    } catch (error) {
      setErrorMessage(errorToMessage(error));
      setRetryLoadPath(null);
    } finally {
      setBusy(false);
    }
  }, [
    cancelImageUpload,
    refreshWorkspaceForCurrentEditor,
    saveCurrentFile,
    setBusy,
    setErrorMessage,
    setRetryLoadPath,
    workspaceRuntime,
  ]);

  return {
    openDropboxWorkspace,
    openWorkspace,
    refreshWorkspace,
    restoreDropboxWorkspace,
    restoreStoredWorkspace,
  };
}
