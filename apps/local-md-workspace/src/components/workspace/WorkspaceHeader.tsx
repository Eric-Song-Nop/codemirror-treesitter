import { MenuIcon, SaveIcon, Share2Icon, SparklesIcon } from "lucide-react";
import type { Ref } from "react";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n";
import type { SaveState } from "@/lib/workspace/types";
import { WorkspaceDocumentActionsMenu } from "./WorkspaceMenus";
import { TooltipIconButton } from "./TooltipIconButton";

type WorkspaceHeaderProps = {
  activeShare: boolean;
  agentButtonRef?: Ref<HTMLButtonElement>;
  agentOpen: boolean;
  busy: boolean;
  canExport: boolean;
  canInsertImage: boolean;
  canSaveAs: boolean;
  canSaveToDevice: boolean;
  canShare: boolean;
  dropboxConnecting: boolean;
  saveLabel: string;
  saveState: SaveState;
  sidebarOpen: boolean;
  subtitle: string;
  title: string;
  onDownloadCopy: () => void;
  onExportHtml: () => void;
  onInsertImage: () => void;
  onPrintPdf: () => void;
  onSaveAsDropbox: () => void;
  onSaveAsLocal: () => void;
  onShareFile: () => void;
  onToggleSidebar: () => void;
  onToggleAgent: () => void;
};

export function WorkspaceHeader({
  activeShare,
  agentButtonRef,
  agentOpen,
  busy,
  canExport,
  canInsertImage,
  canSaveAs,
  canSaveToDevice,
  canShare,
  dropboxConnecting,
  saveLabel,
  saveState,
  sidebarOpen,
  subtitle,
  title,
  onDownloadCopy,
  onExportHtml,
  onInsertImage,
  onPrintPdf,
  onSaveAsDropbox,
  onSaveAsLocal,
  onShareFile,
  onToggleSidebar,
  onToggleAgent,
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
      <TooltipIconButton
        ref={agentButtonRef}
        aria-controls="workspace-agent-panel"
        aria-expanded={agentOpen}
        label={agentOpen ? t("agent.actions.hide") : t("agent.actions.show")}
        size="icon-sm"
        variant={agentOpen ? "secondary" : "ghost"}
        onClick={onToggleAgent}
      >
        <SparklesIcon />
      </TooltipIconButton>
      <WorkspaceDocumentActionsMenu
        activeShare={activeShare}
        busy={busy}
        canInsertImage={canInsertImage}
        canExport={canExport}
        canSaveAs={canSaveAs}
        canSaveToDevice={canSaveToDevice}
        canShare={canShare}
        dropboxConnecting={dropboxConnecting}
        onDownloadCopy={onDownloadCopy}
        onExportHtml={onExportHtml}
        onPrintPdf={onPrintPdf}
        onInsertImage={onInsertImage}
        onSaveToDevice={onSaveAsLocal}
        onSaveToDropbox={onSaveAsDropbox}
        onShareFile={onShareFile}
      />
    </header>
  );
}
