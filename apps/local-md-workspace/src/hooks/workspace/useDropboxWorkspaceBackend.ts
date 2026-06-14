import { useCallback, useRef } from "react";
import { authorizeDropboxWithPkce, type DropboxAccessToken } from "@/lib/dropbox-oauth";
import { saveDropboxRedirectDraft } from "@/lib/dropbox-redirect-draft";
import type { TFunction } from "@/lib/i18n";
import {
  defaultDropboxRedirectUri,
  normalizeDropboxRootInput,
} from "@/lib/workspace/dropbox-config";
import {
  saveStoredDropboxWorkspaceConfig,
  saveStoredWorkspaceKind,
  type StoredDropboxWorkspaceConfig,
  type StoredWorkspaceKind,
} from "@/lib/workspace-store";
import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";

type MutableRef<T> = {
  current: T;
};

type UseDropboxWorkspaceBackendOptions = {
  dirtyRef: MutableRef<boolean>;
  editorValueRef: MutableRef<string>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setStoredDropboxConfig: (config: StoredDropboxWorkspaceConfig | null) => void;
  setStoredWorkspaceKind: (kind: StoredWorkspaceKind | null) => void;
  t: TFunction;
  workspaceBackendRef: MutableRef<WorkspaceBackend | null>;
};

export function useDropboxWorkspaceBackend({
  dirtyRef,
  editorValueRef,
  selectedFileRef,
  setStoredDropboxConfig,
  setStoredWorkspaceKind,
  t,
  workspaceBackendRef,
}: UseDropboxWorkspaceBackendOptions) {
  let dropboxTokenRef = useRef<DropboxAccessToken | null>(null);
  let dropboxTokenAppKeyRef = useRef("");
  let dropboxAuthPromiseRef = useRef<Promise<DropboxAccessToken> | null>(null);

  let clearDropboxAccessToken = useCallback(() => {
    dropboxTokenRef.current = null;
    dropboxTokenAppKeyRef.current = "";
  }, []);

  let setDropboxRedirectAccessToken = useCallback(
    (token: { accessToken: string; appKey: string; expiresAt: number }) => {
      dropboxTokenRef.current = {
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
      };
      dropboxTokenAppKeyRef.current = token.appKey;
    },
    [],
  );

  let authorizeDropboxAccess = useCallback(
    async (appKey: string, root?: string) => {
      let normalizedAppKey = appKey.trim();
      if (dropboxAuthPromiseRef.current) return dropboxAuthPromiseRef.current;

      let redirectUri = defaultDropboxRedirectUri();
      let promise = authorizeDropboxWithPkce({
        allowFullPageRedirect: true,
        appKey: normalizedAppKey,
        ...(redirectUri ? { redirectUri } : {}),
        onBeforeFullPageRedirect: () => {
          let backend = workspaceBackendRef.current;
          let file = selectedFileRef.current;
          let shouldRestoreDirtyEditor =
            backend?.kind == "opendal-dropbox" && Boolean(file) && dirtyRef.current;

          saveDropboxRedirectDraft({
            appKey: normalizedAppKey,
            dirtyValue: shouldRestoreDirtyEditor ? editorValueRef.current : undefined,
            root,
            selectedPath: shouldRestoreDirtyEditor ? file?.path : undefined,
          });
        },
      });
      dropboxAuthPromiseRef.current = promise;

      try {
        let token = await promise;
        dropboxTokenRef.current = token;
        dropboxTokenAppKeyRef.current = normalizedAppKey;
        return token;
      } finally {
        if (dropboxAuthPromiseRef.current == promise) dropboxAuthPromiseRef.current = null;
      }
    },
    [dirtyRef, editorValueRef, selectedFileRef, workspaceBackendRef],
  );

  let createDropboxBackend = useCallback(
    async (config: StoredDropboxWorkspaceConfig) => {
      let appKey = config.appKey.trim();
      if (!appKey) throw new Error("Dropbox app key is required.");

      let root = normalizeDropboxRootInput(config.root);
      let refreshAccessToken = () => authorizeDropboxAccess(appKey, root);
      let getAccessToken = async () => {
        let token = dropboxTokenRef.current;
        if (
          token &&
          dropboxTokenAppKeyRef.current == appKey &&
          token.expiresAt > Date.now() + 5 * 60 * 1000
        ) {
          return token;
        }
        return refreshAccessToken();
      };

      await getAccessToken();
      let { createDropboxWorkspaceBackend } = await import("@/lib/dropbox-workspace-backend");
      let backend = createDropboxWorkspaceBackend({
        getAccessToken,
        name: t("workspace.dropboxWorkspace"),
        refreshAccessToken,
        root,
      });
      let storedConfig = root ? { appKey, root } : { appKey };
      setStoredDropboxConfig(storedConfig);
      setStoredWorkspaceKind("dropbox");
      saveStoredDropboxWorkspaceConfig(storedConfig);
      saveStoredWorkspaceKind("dropbox");
      return backend;
    },
    [authorizeDropboxAccess, setStoredDropboxConfig, setStoredWorkspaceKind, t],
  );

  return {
    clearDropboxAccessToken,
    createDropboxBackend,
    setDropboxRedirectAccessToken,
  };
}
