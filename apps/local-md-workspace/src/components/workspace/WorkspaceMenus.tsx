import type { ComponentProps } from "react";
import {
  CloudIcon,
  DownloadIcon,
  EllipsisIcon,
  FolderOpenIcon,
  ImagePlusIcon,
  PrinterIcon,
  Share2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type WorkspaceDocumentActionsMenuProps = {
  activeShare: boolean;
  busy: boolean;
  canExport: boolean;
  canInsertImage: boolean;
  canSaveAs: boolean;
  canSaveToDevice: boolean;
  canShare: boolean;
  className?: string;
  dropboxConnecting: boolean;
  onDownloadCopy: () => void;
  onExportHtml: () => void;
  onPrintPdf: () => void;
  onInsertImage: () => void;
  onSaveToDevice: () => void;
  onSaveToDropbox: () => void;
  onShareFile: () => void;
};

export function WorkspaceDocumentActionsMenu({
  activeShare,
  busy,
  canExport,
  canInsertImage,
  canSaveAs,
  canSaveToDevice,
  canShare,
  className,
  dropboxConnecting,
  onDownloadCopy,
  onExportHtml,
  onPrintPdf,
  onInsertImage,
  onSaveToDevice,
  onSaveToDropbox,
  onShareFile,
}: WorkspaceDocumentActionsMenuProps) {
  let { t } = useI18n();
  let disabled = busy || (!canSaveAs && !canShare && !canInsertImage && !canExport);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t("actions.moreActions")}
          className={className}
          disabled={disabled}
          size="icon-sm"
          variant="ghost"
        >
          <EllipsisIcon data-icon="inline-start" />
          <span className="sr-only">{t("actions.moreActions")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56" sideOffset={8}>
        {canSaveAs && (
          <>
            <DropdownMenuLabel>{t("actions.saveAs")}</DropdownMenuLabel>
            <DropdownMenuGroup>
              <WorkspaceDropdownItem disabled={!canSaveToDevice || busy} onSelect={onSaveToDevice}>
                <FolderOpenIcon />
                {t("storage.thisDevice")}
              </WorkspaceDropdownItem>
              <WorkspaceDropdownItem
                disabled={busy || dropboxConnecting}
                onSelect={onSaveToDropbox}
              >
                <CloudIcon />
                Dropbox
              </WorkspaceDropdownItem>
              <WorkspaceDropdownItem disabled={busy} onSelect={onDownloadCopy}>
                <DownloadIcon />
                {t("actions.downloadCopy")}
              </WorkspaceDropdownItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        {activeShare && (
          <>
            <DropdownMenuLabel className="flex min-w-0 items-center gap-2">
              <Share2Icon data-icon="inline-start" />
              <span className="truncate">{t("workspace.sharedFileBadge")}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup>
          <WorkspaceDropdownItem disabled={!canShare || busy} onSelect={onShareFile}>
            <Share2Icon />
            {t("actions.shareFile")}
          </WorkspaceDropdownItem>
          <WorkspaceDropdownItem disabled={!canInsertImage || busy} onSelect={onInsertImage}>
            <ImagePlusIcon />
            {t("actions.insertImage")}
          </WorkspaceDropdownItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <WorkspaceDropdownItem disabled={!canExport || busy} onSelect={onExportHtml}>
            <DownloadIcon />
            {t("actions.exportHtml")}
          </WorkspaceDropdownItem>
          <WorkspaceDropdownItem disabled={!canExport || busy} onSelect={onPrintPdf}>
            <PrinterIcon />
            {t("actions.printPdf")}
          </WorkspaceDropdownItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const workspaceDropdownItemClassName = "min-h-9 px-2.5 py-2";

function WorkspaceDropdownItem({ className, ...props }: ComponentProps<typeof DropdownMenuItem>) {
  return <DropdownMenuItem className={cn(workspaceDropdownItemClassName, className)} {...props} />;
}
