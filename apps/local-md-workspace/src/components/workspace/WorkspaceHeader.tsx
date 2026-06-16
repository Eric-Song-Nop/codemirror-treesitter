import { MenuIcon, SaveIcon, Share2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n";
import type { SaveState } from "@/lib/workspace/types";
import { WorkspaceDocumentActionsMenu } from "./WorkspaceMenus";
import { TooltipIconButton } from "./TooltipIconButton";

type WorkspaceHeaderProps = {
  activeShare: boolean;
  busy: boolean;
  canExport: boolean;
  canInsertImage: boolean;
  canSaveAs: boolean;
  canSaveToDevice: boolean;
  canShare: boolean;
  dropboxConnecting: boolean;
  googleDriveConnecting: boolean;
  oneDriveConnecting: boolean;
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
  onSaveAsGoogleDrive: () => void;
  onSaveAsOneDrive: () => void;
  onSaveAsLocal: () => void;
  onShareFile: () => void;
  onToggleSidebar: () => void;
};

export function WorkspaceHeader({
  activeShare,
  busy,
  canExport,
  canInsertImage,
  canSaveAs,
  canSaveToDevice,
  canShare,
  dropboxConnecting,
  googleDriveConnecting,
  oneDriveConnecting,
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
  onSaveAsGoogleDrive,
  onSaveAsOneDrive,
  onSaveAsLocal,
  onShareFile,
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
      <WorkspaceDocumentActionsMenu
        activeShare={activeShare}
        busy={busy}
        canInsertImage={canInsertImage}
        canExport={canExport}
        canSaveAs={canSaveAs}
        canSaveToDevice={canSaveToDevice}
        canShare={canShare}
        dropboxConnecting={dropboxConnecting}
        googleDriveConnecting={googleDriveConnecting}
        oneDriveConnecting={oneDriveConnecting}
        onDownloadCopy={onDownloadCopy}
        onExportHtml={onExportHtml}
        onPrintPdf={onPrintPdf}
        onInsertImage={onInsertImage}
        onSaveToDevice={onSaveAsLocal}
        onSaveToDropbox={onSaveAsDropbox}
        onSaveToGoogleDrive={onSaveAsGoogleDrive}
        onSaveToOneDrive={onSaveAsOneDrive}
        onShareFile={onShareFile}
      />
    </header>
  );
}
