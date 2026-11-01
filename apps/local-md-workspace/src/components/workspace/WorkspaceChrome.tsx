import { useMemo, type ComponentProps } from "react";
import type { LiveMdConfig, LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import { ShieldAlertIcon } from "lucide-react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceApplication } from "@/app/WorkspaceApplicationProvider";
import { workspaceLiveObjects } from "@/app/workspace-store";
import { Button } from "@/components/ui/button";
import { WorkspaceDialogs } from "@/components/workspace/WorkspaceDialogs";
import { WorkspaceEditorPane } from "@/components/workspace/WorkspaceEditorPane";
import { WorkspaceErrorBanner } from "@/components/workspace/WorkspaceErrorBanner";
import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { WorkspaceSidebar } from "@/components/workspace/WorkspaceSidebar";
import { useI18n } from "@/lib/i18n";
import { saveStateLabel } from "@/lib/workspace/state";

// These containers subscribe to the high-frequency workspace fields (busy, save
// state, error text, editor document version) so the workspace root does not.

const emptyLiveMdConfig: LiveMdConfig = {};
const emptyLiveMdPlugins: NonNullable<LiveMdConfig["plugins"]> = [];

function useWorkspaceStore() {
  return useWorkspaceApplication().store;
}

/** Busy while an action runs or a document is opening. */
export function useWorkspaceBusy() {
  return useStore(useWorkspaceStore(), (state) => state.busy || state.openingDocument != null);
}

type SidebarProps = ComponentProps<typeof WorkspaceSidebar>;

export function WorkspaceSidebarContainer(
  props: Omit<SidebarProps, "busy" | "dropboxConnecting" | "restoreChecking">,
) {
  let busy = useWorkspaceBusy();
  let { dropboxConnecting, restoreChecking } = useStore(
    useWorkspaceStore(),
    useShallow((state) => ({
      dropboxConnecting: state.dropboxConnecting,
      restoreChecking: state.restoreChecking,
    })),
  );
  return (
    <WorkspaceSidebar
      {...props}
      busy={busy}
      dropboxConnecting={dropboxConnecting}
      restoreChecking={restoreChecking}
    />
  );
}

type HeaderProps = ComponentProps<typeof WorkspaceHeader>;

export function WorkspaceHeaderContainer(
  props: Omit<HeaderProps, "busy" | "dropboxConnecting" | "saveLabel" | "saveState">,
) {
  let { t } = useI18n();
  let busy = useWorkspaceBusy();
  let { dropboxConnecting, saveState, selectedFile, singleFileSource } = useStore(
    useWorkspaceStore(),
    useShallow((state) => ({
      dropboxConnecting: state.dropboxConnecting,
      saveState: state.saveState,
      selectedFile: state.selectedFile,
      singleFileSource: state.singleFileSource,
    })),
  );
  let saveLabel = useMemo(
    () => saveStateLabel(saveState, selectedFile, singleFileSource, t),
    [saveState, selectedFile, singleFileSource, t],
  );
  return (
    <WorkspaceHeader
      {...props}
      busy={busy}
      dropboxConnecting={dropboxConnecting}
      saveLabel={saveLabel}
      saveState={saveState}
    />
  );
}

type ErrorBannerProps = ComponentProps<typeof WorkspaceErrorBanner>;

export function WorkspaceErrorBannerContainer({
  liveMdPreloadError,
  liveMdPreloadRetrying,
  onRetryDocument,
  onRetryLiveMd,
  ...props
}: Omit<ErrorBannerProps, "busy" | "message" | "retryPath" | "onRetry"> & {
  liveMdPreloadError: string;
  liveMdPreloadRetrying: boolean;
  onRetryDocument: () => void;
  onRetryLiveMd: () => void;
}) {
  let busy = useWorkspaceBusy();
  let { errorMessage, retryLoadPath } = useStore(
    useWorkspaceStore(),
    useShallow((state) => ({
      errorMessage: state.errorMessage,
      retryLoadPath: state.retryLoadPath,
    })),
  );
  return (
    <WorkspaceErrorBanner
      {...props}
      busy={busy || liveMdPreloadRetrying}
      message={errorMessage || liveMdPreloadError}
      retryPath={errorMessage ? retryLoadPath : liveMdPreloadError ? "live-md" : null}
      onRetry={() => {
        if (!errorMessage && liveMdPreloadError) {
          onRetryLiveMd();
        } else {
          onRetryDocument();
        }
      }}
    />
  );
}

/** Offers to re-grant File System Access permission after it was revoked. */
export function WorkspacePermissionBanner({ onRegrant }: { onRegrant: () => void }) {
  let { t } = useI18n();
  let busy = useWorkspaceBusy();
  let permission = useStore(useWorkspaceStore(), (state) => state.workspacePermission);
  if (permission == null || permission == "granted") return null;

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive"
      role="alert"
    >
      <ShieldAlertIcon aria-hidden className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {permission == "denied"
          ? t("workspace.permission.revoked")
          : t("workspace.permission.prompt")}
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={onRegrant}>
        {t("actions.regrantAccess")}
      </Button>
    </div>
  );
}

