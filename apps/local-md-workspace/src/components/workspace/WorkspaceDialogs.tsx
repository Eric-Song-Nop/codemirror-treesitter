import type { FileTreeDeleteTarget } from "@/components/FileTree";
import { WorkspaceCommandPalette } from "@/components/WorkspaceCommandPalette";
import { DeleteEntryDialog } from "@/components/workspace/DeleteEntryDialog";
import {
  DocumentRecoveryDialogs,
  type DocumentRecoveryAction,
} from "@/components/workspace/DocumentRecoveryDialogs";
import { FileNameDialog, SaveAsDropboxDialog } from "@/components/workspace/FileDialogs";
import { ShareFileDialog } from "@/components/workspace/ShareFileDialog";
import type { ShareExpirationOption } from "@/lib/collaboration/share-identity";
import type { MarkdownDirectoryNode, MarkdownFileNode } from "@/lib/workspace/tree";
import type { ActiveOwnerShareRecord, FileDialogMode } from "@/lib/workspace/types";

type FileNameDialogState = {
  busy: boolean;
  error: string;
  mode: FileDialogMode | null;
  value: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: string) => Promise<void>;
  onValueChange: (value: string) => void;
};

type ShareDialogState = {
  activeShare: ActiveOwnerShareRecord | null;
  busy: boolean;
  copied: boolean;
  error: string;
  expiration: ShareExpirationOption;
  file: MarkdownFileNode | null;
  link: string;
  open: boolean;
  shared: boolean;
  onCopyLink: () => Promise<void>;
  onCreateLink: () => Promise<void>;
  onExpirationChange: (value: ShareExpirationOption) => void;
  onOpenChange: (open: boolean) => void;
  onRotateLink: () => Promise<void>;
  onStopSharing: () => Promise<void>;
};

type SaveAsDropboxDialogState = {
  busy: boolean;
  error: string;
  open: boolean;
  value: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: string) => Promise<void>;
  onValueChange: (value: string) => void;
};

type CommandPaletteState = {
  browserSupported: boolean;
  busy: boolean;
  canInsertImage: boolean;
  canSaveAs: boolean;
  canSaveAsLocal: boolean;
  disabled: boolean;
  dropboxConnecting: boolean;
  selectedPath: string | null;
  sidebarOpen: boolean;
  tree: MarkdownDirectoryNode | null;
  onConnectDropbox: () => void;
  onDownloadCopy: () => void;
  onInsertImage: () => void;
  onNewDraft: () => void;
  onOpenFolder: () => void;
  onSaveAsDropbox: () => void;
  onSaveAsLocal: () => void;
  onSelectFile: (file: MarkdownFileNode) => void;
  onToggleSidebar: () => void;
};

type DeleteDialogState = {
  busy: boolean;
  target: FileTreeDeleteTarget | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
};

type WorkspaceDialogsProps = {
  commandPalette: CommandPaletteState;
  deleteDialog: DeleteDialogState;
  fileNameDialog: FileNameDialogState;
  recoveryDialog: {
    action: DocumentRecoveryAction | null;
    busy: boolean;
    copyPath: string;
    error: string;
    onClose: () => void;
    onConfirm: () => Promise<void>;
    onCopyPathChange: (value: string) => void;
    onKeepLocalAs: (path: string) => Promise<void>;
  };
  saveAsDropboxDialog: SaveAsDropboxDialogState;
  shareDialog: ShareDialogState;
};

export function WorkspaceDialogs({
  commandPalette,
  deleteDialog,
  fileNameDialog,
  recoveryDialog,
  saveAsDropboxDialog,
  shareDialog,
}: WorkspaceDialogsProps) {
  return (
    <>
      <FileNameDialog
        busy={fileNameDialog.busy}
        error={fileNameDialog.error}
        mode={fileNameDialog.mode}
        open={fileNameDialog.mode != null}
        value={fileNameDialog.value}
        onOpenChange={fileNameDialog.onOpenChange}
        onSubmit={fileNameDialog.onSubmit}
        onValueChange={fileNameDialog.onValueChange}
      />

      <DocumentRecoveryDialogs {...recoveryDialog} />

      <ShareFileDialog
        activeShare={shareDialog.activeShare}
        busy={shareDialog.busy}
        copied={shareDialog.copied}
        error={shareDialog.error}
        expiration={shareDialog.expiration}
        file={shareDialog.file}
        link={shareDialog.link}
        open={shareDialog.open}
        shared={shareDialog.shared}
        onCopyLink={shareDialog.onCopyLink}
        onCreateLink={shareDialog.onCreateLink}
        onExpirationChange={shareDialog.onExpirationChange}
        onOpenChange={shareDialog.onOpenChange}
        onRotateLink={shareDialog.onRotateLink}
        onStopSharing={shareDialog.onStopSharing}
      />

      <SaveAsDropboxDialog
        busy={saveAsDropboxDialog.busy}
        error={saveAsDropboxDialog.error}
        open={saveAsDropboxDialog.open}
        value={saveAsDropboxDialog.value}
        onOpenChange={saveAsDropboxDialog.onOpenChange}
        onSubmit={saveAsDropboxDialog.onSubmit}
        onValueChange={saveAsDropboxDialog.onValueChange}
      />

      <WorkspaceCommandPalette
        browserSupported={commandPalette.browserSupported}
        busy={commandPalette.busy}
        canInsertImage={commandPalette.canInsertImage}
        canSaveAs={commandPalette.canSaveAs}
        canSaveAsLocal={commandPalette.canSaveAsLocal}
        disabled={commandPalette.disabled}
        dropboxConnecting={commandPalette.dropboxConnecting}
        selectedPath={commandPalette.selectedPath}
        sidebarOpen={commandPalette.sidebarOpen}
        tree={commandPalette.tree}
        onConnectDropbox={commandPalette.onConnectDropbox}
        onDownloadCopy={commandPalette.onDownloadCopy}
        onInsertImage={commandPalette.onInsertImage}
        onNewDraft={commandPalette.onNewDraft}
        onOpenFolder={commandPalette.onOpenFolder}
        onSaveAsDropbox={commandPalette.onSaveAsDropbox}
        onSaveAsLocal={commandPalette.onSaveAsLocal}
        onSelectFile={commandPalette.onSelectFile}
        onToggleSidebar={commandPalette.onToggleSidebar}
      />

      <DeleteEntryDialog
        busy={deleteDialog.busy}
        target={deleteDialog.target}
        onConfirm={deleteDialog.onConfirm}
        onOpenChange={deleteDialog.onOpenChange}
      />
    </>
  );
}
