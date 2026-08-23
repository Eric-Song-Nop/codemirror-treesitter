import { useCallback, useRef } from "react";
import {
  authorizeOneDriveWithPkce,
  fetchOneDriveDriveIdentity,
  type OneDriveAccessToken,
} from "@/lib/workspace/providers/onedrive/oauth";
import { saveOneDriveRedirectDraft } from "@/lib/workspace/providers/onedrive/redirect-draft";
import type { TFunction } from "@/lib/i18n";
import {
  opendalWorkspaceId,
  sameOpendalWorkspaceIdentity,
  type OpendalWorkspaceIdentity,
} from "@/lib/workspace/providers/identity";
import {
  defaultOneDriveRedirectUri,
  normalizeOneDriveRootInput,
} from "@/lib/workspace/providers/onedrive/config";
import {
  saveStoredOneDriveWorkspaceConfig,
  saveStoredWorkspaceKind,
  type StoredOneDriveWorkspaceConfig,
  type StoredWorkspaceKind,
} from "@/lib/workspace/store";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import { createCloudWorkspaceRuntime } from "@/lib/workspace/runtime/cloud-runtime";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

type MutableRef<T> = {
  current: T;
};

type UseOneDriveWorkspaceRuntimeOptions = {
  dirtyRef: MutableRef<boolean>;
  editorValueRef: MutableRef<string>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setStoredOneDriveConfig: (config: StoredOneDriveWorkspaceConfig | null) => void;
  setStoredWorkspaceKind: (kind: StoredWorkspaceKind | null) => void;
  t: TFunction;
  workspaceRuntimeRef: MutableRef<WorkspaceRuntime | null>;
};

export function useOneDriveWorkspaceRuntime({
  dirtyRef,
  editorValueRef,
  selectedFileRef,
  setStoredOneDriveConfig,
  setStoredWorkspaceKind,
  t,
  workspaceRuntimeRef,
}: UseOneDriveWorkspaceRuntimeOptions) {
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
          let runtime = workspaceRuntimeRef.current;
          let file = selectedFileRef.current;
          let shouldRestoreDirtyEditor =
            runtime?.identity.kind == "opendal-onedrive" && Boolean(file) && dirtyRef.current;

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
    [dirtyRef, editorValueRef, selectedFileRef, workspaceRuntimeRef],
  );

  let createOneDriveRuntime = useCallback(
    async (config: StoredOneDriveWorkspaceConfig) => {
      let clientId = config.clientId.trim();
      if (!clientId) throw new Error("OneDrive client ID is required.");

      let root = normalizeOneDriveRootInput(config.root);
      let workspaceIdentity: OpendalWorkspaceIdentity | null = null;
      let refreshAccessToken = async () => {
        let token = await authorizeOneDriveAccess(clientId, root);
        let identity = await fetchOneDriveDriveIdentity(token.accessToken);
        if (workspaceIdentity && !sameOpendalWorkspaceIdentity(workspaceIdentity, identity)) {
          throw new Error("OneDrive drive changed. Reconnect OneDrive workspace to continue.");
        }
        return token;
      };
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

      let initialToken = await getAccessToken();
      workspaceIdentity = await fetchOneDriveDriveIdentity(initialToken.accessToken);
      let name = t("workspace.onedriveWorkspace");
      let runtime = await createCloudWorkspaceRuntime({
        identity: {
          id: opendalWorkspaceId("onedrive", root, workspaceIdentity),
          kind: "opendal-onedrive",
          name,
        },
        renewSource: async () => ({
          accessToken: (await refreshAccessToken()).accessToken,
          kind: "onedrive",
          root,
        }),
        source: { accessToken: initialToken.accessToken, kind: "onedrive", root },
      });
      let storedConfig = root ? { clientId, root } : { clientId };
      setStoredOneDriveConfig(storedConfig);
      setStoredWorkspaceKind("onedrive");
      saveStoredOneDriveWorkspaceConfig(storedConfig);
      saveStoredWorkspaceKind("onedrive");
      return runtime;
    },
    [authorizeOneDriveAccess, setStoredOneDriveConfig, setStoredWorkspaceKind, t],
  );

  return {
    clearOneDriveAccessToken,
    createOneDriveRuntime,
    setOneDriveRedirectAccessToken,
  };
}
