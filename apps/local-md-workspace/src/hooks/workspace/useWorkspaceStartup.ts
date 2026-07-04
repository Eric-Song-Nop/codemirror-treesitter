import { useEffect, useRef, useState } from "react";
import { completeDropboxRedirectOAuthIfPresent } from "@/lib/dropbox-oauth";
import { takeDropboxRedirectDraft, type DropboxRedirectDraft } from "@/lib/dropbox-redirect-draft";
import { createLocalWorkspaceBackend, queryReadWritePermission } from "@/lib/file-system";
import {
  clearSharedMarkdownDraftLaunchParams,
  readSharedMarkdownDraftLaunch,
  sharedMarkdownDraftLaunchErrorMessage,
} from "@/lib/share-target";
import { defaultSidebarOpen } from "@/lib/workspace/constants";
import { isDropboxRedirectCallbackWindow } from "@/lib/workspace/dropbox-config";
import { errorToMessage } from "@/lib/workspace/errors";
import { loadWorkspaceSelectedPath } from "@/lib/workspace/state";
import type { OpendalWorkspaceIdentity } from "@/lib/opendal-workspace-backend";
import {
  loadStoredLocalWorkspaceRecord,
  type StoredDropboxWorkspaceConfig,
  type StoredLocalWorkspaceRecord,
  type StoredWorkspaceKind,
} from "@/lib/workspace-store";
import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";

type MutableRef<T> = {
  current: T;
};

type OpenSingleFileDraft = (options?: {
  draftId?: string;
  reuseLast?: boolean;
  saveCurrent?: boolean;
  shouldContinue?: () => boolean;
}) => Promise<void>;

type UseWorkspaceStartupOptions = {
  browserSupported: boolean;
  clearDropboxAccessToken: () => void;
  loadTree: (
    backend: WorkspaceBackend,
    nextSelectedPath?: null | string,
    options?: { saveBeforeSelect?: boolean },
  ) => Promise<void>;
  openDropboxWorkspace: (
    config: StoredDropboxWorkspaceConfig,
    options?: { restoreDraft?: DropboxRedirectDraft | null; skipSaveCurrent?: boolean },
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
    identity?: OpendalWorkspaceIdentity;
  }) => void;
  setErrorMessage: (message: string) => void;
  setRestoreChecking: (checking: boolean) => void;
  setRetryLoadPath: (path: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  setStoredLocalWorkspace: (record: StoredLocalWorkspaceRecord | null) => void;
  setWorkspaceBackend: (backend: WorkspaceBackend) => void;
  storedDropboxConfig: StoredDropboxWorkspaceConfig | null;
  storedLocalWorkspace: StoredLocalWorkspaceRecord | null;
  storedWorkspaceKind: StoredWorkspaceKind | null;
  workspaceBackend: WorkspaceBackend | null;
};

export function useWorkspaceStartup({
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
}: UseWorkspaceStartupOptions) {
  let dropboxAutoRestoreAttemptedRef = useRef(false);
  let dropboxRedirectPendingRef = useRef(isDropboxRedirectCallbackWindow());
  let sharedDraftLaunchRef = useRef(readSharedMarkdownDraftLaunch());
  let [sharedDraftLaunchChecked, setSharedDraftLaunchChecked] = useState(
    () => sharedDraftLaunchRef.current == null,
  );
  let [localRestoreChecked, setLocalRestoreChecked] = useState(false);
  let [dropboxAutoRestoreChecked, setDropboxAutoRestoreChecked] = useState(false);

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
    let launch = sharedDraftLaunchRef.current;
    if (!launch || sharedDraftLaunchChecked || dropboxRedirectPendingRef.current) return;

    if ("error" in launch) {
      setErrorMessage(sharedMarkdownDraftLaunchErrorMessage(launch.error));
      setRetryLoadPath(null);
      clearSharedMarkdownDraftLaunchParams();
      setSharedDraftLaunchChecked(true);
      return;
    }

    let canceled = false;
    void (async () => {
      try {
        await openSingleFileDraft({
          draftId: launch.draftId,
          saveCurrent: false,
          shouldContinue: () => !selectedFileRef.current,
        });
        if (!canceled) clearSharedMarkdownDraftLaunchParams();
      } finally {
        if (!canceled) setSharedDraftLaunchChecked(true);
      }
    })();

    return () => {
      canceled = true;
    };
  }, [
    openSingleFileDraft,
    selectedFileRef,
    setErrorMessage,
    setRetryLoadPath,
    sharedDraftLaunchChecked,
  ]);

  useEffect(() => {
    if (sharedDraftLaunchRef.current) {
      setLocalRestoreChecked(true);
      return;
    }
    if (dropboxRedirectPendingRef.current) {
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
    if (storedWorkspaceKind == "dropbox" && storedDropboxConfig) {
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
    loadTree,
    setErrorMessage,
    setRestoreChecking,
    setSidebarOpen,
    setStoredLocalWorkspace,
    setWorkspaceBackend,
    storedDropboxConfig,
    storedWorkspaceKind,
    workspaceBackend,
  ]);

  useEffect(() => {
    if (!localRestoreChecked || dropboxRedirectPendingRef.current) {
      return;
    }
    if (dropboxAutoRestoreAttemptedRef.current) return;
    if (sharedDraftLaunchRef.current) {
      setDropboxAutoRestoreChecked(true);
      return;
    }
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
    if (
      !localRestoreChecked ||
      !dropboxAutoRestoreChecked ||
      dropboxRedirectPendingRef.current ||
      workspaceBackend ||
      selectedFile
    ) {
      return;
    }
    if (sharedDraftLaunchRef.current) return;

    void openSingleFileDraft({
      reuseLast: true,
      saveCurrent: false,
      shouldContinue: () => !selectedFileRef.current,
    });
  }, [
    dropboxAutoRestoreChecked,
    localRestoreChecked,
    openSingleFileDraft,
    selectedFile,
    selectedFileRef,
    workspaceBackend,
  ]);
}
