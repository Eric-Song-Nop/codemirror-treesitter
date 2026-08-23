import { useCallback, useEffect, useRef } from "react";
import {
  authorizeGoogleDriveWithPkce,
  fetchGoogleDriveAccountIdentity,
  preloadGoogleDriveIdentityServices,
  type GoogleDriveAccessToken,
} from "@/lib/workspace/providers/google-drive/oauth";
import type { TFunction } from "@/lib/i18n";
import {
  opendalWorkspaceId,
  sameOpendalWorkspaceIdentity,
  type OpendalWorkspaceIdentity,
} from "@/lib/workspace/providers/identity";
import {
  ensureGoogleDriveAppWorkspaceManifest,
  ensureGoogleDriveAppWorkspaceRoot,
} from "@/lib/workspace/providers/google-drive/app-workspace";
import { defaultGoogleDriveRoot } from "@/lib/workspace/providers/google-drive/config";
import {
  saveStoredGoogleDriveWorkspaceConfig,
  saveStoredWorkspaceKind,
  type StoredGoogleDriveWorkspaceConfig,
  type StoredWorkspaceKind,
} from "@/lib/workspace/store";
import { createCloudWorkspaceRuntime } from "@/lib/workspace/runtime/cloud-runtime";

type UseGoogleDriveWorkspaceRuntimeOptions = {
  setStoredGoogleDriveConfig: (config: StoredGoogleDriveWorkspaceConfig | null) => void;
  setStoredWorkspaceKind: (kind: StoredWorkspaceKind | null) => void;
  t: TFunction;
};

export function useGoogleDriveWorkspaceRuntime({
  setStoredGoogleDriveConfig,
  setStoredWorkspaceKind,
  t,
}: UseGoogleDriveWorkspaceRuntimeOptions) {
  let googleDriveTokenRef = useRef<GoogleDriveAccessToken | null>(null);
  let googleDriveTokenClientIdRef = useRef("");
  let googleDriveAuthPromiseRef = useRef<Promise<GoogleDriveAccessToken> | null>(null);

  useEffect(() => {
    preloadGoogleDriveIdentityServices();
  }, []);

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

  let authorizeGoogleDriveAccess = useCallback(async (clientId: string) => {
    let normalizedClientId = clientId.trim();
    if (googleDriveAuthPromiseRef.current) return googleDriveAuthPromiseRef.current;

    let promise = authorizeGoogleDriveWithPkce({
      clientId: normalizedClientId,
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
  }, []);

  let createGoogleDriveRuntime = useCallback(
    async (config: StoredGoogleDriveWorkspaceConfig) => {
      let clientId = config.clientId.trim();
      if (!clientId) throw new Error("Google Drive client ID is required.");

      let root = defaultGoogleDriveRoot();
      let workspaceIdentity: OpendalWorkspaceIdentity | null = null;
      let refreshAccessToken = async () => {
        let token = await authorizeGoogleDriveAccess(clientId);
        let identity = await fetchGoogleDriveAccountIdentity(token.accessToken);
        if (workspaceIdentity && !sameOpendalWorkspaceIdentity(workspaceIdentity, identity)) {
          throw new Error(
            "Google Drive account changed. Reconnect Google Drive workspace to continue.",
          );
        }
        return token;
      };
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

      let initialToken = await getAccessToken();
      workspaceIdentity = await fetchGoogleDriveAccountIdentity(initialToken.accessToken);
      let name = t("workspace.googleDriveWorkspace");
      let bootstrapRuntime = await createCloudWorkspaceRuntime({
        identity: {
          id: opendalWorkspaceId("gdrive", undefined, workspaceIdentity),
          kind: "opendal-gdrive",
          name,
        },
        renewSource: async () => ({
          accessToken: (await refreshAccessToken()).accessToken,
          kind: "gdrive",
        }),
        source: { accessToken: initialToken.accessToken, kind: "gdrive" },
      });
      try {
        await ensureGoogleDriveAppWorkspaceRoot(bootstrapRuntime);
      } finally {
        await bootstrapRuntime.dispose();
      }

      let runtime = await createCloudWorkspaceRuntime({
        identity: {
          id: opendalWorkspaceId("gdrive", root, workspaceIdentity),
          kind: "opendal-gdrive",
          name,
        },
        renewSource: async () => ({
          accessToken: (await refreshAccessToken()).accessToken,
          kind: "gdrive",
          root,
        }),
        source: { accessToken: initialToken.accessToken, kind: "gdrive", root },
      });
      try {
        await ensureGoogleDriveAppWorkspaceManifest(runtime);
      } catch (error) {
        await runtime.dispose().catch(() => {});
        throw error;
      }

      let storedConfig = { clientId };
      setStoredGoogleDriveConfig(storedConfig);
      setStoredWorkspaceKind("gdrive");
      saveStoredGoogleDriveWorkspaceConfig(storedConfig);
      saveStoredWorkspaceKind("gdrive");
      return runtime;
    },
    [authorizeGoogleDriveAccess, setStoredGoogleDriveConfig, setStoredWorkspaceKind, t],
  );

  return {
    clearGoogleDriveAccessToken,
    createGoogleDriveRuntime,
    setGoogleDriveRedirectAccessToken,
  };
}
