import { Effect } from "effect";
import { useCallback } from "react";
import { useWorkspaceEffectRunner } from "@/app/effect-bridge";
import type { OpenWorkspaceRuntime } from "@/hooks/workspace/workspace-editor-session";
import type { TFunction } from "@/lib/i18n";
import {
  DropboxWorkspaces,
  type DropboxWorkspaceOpenError,
} from "@/lib/workspace/providers/dropbox/dropbox-workspaces";
import { normalizeDropboxRootInput } from "@/lib/workspace/providers/dropbox/config";
import { saveDropboxRedirectDraft } from "@/lib/workspace/providers/dropbox/redirect-draft";
import type { OpendalWorkspaceIdentity } from "@/lib/workspace/providers/identity";
import {
  saveStoredDropboxWorkspaceConfig,
  saveStoredWorkspaceKind,
  type StoredDropboxWorkspaceConfig,
  type StoredWorkspaceKind,
} from "@/lib/workspace/store";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

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

/**
 * React adapter for the `DropboxWorkspaces` service. The Dropbox session (token
 * cache, single in-flight authorization) lives in the service; this hook only
 * supplies UI context (the redirect draft and the localized workspace name) and
 * persists the chosen configuration after a successful open.
 */
export function useDropboxWorkspaceRuntime({
  dirtyRef,
  editorValueRef,
  selectedFileRef,
  setStoredDropboxConfig,
  setStoredWorkspaceKind,
  t,
  workspaceRuntimeRef,
}: UseDropboxWorkspaceRuntimeOptions) {
  let run = useWorkspaceEffectRunner();

  let clearDropboxAccessToken = useCallback(() => {
    void run(DropboxWorkspaces.use((dropbox) => dropbox.clearAccessToken)).catch(() => {});
  }, [run]);

  let setDropboxRedirectAccessToken = useCallback(
    (token: {
      accessToken: string;
      appKey: string;
      expiresAt: number;
      identity?: OpendalWorkspaceIdentity;
    }) => run(DropboxWorkspaces.use((dropbox) => dropbox.setRedirectAccessToken(token))),
    [run],
  );

  /** A scoped effect that opens the Dropbox workspace for `config`. */
  let openDropboxRuntime = useCallback(
    (config: StoredDropboxWorkspaceConfig): OpenWorkspaceRuntime<DropboxWorkspaceOpenError> =>
      DropboxWorkspaces.use((dropbox) =>
        dropbox.open(config, {
          name: t("workspace.dropboxWorkspace"),
          onBeforeFullPageRedirect: ({ appKey, root }) => {
            let runtime = workspaceRuntimeRef.current;
            let file = selectedFileRef.current;
            let shouldRestoreDirtyEditor =
              runtime?.identity.kind == "opendal-dropbox" && Boolean(file) && dirtyRef.current;

            saveDropboxRedirectDraft({
              appKey,
              dirtyValue: shouldRestoreDirtyEditor ? editorValueRef.current : undefined,
              root,
              selectedPath: shouldRestoreDirtyEditor ? file?.path : undefined,
            });
          },
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            let appKey = config.appKey.trim();
            let root = normalizeDropboxRootInput(config.root);
            let storedConfig = root ? { appKey, root } : { appKey };
            setStoredDropboxConfig(storedConfig);
            setStoredWorkspaceKind("dropbox");
            saveStoredDropboxWorkspaceConfig(storedConfig);
            saveStoredWorkspaceKind("dropbox");
          }),
        ),
      ),
    [
      dirtyRef,
      editorValueRef,
      selectedFileRef,
      setStoredDropboxConfig,
      setStoredWorkspaceKind,
      t,
      workspaceRuntimeRef,
    ],
  );

  return {
    clearDropboxAccessToken,
    openDropboxRuntime,
    setDropboxRedirectAccessToken,
  };
}
