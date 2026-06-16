import { useCallback, useRef } from "react";
import {
  authorizeGoogleDriveWithPkce,
  type GoogleDriveAccessToken,
} from "@/lib/google-drive-oauth";
import { saveGoogleDriveRedirectDraft } from "@/lib/google-drive-redirect-draft";
import type { TFunction } from "@/lib/i18n";
import {
  ensureGoogleDriveAppWorkspaceManifest,
  ensureGoogleDriveAppWorkspaceRoot,
} from "@/lib/workspace/google-drive-app-workspace";
import {
  defaultGoogleDriveRedirectUri,
  defaultGoogleDriveRoot,
} from "@/lib/workspace/google-drive-config";
import {
  saveStoredGoogleDriveWorkspaceConfig,
  saveStoredWorkspaceKind,
  type StoredGoogleDriveWorkspaceConfig,
  type StoredWorkspaceKind,
} from "@/lib/workspace-store";
import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";

type MutableRef<T> = {
  current: T;
};

type UseGoogleDriveWorkspaceBackendOptions = {
  dirtyRef: MutableRef<boolean>;
  editorValueRef: MutableRef<string>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setStoredGoogleDriveConfig: (config: StoredGoogleDriveWorkspaceConfig | null) => void;
  setStoredWorkspaceKind: (kind: StoredWorkspaceKind | null) => void;
  t: TFunction;
  workspaceBackendRef: MutableRef<WorkspaceBackend | null>;
};

export function useGoogleDriveWorkspaceBackend({
  dirtyRef,
  editorValueRef,
  selectedFileRef,
  setStoredGoogleDriveConfig,
  setStoredWorkspaceKind,
  t,
  workspaceBackendRef,
}: UseGoogleDriveWorkspaceBackendOptions) {
  let googleDriveTokenRef = useRef<GoogleDriveAccessToken | null>(null);
  let googleDriveTokenClientIdRef = useRef("");
  let googleDriveAuthPromiseRef = useRef<Promise<GoogleDriveAccessToken> | null>(null);

  let clearGoogleDriveAccessToken = useCallback(() => {
    googleDriveTokenRef.current = null;
    googleDriveTokenClientIdRef.current = "";
  }, []);

  let setGoogleDriveRedirectAccessToken = useCallback(
    (token: { accessToken: string; clientId: string; expiresAt: number }) => {
      googleDriveTokenRef.current = {
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
      };
      googleDriveTokenClientIdRef.current = token.clientId;
    },
    [],
  );

  let authorizeGoogleDriveAccess = useCallback(
    async (clientId: string) => {
      let normalizedClientId = clientId.trim();
      if (googleDriveAuthPromiseRef.current) return googleDriveAuthPromiseRef.current;

      let redirectUri = defaultGoogleDriveRedirectUri();
      let promise = authorizeGoogleDriveWithPkce({
        allowFullPageRedirect: true,
        clientId: normalizedClientId,
        ...(redirectUri ? { redirectUri } : {}),
        onBeforeFullPageRedirect: () => {
          let backend = workspaceBackendRef.current;
          let file = selectedFileRef.current;
          let shouldRestoreDirtyEditor =
            backend?.kind == "opendal-gdrive" && Boolean(file) && dirtyRef.current;

          saveGoogleDriveRedirectDraft({
            clientId: normalizedClientId,
            dirtyValue: shouldRestoreDirtyEditor ? editorValueRef.current : undefined,
            selectedPath: shouldRestoreDirtyEditor ? file?.path : undefined,
          });
        },
      });
      googleDriveAuthPromiseRef.current = promise;

      try {
        let token = await promise;
        googleDriveTokenRef.current = token;
        googleDriveTokenClientIdRef.current = normalizedClientId;
        return token;
      } finally {
        if (googleDriveAuthPromiseRef.current == promise) {
          googleDriveAuthPromiseRef.current = null;
        }
      }
    },
    [dirtyRef, editorValueRef, selectedFileRef, workspaceBackendRef],
  );

  let createGoogleDriveBackend = useCallback(
    async (config: StoredGoogleDriveWorkspaceConfig) => {
      let clientId = config.clientId.trim();
      if (!clientId) throw new Error("Google Drive client ID is required.");

      let root = defaultGoogleDriveRoot();
      let refreshAccessToken = () => authorizeGoogleDriveAccess(clientId);
      let getAccessToken = async () => {
        let token = googleDriveTokenRef.current;
        if (
          token &&
          googleDriveTokenClientIdRef.current == clientId &&
          token.expiresAt > Date.now() + 5 * 60 * 1000
        ) {
          return token;
        }
        return refreshAccessToken();
      };

      await getAccessToken();
      let { createGoogleDriveWorkspaceBackend } =
        await import("@/lib/google-drive-workspace-backend");
      let bootstrapBackend = createGoogleDriveWorkspaceBackend({
        getAccessToken,
        name: t("workspace.googleDriveWorkspace"),
        refreshAccessToken,
      });
      await ensureGoogleDriveAppWorkspaceRoot(bootstrapBackend);

      let backend = createGoogleDriveWorkspaceBackend({
        getAccessToken,
        name: t("workspace.googleDriveWorkspace"),
        refreshAccessToken,
        root,
      });
      await ensureGoogleDriveAppWorkspaceManifest(backend);

      let storedConfig = { clientId };
      setStoredGoogleDriveConfig(storedConfig);
      setStoredWorkspaceKind("gdrive");
      saveStoredGoogleDriveWorkspaceConfig(storedConfig);
      saveStoredWorkspaceKind("gdrive");
      return backend;
    },
    [authorizeGoogleDriveAccess, setStoredGoogleDriveConfig, setStoredWorkspaceKind, t],
  );

  return {
    clearGoogleDriveAccessToken,
    createGoogleDriveBackend,
    setGoogleDriveRedirectAccessToken,
  };
}
