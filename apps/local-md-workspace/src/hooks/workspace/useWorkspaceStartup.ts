import { useEffect, useRef, useState } from "react";
import { completeDropboxRedirectOAuthIfPresent } from "@/lib/dropbox-oauth";
import { takeDropboxRedirectDraft, type DropboxRedirectDraft } from "@/lib/dropbox-redirect-draft";
import { completeOneDriveRedirectOAuthIfPresent } from "@/lib/onedrive-oauth";
import {
  takeOneDriveRedirectDraft,
  type OneDriveRedirectDraft,
} from "@/lib/onedrive-redirect-draft";
import { createLocalWorkspaceBackend, queryReadWritePermission } from "@/lib/file-system";
import { defaultSidebarOpen } from "@/lib/workspace/constants";
import { isDropboxRedirectCallbackWindow } from "@/lib/workspace/dropbox-config";
import { isOneDriveRedirectCallbackWindow } from "@/lib/workspace/onedrive-config";
import { errorToMessage } from "@/lib/workspace/errors";
import { loadWorkspaceSelectedPath } from "@/lib/workspace/state";
import {
  loadStoredLocalWorkspaceRecord,
  type StoredDropboxWorkspaceConfig,
  type StoredLocalWorkspaceRecord,
  type StoredOneDriveWorkspaceConfig,
  type StoredWorkspaceKind,
} from "@/lib/workspace-store";
import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";

type MutableRef<T> = {
  current: T;
};

type OpenSingleFileDraft = (options?: {
  reuseLast?: boolean;
  saveCurrent?: boolean;
  shouldContinue?: () => boolean;
}) => Promise<void>;

