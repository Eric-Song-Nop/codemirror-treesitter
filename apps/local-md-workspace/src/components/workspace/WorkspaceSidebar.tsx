import { CloudIcon, FolderOpenIcon, LanguagesIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import {
  FileTree,
  type FileTreeCreateKind,
  type FileTreeDeleteTarget,
} from "@/components/FileTree";
import { GroveMark } from "@/components/GroveMark";
import { ThemeSelector } from "@/components/ThemeSelector";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MarkdownDirectoryNode, MarkdownFileNode } from "@/lib/workspace-tree";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { githubRepositoryUrl } from "@/lib/workspace/constants";
import { GitHubIcon } from "./GitHubIcon";
import { TooltipIconButton } from "./TooltipIconButton";
import { WorkspaceLauncher } from "./WorkspaceLauncher";

type WorkspaceSidebarProps = {
  browserSupported: boolean;
  busy: boolean;
  canRefresh: boolean;
  dropboxConnecting: boolean;
  dropboxRestoreAvailable: boolean;
  languageToggleLabel: string;
  open: boolean;
  restoreAvailable: boolean;
  restoreChecking: boolean;
  rootName: string;
  selectedPath: string | null;
  tree: MarkdownDirectoryNode | null;
  workspaceOpen: boolean;
  onCreateEntry: (target?: FileTreeDeleteTarget | null, kind?: FileTreeCreateKind) => void;
  onDeleteEntry: (target: FileTreeDeleteTarget) => void;
  onLoadDirectory: (path: string) => Promise<void>;
  onOpenDropbox: () => void;
  onOpenFolder: () => void;
  onRefresh: () => void;
  onRenameEntry: (target?: FileTreeDeleteTarget) => void;
  onRestoreDropbox: () => void;
  onRestoreFolder: () => void;
  onSelectEntry: (target: FileTreeDeleteTarget | null) => void;
  onSelectFile: (file: MarkdownFileNode) => void;
  onToggleLanguage: () => void;
};

export function WorkspaceSidebar({
  browserSupported,
  busy,
  canRefresh,
  dropboxConnecting,
  dropboxRestoreAvailable,
  languageToggleLabel,
  open,
  restoreAvailable,
  restoreChecking,
  rootName,
  selectedPath,
  tree,
  workspaceOpen,
  onCreateEntry,
  onDeleteEntry,
  onLoadDirectory,
  onOpenDropbox,
  onOpenFolder,
  onRefresh,
  onRenameEntry,
  onRestoreDropbox,
  onRestoreFolder,
  onSelectEntry,
  onSelectFile,
  onToggleLanguage,
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
          onLoadDirectory={onLoadDirectory}
          onRenameEntry={onRenameEntry}
          onSelectEntry={onSelectEntry}
          onSelectFile={onSelectFile}
        />
      ) : workspaceOpen && busy ? (
        <WorkspaceTreeSkeleton label={t("workspace.loadingTree")} />
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
      <WorkspaceSidebarUtilityBar
        busy={busy}
        canRefresh={canRefresh}
        languageToggleLabel={languageToggleLabel}
        onRefresh={onRefresh}
        onToggleLanguage={onToggleLanguage}
      />
    </aside>
  );
}

function WorkspaceTreeSkeleton({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex h-8 items-center gap-2 text-xs text-sidebar-foreground/70">
        <Spinner aria-hidden className="size-3" />
        <span>{label}</span>
      </div>
      {Array.from({ length: 10 }, (_, index) => (
        <Skeleton
          key={index}
          className={cn(
            "h-5",
            index % 3 == 0 ? "w-3/5" : index % 3 == 1 ? "ml-4 w-4/5" : "ml-8 w-1/2",
          )}
        />
      ))}
    </div>
  );
}

type WorkspaceSidebarUtilityBarProps = {
  busy: boolean;
  canRefresh: boolean;
  languageToggleLabel: string;
  onRefresh: () => void;
  onToggleLanguage: () => void;
};

function WorkspaceSidebarUtilityBar({
  busy,
  canRefresh,
  languageToggleLabel,
  onRefresh,
  onToggleLanguage,
}: WorkspaceSidebarUtilityBarProps) {
  let { t } = useI18n();

  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border p-2">
      <ThemeSelector menuAlign="start" />
      <TooltipIconButton
        label={languageToggleLabel}
        size="icon-sm"
        variant="ghost"
        onClick={onToggleLanguage}
      >
        <LanguagesIcon data-icon="inline-start" />
      </TooltipIconButton>
      <TooltipIconButton
        label={t("actions.refresh")}
        size="icon-sm"
        variant="ghost"
        disabled={!canRefresh || busy}
        onClick={onRefresh}
      >
        <RefreshCwIcon data-icon="inline-start" />
      </TooltipIconButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild className="ml-auto" size="icon-sm" variant="ghost">
            <a
              aria-label={t("actions.openGitHubRepository")}
              href={githubRepositoryUrl}
              rel="noreferrer"
              target="_blank"
            >
              <GitHubIcon data-icon="inline-start" />
              <span className="sr-only">{t("actions.gitHubRepository")}</span>
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("actions.gitHubRepository")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