export function WorkspaceEditorPaneContainer({
  editorBlocked,
  imagePlugin,
  placeholder,
  onEditorReady,
  onInput,
}: {
  /** True while a modal flow (for example the file-name dialog) owns focus. */
  editorBlocked: boolean;
  imagePlugin: NonNullable<LiveMdConfig["plugins"]>[number];
  placeholder: string;
  onEditorReady: (editor: LiveMdEditorElement | null) => void;
  onInput: (value: string) => void;
}) {
  let { t } = useI18n();
  let store = useWorkspaceStore();
  let { documentView, editorDocument, hasSelectedFile, openingDocument } = useStore(
    store,
    useShallow((state) => ({
      documentView: state.documentView,
      editorDocument: state.editorDocument,
      hasSelectedFile: state.selectedFile != null,
      openingDocument: state.openingDocument,
    })),
  );
  let live = workspaceLiveObjects(store);
  let collabLiveMdConfig = documentView ? live.collabDocument?.liveMdConfig : undefined;
  let liveMdConfig = useMemo<LiveMdConfig>(
    () => ({
      markdown: collabLiveMdConfig?.markdown,
      plugins: [imagePlugin, ...(collabLiveMdConfig?.plugins ?? emptyLiveMdPlugins)],
    }),
    [collabLiveMdConfig?.markdown, collabLiveMdConfig?.plugins, imagePlugin],
  );
  // The text is published to the live holder together with a version bump or
  // an opening change, both of which re-render this component.
  let document = { ...editorDocument, value: live.editorValue };

  return (
    <WorkspaceEditorPane
      liveMdConfig={hasSelectedFile ? liveMdConfig : emptyLiveMdConfig}
      document={document}
      loadingLabel={
        openingDocument ? t("workspace.loadingFile", { path: openingDocument.path }) : undefined
      }
      placeholder={placeholder}
      selected={hasSelectedFile && openingDocument == null && !editorBlocked}
      onEditorReady={onEditorReady}
      onInput={onInput}
    />
  );
}

type DialogsProps = ComponentProps<typeof WorkspaceDialogs>;

export function WorkspaceDialogsContainer({
  commandPalette,
  deleteDialog,
  fileNameDialog,
  recoveryDialog,
  saveAsDropboxDialog,
  shareDialog,
}: {
  commandPalette: Omit<DialogsProps["commandPalette"], "busy" | "dropboxConnecting">;
  deleteDialog: Omit<DialogsProps["deleteDialog"], "busy">;
  fileNameDialog: Omit<DialogsProps["fileNameDialog"], "busy">;
  recoveryDialog: Omit<DialogsProps["recoveryDialog"], "busy" | "copyPath" | "error">;
  saveAsDropboxDialog: Omit<DialogsProps["saveAsDropboxDialog"], "busy">;
  shareDialog: Omit<DialogsProps["shareDialog"], "busy"> & { creating: boolean };
}) {
  let busy = useWorkspaceBusy();
  let { dropboxConnecting, recoveryCopyPath, recoveryDialogError } = useStore(
    useWorkspaceStore(),
    useShallow((state) => ({
      dropboxConnecting: state.dropboxConnecting,
      recoveryCopyPath: state.recoveryCopyPath,
      recoveryDialogError: state.recoveryDialogError,
    })),
  );
  let { creating, ...share } = shareDialog;
  return (
    <WorkspaceDialogs
      commandPalette={{ ...commandPalette, busy, dropboxConnecting }}
      deleteDialog={{ ...deleteDialog, busy }}
      fileNameDialog={{ ...fileNameDialog, busy }}
      recoveryDialog={{
        ...recoveryDialog,
        busy,
        copyPath: recoveryCopyPath,
        error: recoveryDialogError,
      }}
      saveAsDropboxDialog={{ ...saveAsDropboxDialog, busy: busy || dropboxConnecting }}
      shareDialog={{ ...share, busy: busy || creating }}
    />
  );
}
