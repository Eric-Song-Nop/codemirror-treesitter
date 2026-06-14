import {
  DownloadIcon,
  ImagePlusIcon,
  LanguagesIcon,
  MenuIcon,
  PrinterIcon,
  RefreshCwIcon,
  SaveIcon,
  Share2Icon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemeSelector } from "@/components/ThemeSelector";
import { useI18n } from "@/lib/i18n";
import { githubRepositoryUrl } from "@/lib/workspace/constants";
import type { SaveState } from "@/lib/workspace/types";
import { GitHubIcon } from "./GitHubIcon";
import { MobileWorkspaceActions, SaveAsMenu } from "./WorkspaceMenus";
import { TooltipIconButton } from "./TooltipIconButton";

type WorkspaceHeaderProps = {
  activeShare: boolean;
  busy: boolean;
  canExport: boolean;
  canInsertImage: boolean;
  canRefresh: boolean;
  canSaveAs: boolean;
  canSaveToDevice: boolean;
  canShare: boolean;
  dropboxConnecting: boolean;
  languageToggleLabel: string;
  saveLabel: string;
  saveState: SaveState;
  sidebarOpen: boolean;
  subtitle: string;
  title: string;
  onDownloadCopy: () => void;
  onExportHtml: () => void;
  onInsertImage: () => void;
  onPrintPdf: () => void;
  onRefresh: () => void;
  onSaveAsDropbox: () => void;
  onSaveAsLocal: () => void;
  onShareFile: () => void;
  onToggleLanguage: () => void;
  onToggleSidebar: () => void;
};

export function WorkspaceHeader({
  activeShare,
  busy,
  canExport,
  canInsertImage,
  canRefresh,
  canSaveAs,
  canSaveToDevice,
  canShare,
  dropboxConnecting,
  languageToggleLabel,
  saveLabel,
  saveState,
  sidebarOpen,
  subtitle,
  title,
  onDownloadCopy,
  onExportHtml,
  onInsertImage,
  onPrintPdf,
  onRefresh,
  onSaveAsDropbox,
  onSaveAsLocal,
  onShareFile,
  onToggleLanguage,
  onToggleSidebar,
}: WorkspaceHeaderProps) {
  let { t } = useI18n();

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <TooltipIconButton
        label={sidebarOpen ? t("actions.hideSidebar") : t("actions.showSidebar")}
        size="icon-sm"
        variant="ghost"
        onClick={onToggleSidebar}
      >
        <MenuIcon data-icon="inline-start" />
      </TooltipIconButton>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      <Badge variant={saveState == "error" ? "destructive" : "secondary"}>
        <SaveIcon data-icon="inline-start" />
        {saveLabel}
      </Badge>
      {activeShare && (
        <Badge className="max-md:hidden" variant="secondary">
          <Share2Icon data-icon="inline-start" />
          {t("workspace.sharedFileBadge")}
        </Badge>
      )}
      <ThemeSelector className="max-md:hidden" />
      {canSaveAs && (
        <SaveAsMenu
          busy={busy || dropboxConnecting}
          canSaveToDevice={canSaveToDevice}
          onDownloadCopy={onDownloadCopy}
          onSaveToDevice={onSaveAsLocal}
          onSaveToDropbox={onSaveAsDropbox}
        />
      )}
      <TooltipIconButton
        className="max-md:hidden"
        label={t("actions.shareFile")}
        size="icon-sm"
        variant="ghost"
        disabled={!canShare || busy}
        onClick={onShareFile}
      >
        <Share2Icon data-icon="inline-start" />
      </TooltipIconButton>
      <TooltipIconButton
        className="max-md:hidden"
        label={t("actions.insertImage")}
        size="icon-sm"
        variant="ghost"
        disabled={!canInsertImage || busy}
        onClick={onInsertImage}
      >
        <ImagePlusIcon data-icon="inline-start" />
      </TooltipIconButton>
      <TooltipIconButton
        className="max-md:hidden"
        label={t("actions.exportHtml")}
        size="icon-sm"
        variant="ghost"
        disabled={!canExport || busy}
        onClick={onExportHtml}
      >
        <DownloadIcon data-icon="inline-start" />
      </TooltipIconButton>
      <TooltipIconButton
        className="max-md:hidden"
        label={t("actions.printPdf")}
        size="icon-sm"
        variant="ghost"
        disabled={!canExport || busy}
        onClick={onPrintPdf}
      >
        <PrinterIcon data-icon="inline-start" />
      </TooltipIconButton>
      <TooltipIconButton
        className="max-md:hidden"
        label={t("actions.refresh")}
        size="icon-sm"
        variant="ghost"
        disabled={!canRefresh || busy}
        onClick={onRefresh}
      >
        <RefreshCwIcon data-icon="inline-start" />
      </TooltipIconButton>
      <MobileWorkspaceActions
        activeShare={activeShare}
        busy={busy}
        canInsertImage={canInsertImage}
        canRefresh={canRefresh}
        canExport={canExport}
        canShare={canShare}
        languageToggleLabel={languageToggleLabel}
        onExportHtml={onExportHtml}
        onPrintPdf={onPrintPdf}
        onInsertImage={onInsertImage}
        onToggleLanguage={onToggleLanguage}
        onRefresh={onRefresh}
        onShareFile={onShareFile}
      />
      <TooltipIconButton
        className="max-md:hidden"
        label={languageToggleLabel}
        size="icon-sm"
        variant="ghost"
        onClick={onToggleLanguage}
      >
        <LanguagesIcon data-icon="inline-start" />
      </TooltipIconButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild className="max-md:hidden" size="icon-sm" variant="ghost">
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
    </header>
  );
}
