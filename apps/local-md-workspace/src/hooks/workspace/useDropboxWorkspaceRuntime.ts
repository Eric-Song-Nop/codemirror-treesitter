import { useCallback, useRef } from "react";
import {
  authorizeDropboxWithPkce,
  fetchDropboxAccountIdentity,
  type DropboxAccessToken,
} from "@/lib/dropbox-oauth";
import { saveDropboxRedirectDraft } from "@/lib/dropbox-redirect-draft";
import type { TFunction } from "@/lib/i18n";
import {
  opendalWorkspaceId,
  sameOpendalWorkspaceIdentity,
  type OpendalWorkspaceIdentity,
} from "@/lib/opendal-workspace-identity";
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
import type { MarkdownFileNode } from "@/lib/workspace-tree";
import { createCloudWorkspaceRuntime } from "@/lib/workspace-runtime/cloud-runtime";
import type { WorkspaceRuntime } from "@/lib/workspace-runtime/types";

type MutableRef<T> = {
  current: T;
};

type UseDropboxWorkspaceRuntimeOptions = {
  dirtyRef: MutableRef<boolean>;
  editorValueRef: MutableRef<string>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setStoredDropboxConfig: (config: StoredDropboxWorkspaceConfig | null) => void;
  setStoredWorkspaceKind: (kind: StoredWorkspaceKind | null) => void;
  t: TFunction;
  workspaceRuntimeRef: MutableRef<WorkspaceRuntime | null>;
};

export function useDropboxWorkspaceRuntime({
  dirtyRef,
  editorValueRef,
  selectedFileRef,
  setStoredDropboxConfig,
  setStoredWorkspaceKind,
  t,
  workspaceRuntimeRef,
}: UseDropboxWorkspaceRuntimeOptions) {
  let dropboxTokenRef = useRef<DropboxAccessToken | null>(null);
  let dropboxTokenAppKeyRef = useRef("");
  let dropboxAuthPromiseRef = useRef<Promise<DropboxAccessToken> | null>(null);

  let clearDropboxAccessToken = useCallback(() => {
    dropboxTokenRef.current = null;
    dropboxTokenAppKeyRef.current = "";
  }, []);

  let setDropboxRedirectAccessToken = useCallback(
    (token: {
      accessToken: string;
      appKey: string;
      expiresAt: number;
      identity?: OpendalWorkspaceIdentity;
    }) => {
      dropboxTokenRef.current = {
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
        ...(token.identity ? { identity: token.identity } : {}),
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
          let runtime = workspaceRuntimeRef.current;
          let file = selectedFileRef.current;
          let shouldRestoreDirtyEditor =
            runtime?.identity.kind == "opendal-dropbox" && Boolean(file) && dirtyRef.current;

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
    [dirtyRef, editorValueRef, selectedFileRef, workspaceRuntimeRef],
  );

  let createDropboxRuntime = useCallback(
    async (config: StoredDropboxWorkspaceConfig) => {
      let appKey = config.appKey.trim();
      if (!appKey) throw new Error("Dropbox app key is required.");

      let root = normalizeDropboxRootInput(config.root);
      let workspaceIdentity: OpendalWorkspaceIdentity | null = null;
      let refreshAccessToken = async () => {
        let token = await authorizeDropboxAccess(appKey, root);
        let identity = await dropboxTokenIdentity(token);
        if (workspaceIdentity && !sameOpendalWorkspaceIdentity(workspaceIdentity, identity)) {
          throw new Error("Dropbox account changed. Reconnect Dropbox workspace to continue.");
        }
        return token;
      };
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

      let initialToken = await getAccessToken();
      workspaceIdentity = await dropboxTokenIdentity(initialToken);
      let name = t("workspace.dropboxWorkspace");
      let runtime = await createCloudWorkspaceRuntime({
        identity: {
          id: opendalWorkspaceId("dropbox", root, workspaceIdentity),
          kind: "opendal-dropbox",
          name,
        },
        renewSource: async () => ({
          accessToken: (await refreshAccessToken()).accessToken,
          kind: "dropbox",
          root,
        }),
        source: {
          accessToken: initialToken.accessToken,
          kind: "dropbox",
          root,
        },
      });
      let storedConfig = root ? { appKey, root } : { appKey };
      setStoredDropboxConfig(storedConfig);
      setStoredWorkspaceKind("dropbox");
      saveStoredDropboxWorkspaceConfig(storedConfig);
      saveStoredWorkspaceKind("dropbox");
      return runtime;
    },
    [authorizeDropboxAccess, setStoredDropboxConfig, setStoredWorkspaceKind, t],
  );

  return {
    clearDropboxAccessToken,
    createDropboxRuntime,
    setDropboxRedirectAccessToken,
  };
}

async function dropboxTokenIdentity(token: DropboxAccessToken): Promise<OpendalWorkspaceIdentity> {
  return token.identity ?? fetchDropboxAccountIdentity(token.accessToken);
}
