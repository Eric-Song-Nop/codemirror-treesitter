import { CloudIcon, FolderOpenIcon, PlusIcon } from "lucide-react";
import {
  FileTree,
  type FileTreeCreateKind,
  type FileTreeDeleteTarget,
} from "@/components/FileTree";
import { GroveMark } from "@/components/GroveMark";
import type { MarkdownDirectoryNode, MarkdownFileNode } from "@/lib/workspace-backend";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { TooltipIconButton } from "./TooltipIconButton";
import { WorkspaceLauncher } from "./WorkspaceLauncher";

type WorkspaceSidebarProps = {
  browserSupported: boolean;
  busy: boolean;
  dropboxConnecting: boolean;
  dropboxRestoreAvailable: boolean;
  open: boolean;
  restoreAvailable: boolean;
  restoreChecking: boolean;
  rootName: string;
  selectedPath: string | null;
  tree: MarkdownDirectoryNode | null;
  workspaceOpen: boolean;
  onCreateEntry: (target?: FileTreeDeleteTarget | null, kind?: FileTreeCreateKind) => void;
  onDeleteEntry: (target: FileTreeDeleteTarget) => void;
  onOpenDropbox: () => void;
  onOpenFolder: () => void;
  onRenameEntry: (target?: FileTreeDeleteTarget) => void;
  onRestoreDropbox: () => void;
  onRestoreFolder: () => void;
  onSelectEntry: (target: FileTreeDeleteTarget | null) => void;
  onSelectFile: (file: MarkdownFileNode) => void;
};

export function WorkspaceSidebar({
  browserSupported,
  busy,
  dropboxConnecting,
  dropboxRestoreAvailable,
  open,
  restoreAvailable,
  restoreChecking,
  rootName,
  selectedPath,
  tree,
  workspaceOpen,
  onCreateEntry,
  onDeleteEntry,
  onOpenDropbox,
  onOpenFolder,
  onRenameEntry,
  onRestoreDropbox,
  onRestoreFolder,
  onSelectEntry,
  onSelectFile,
}: WorkspaceSidebarProps) {
  let { t } = useI18n();

  return (
    <aside
      className={cn(
        "flex w-[19rem] shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:w-[min(21rem,88vw)]",
        !open && "hidden",
      )}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <GroveMark className="size-8" decorative />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{rootName}</div>
        </div>
        <TooltipIconButton
          label={t("actions.openFolder")}
          size="icon-sm"
          variant="ghost"
          onClick={onOpenFolder}
          disabled={busy}
        >
          <FolderOpenIcon data-icon="inline-start" />
        </TooltipIconButton>
        <TooltipIconButton
          label={t("actions.connectDropbox")}
          size="icon-sm"
          variant="ghost"
          onClick={onOpenDropbox}
          disabled={busy || dropboxConnecting}
        >
          <CloudIcon data-icon="inline-start" />
        </TooltipIconButton>
        <TooltipIconButton
          label={t("actions.newFile")}
          size="icon-sm"
          variant="ghost"
          onClick={() => onCreateEntry()}
          disabled={!workspaceOpen || busy}
        >
          <PlusIcon data-icon="inline-start" />
        </TooltipIconButton>
      </div>
      {tree ? (
        <FileTree
          root={tree}
          selectedPath={selectedPath}
          onCreateEntry={onCreateEntry}
          onDeleteEntry={onDeleteEntry}
          onRenameEntry={onRenameEntry}
          onSelectEntry={onSelectEntry}
          onSelectFile={onSelectFile}
        />
      ) : (
        <WorkspaceLauncher
          browserSupported={browserSupported}
          busy={busy}
          dropboxConnecting={dropboxConnecting}
          dropboxRestoreAvailable={dropboxRestoreAvailable}
          restoreAvailable={restoreAvailable}
          restoreChecking={restoreChecking}
          onOpenDropbox={onOpenDropbox}
          onOpenFolder={onOpenFolder}
          onRestoreDropbox={onRestoreDropbox}
          onRestoreFolder={onRestoreFolder}
        />
      )}
    </aside>
  );
}
