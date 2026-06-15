import { useCallback, useRef } from "react";
import { authorizeOneDriveWithPkce, type OneDriveAccessToken } from "@/lib/onedrive-oauth";
import { saveOneDriveRedirectDraft } from "@/lib/onedrive-redirect-draft";
import type { TFunction } from "@/lib/i18n";
import {
  defaultOneDriveRedirectUri,
  normalizeOneDriveRootInput,
} from "@/lib/workspace/onedrive-config";
import {
  saveStoredOneDriveWorkspaceConfig,
  saveStoredWorkspaceKind,
  type StoredOneDriveWorkspaceConfig,
  type StoredWorkspaceKind,
} from "@/lib/workspace-store";
import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";

type MutableRef<T> = {
  current: T;
};

type UseOneDriveWorkspaceBackendOptions = {
  dirtyRef: MutableRef<boolean>;
  editorValueRef: MutableRef<string>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setStoredOneDriveConfig: (config: StoredOneDriveWorkspaceConfig | null) => void;
  setStoredWorkspaceKind: (kind: StoredWorkspaceKind | null) => void;
  t: TFunction;
  workspaceBackendRef: MutableRef<WorkspaceBackend | null>;
};

export function useOneDriveWorkspaceBackend({
  dirtyRef,
  editorValueRef,
  selectedFileRef,
  setStoredOneDriveConfig,
  setStoredWorkspaceKind,
  t,
  workspaceBackendRef,
}: UseOneDriveWorkspaceBackendOptions) {
  let oneDriveTokenRef = useRef<OneDriveAccessToken | null>(null);
  let oneDriveTokenClientIdRef = useRef("");
  let oneDriveAuthPromiseRef = useRef<Promise<OneDriveAccessToken> | null>(null);

  let clearOneDriveAccessToken = useCallback(() => {
    oneDriveTokenRef.current = null;
    oneDriveTokenClientIdRef.current = "";
  }, []);

  let setOneDriveRedirectAccessToken = useCallback(
    (token: { accessToken: string; clientId: string; expiresAt: number }) => {
      oneDriveTokenRef.current = {
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
      };
      oneDriveTokenClientIdRef.current = token.clientId;
    },
    [],
  );

  let authorizeOneDriveAccess = useCallback(
    async (clientId: string, root?: string) => {
      let normalizedClientId = clientId.trim();
      if (oneDriveAuthPromiseRef.current) return oneDriveAuthPromiseRef.current;

      let redirectUri = defaultOneDriveRedirectUri();
      let promise = authorizeOneDriveWithPkce({
        allowFullPageRedirect: true,
        clientId: normalizedClientId,
        ...(redirectUri ? { redirectUri } : {}),
        onBeforeFullPageRedirect: () => {
          let backend = workspaceBackendRef.current;
          let file = selectedFileRef.current;
          let shouldRestoreDirtyEditor =
            backend?.kind == "opendal-onedrive" && Boolean(file) && dirtyRef.current;

          saveOneDriveRedirectDraft({
            clientId: normalizedClientId,
            dirtyValue: shouldRestoreDirtyEditor ? editorValueRef.current : undefined,
            root,
            selectedPath: shouldRestoreDirtyEditor ? file?.path : undefined,
          });
        },
      });
      oneDriveAuthPromiseRef.current = promise;

      try {
        let token = await promise;
        oneDriveTokenRef.current = token;
        oneDriveTokenClientIdRef.current = normalizedClientId;
        return token;
      } finally {
        if (oneDriveAuthPromiseRef.current == promise) oneDriveAuthPromiseRef.current = null;
      }
    },
    [dirtyRef, editorValueRef, selectedFileRef, workspaceBackendRef],
  );

  let createOneDriveBackend = useCallback(
    async (config: StoredOneDriveWorkspaceConfig) => {
      let clientId = config.clientId.trim();
      if (!clientId) throw new Error("OneDrive client ID is required.");

      let root = normalizeOneDriveRootInput(config.root);
      let refreshAccessToken = () => authorizeOneDriveAccess(clientId, root);
      let getAccessToken = async () => {
        let token = oneDriveTokenRef.current;
        if (
          token &&
          oneDriveTokenClientIdRef.current == clientId &&
          token.expiresAt > Date.now() + 5 * 60 * 1000
        ) {
          return token;
        }
        return refreshAccessToken();
      };

      await getAccessToken();
      let { createOneDriveWorkspaceBackend } = await import("@/lib/onedrive-workspace-backend");
      let backend = createOneDriveWorkspaceBackend({
        getAccessToken,
        name: t("workspace.onedriveWorkspace"),
        refreshAccessToken,
        root,
      });
      let storedConfig = root ? { clientId, root } : { clientId };
      setStoredOneDriveConfig(storedConfig);
      setStoredWorkspaceKind("onedrive");
      saveStoredOneDriveWorkspaceConfig(storedConfig);
      saveStoredWorkspaceKind("onedrive");
      return backend;
    },
    [authorizeOneDriveAccess, setStoredOneDriveConfig, setStoredWorkspaceKind, t],
  );

  return {
    clearOneDriveAccessToken,
    createOneDriveBackend,
    setOneDriveRedirectAccessToken,
  };
}