type UseWorkspaceStartupOptions = {
  browserSupported: boolean;
  clearDropboxAccessToken: () => void;
  clearOneDriveAccessToken: () => void;
  loadTree: (
    backend: WorkspaceBackend,
    nextSelectedPath?: null | string,
    options?: { saveBeforeSelect?: boolean },
  ) => Promise<void>;
  openDropboxWorkspace: (
    config: StoredDropboxWorkspaceConfig,
    options?: { restoreDraft?: DropboxRedirectDraft | null; skipSaveCurrent?: boolean },
  ) => Promise<boolean>;
  openOneDriveWorkspace: (
    config: StoredOneDriveWorkspaceConfig,
    options?: { restoreDraft?: OneDriveRedirectDraft | null; skipSaveCurrent?: boolean },
  ) => Promise<boolean>;
  openSingleFileDraft: OpenSingleFileDraft;
  selectedFile: MarkdownFileNode | null;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setBusy: (busy: boolean) => void;
  setDropboxConnecting: (connecting: boolean) => void;
  setDropboxRedirectAccessToken: (token: {
    accessToken: string;
    appKey: string;
    expiresAt: number;
  }) => void;
  setErrorMessage: (message: string) => void;
  setOneDriveConnecting: (connecting: boolean) => void;
  setOneDriveRedirectAccessToken: (token: {
    accessToken: string;
    clientId: string;
    expiresAt: number;
  }) => void;
  setRestoreChecking: (checking: boolean) => void;
  setRetryLoadPath: (path: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  setStoredLocalWorkspace: (record: StoredLocalWorkspaceRecord | null) => void;
  setWorkspaceBackend: (backend: WorkspaceBackend) => void;
  storedDropboxConfig: StoredDropboxWorkspaceConfig | null;
  storedLocalWorkspace: StoredLocalWorkspaceRecord | null;
  storedOneDriveConfig: StoredOneDriveWorkspaceConfig | null;
  storedWorkspaceKind: StoredWorkspaceKind | null;
  workspaceBackend: WorkspaceBackend | null;
};

export function useWorkspaceStartup({
  browserSupported,
  clearDropboxAccessToken,
  clearOneDriveAccessToken,
  loadTree,
  openDropboxWorkspace,
  openOneDriveWorkspace,
  openSingleFileDraft,
  selectedFile,
  selectedFileRef,
  setBusy,
  setDropboxConnecting,
  setDropboxRedirectAccessToken,
  setErrorMessage,
  setOneDriveConnecting,
  setOneDriveRedirectAccessToken,
  setRestoreChecking,
  setRetryLoadPath,
  setSidebarOpen,
  setStoredLocalWorkspace,
  setWorkspaceBackend,
  storedDropboxConfig,
  storedLocalWorkspace,
  storedOneDriveConfig,
  storedWorkspaceKind,
  workspaceBackend,
}: UseWorkspaceStartupOptions) {
  let dropboxAutoRestoreAttemptedRef = useRef(false);
  let dropboxRedirectPendingRef = useRef(isDropboxRedirectCallbackWindow());
  let oneDriveAutoRestoreAttemptedRef = useRef(false);
  let oneDriveRedirectPendingRef = useRef(isOneDriveRedirectCallbackWindow());
  let [localRestoreChecked, setLocalRestoreChecked] = useState(false);
  let [dropboxAutoRestoreChecked, setDropboxAutoRestoreChecked] = useState(false);
  let [oneDriveAutoRestoreChecked, setOneDriveAutoRestoreChecked] = useState(false);

  useEffect(() => {
    if (!dropboxRedirectPendingRef.current) return;

    let canceled = false;
    setBusy(true);
    setDropboxConnecting(true);
    setErrorMessage("");

    void (async () => {
      try {
        let token = await completeDropboxRedirectOAuthIfPresent();
        if (canceled || !token) return;

        let draft = takeDropboxRedirectDraft();
        let restoreDraft = draft?.appKey == token.appKey ? draft : null;
        setDropboxRedirectAccessToken(token);

        await openDropboxWorkspace(
          {
            appKey: token.appKey,
            root: restoreDraft?.root,
          },
          {
            restoreDraft,
            skipSaveCurrent: true,
          },
        );
      } catch (error) {
        if (!canceled) {
          setErrorMessage(errorToMessage(error));
          setRetryLoadPath(null);
        }
      } finally {
        dropboxRedirectPendingRef.current = false;
        if (!canceled) {
          setDropboxAutoRestoreChecked(true);
          setOneDriveAutoRestoreChecked(true);
          setDropboxConnecting(false);
          setBusy(false);
        }
      }
    })();

    return () => {
      canceled = true;
    };
  }, [
    openDropboxWorkspace,
    setBusy,
    setDropboxConnecting,
    setDropboxRedirectAccessToken,
    setErrorMessage,
    setRetryLoadPath,
  ]);

  useEffect(() => {
    if (!oneDriveRedirectPendingRef.current) return;

    let canceled = false;
    setBusy(true);
    setOneDriveConnecting(true);
    setErrorMessage("");

    void (async () => {
      try {
        let token = await completeOneDriveRedirectOAuthIfPresent();
        if (canceled || !token) return;

        let draft = takeOneDriveRedirectDraft();
        let restoreDraft = draft?.clientId == token.clientId ? draft : null;
        setOneDriveRedirectAccessToken(token);

        await openOneDriveWorkspace(
          {
            clientId: token.clientId,
            root: restoreDraft?.root,
          },
          {
            restoreDraft,
            skipSaveCurrent: true,
          },
        );
      } catch (error) {
        if (!canceled) {
          setErrorMessage(errorToMessage(error));
          setRetryLoadPath(null);
        }
      } finally {
        oneDriveRedirectPendingRef.current = false;
        if (!canceled) {
          setDropboxAutoRestoreChecked(true);
          setOneDriveAutoRestoreChecked(true);
          setOneDriveConnecting(false);
          setBusy(false);
        }
      }
    })();

    return () => {
      canceled = true;
    };
  }, [
    openOneDriveWorkspace,
    setBusy,
    setErrorMessage,
    setOneDriveConnecting,
    setOneDriveRedirectAccessToken,
    setRetryLoadPath,
  ]);

  useEffect(() => {
    if (dropboxRedirectPendingRef.current || oneDriveRedirectPendingRef.current) {
      setLocalRestoreChecked(true);
      return;
    }
    if (!browserSupported) {
      setLocalRestoreChecked(true);
      return;
    }
    if (workspaceBackend) {
      setLocalRestoreChecked(true);
      return;
    }
    if (
      (storedWorkspaceKind == "dropbox" && storedDropboxConfig) ||
      (storedWorkspaceKind == "onedrive" && storedOneDriveConfig)
    ) {
      setLocalRestoreChecked(true);
      return;
    }

    let canceled = false;
    setRestoreChecking(true);

    void (async () => {
      try {
        let record = await loadStoredLocalWorkspaceRecord();
        if (canceled || !record) return;

        setStoredLocalWorkspace(record);

        if ((await queryReadWritePermission(record.handle)) != "granted") {
          return;
        }
        if (canceled) return;

        let backend = createLocalWorkspaceBackend(record.handle, record.id);
        clearDropboxAccessToken();
        clearOneDriveAccessToken();
        setWorkspaceBackend(backend);
        setSidebarOpen(defaultSidebarOpen());
        await loadTree(backend, loadWorkspaceSelectedPath(backend), { saveBeforeSelect: false });
      } catch (error) {
        if (!canceled) setErrorMessage(errorToMessage(error));
      } finally {
        if (!canceled) {
          setRestoreChecking(false);
          setLocalRestoreChecked(true);
        }
      }
    })();

    return () => {
      canceled = true;
    };
  }, [
    browserSupported,
    clearDropboxAccessToken,
    clearOneDriveAccessToken,
    loadTree,
    setErrorMessage,
    setRestoreChecking,
    setSidebarOpen,
    setStoredLocalWorkspace,
    setWorkspaceBackend,
    storedDropboxConfig,
    storedOneDriveConfig,
    storedWorkspaceKind,
    workspaceBackend,
  ]);

  useEffect(() => {
    if (
      !localRestoreChecked ||
      dropboxRedirectPendingRef.current ||
      oneDriveRedirectPendingRef.current
    ) {
      return;
    }
    if (dropboxAutoRestoreAttemptedRef.current) return;
    if (
      workspaceBackend ||
      !storedDropboxConfig ||
      (storedWorkspaceKind && storedWorkspaceKind != "dropbox") ||
      (!storedWorkspaceKind && storedLocalWorkspace)
    ) {
      setDropboxAutoRestoreChecked(true);
      return;
    }

    dropboxAutoRestoreAttemptedRef.current = true;
    setDropboxAutoRestoreChecked(false);
    void (async () => {
      try {
        await openDropboxWorkspace(storedDropboxConfig, { skipSaveCurrent: true });
      } finally {
        setDropboxAutoRestoreChecked(true);
      }
    })();
  }, [
    localRestoreChecked,
    openDropboxWorkspace,
    storedDropboxConfig,
    storedLocalWorkspace,
    storedWorkspaceKind,
    workspaceBackend,
  ]);

  useEffect(() => {
    if (!localRestoreChecked || !dropboxAutoRestoreChecked || oneDriveRedirectPendingRef.current) {
      return;
    }
    if (oneDriveAutoRestoreAttemptedRef.current) return;
    if (
      workspaceBackend ||
      !storedOneDriveConfig ||
      (storedWorkspaceKind && storedWorkspaceKind != "onedrive") ||
      (!storedWorkspaceKind && storedLocalWorkspace)
    ) {
      setOneDriveAutoRestoreChecked(true);
      return;
    }

    oneDriveAutoRestoreAttemptedRef.current = true;
    setOneDriveAutoRestoreChecked(false);
    void (async () => {
      try {
        await openOneDriveWorkspace(storedOneDriveConfig, { skipSaveCurrent: true });
      } finally {
        setOneDriveAutoRestoreChecked(true);
      }
    })();
  }, [
    dropboxAutoRestoreChecked,
    localRestoreChecked,
    openOneDriveWorkspace,
    storedLocalWorkspace,
    storedOneDriveConfig,
    storedWorkspaceKind,
    workspaceBackend,
  ]);

  useEffect(() => {
    if (
      !localRestoreChecked ||
      !dropboxAutoRestoreChecked ||
      !oneDriveAutoRestoreChecked ||
      dropboxRedirectPendingRef.current ||
      oneDriveRedirectPendingRef.current ||
      workspaceBackend ||
      selectedFile
    ) {
      return;
    }

    void openSingleFileDraft({
      reuseLast: true,
      saveCurrent: false,
      shouldContinue: () => !selectedFileRef.current,
    });
  }, [
    dropboxAutoRestoreChecked,
    localRestoreChecked,
    oneDriveAutoRestoreChecked,
    openSingleFileDraft,
    selectedFile,
    selectedFileRef,
    workspaceBackend,
  ]);
}
