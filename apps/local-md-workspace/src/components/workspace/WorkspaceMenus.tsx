import type { ComponentProps } from "react";
import {
  CloudIcon,
  DownloadIcon,
  EllipsisIcon,
  FolderOpenIcon,
  ImagePlusIcon,
  PrinterIcon,
  SaveIcon,
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

type SaveAsMenuProps = {
  busy: boolean;
  canSaveToDevice: boolean;
  onDownloadCopy: () => void;
  onSaveToDevice: () => void;
  onSaveToDropbox: () => void;
};

export function SaveAsMenu({
  busy,
  canSaveToDevice,
  onDownloadCopy,
  onSaveToDevice,
  onSaveToDropbox,
}: SaveAsMenuProps) {
  let { t } = useI18n();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={busy} size="sm">
          <SaveIcon data-icon="inline-start" />
          {t("actions.saveAs")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48" sideOffset={8}>
        <DropdownMenuGroup>
          <WorkspaceDropdownItem disabled={!canSaveToDevice || busy} onSelect={onSaveToDevice}>
            <FolderOpenIcon />
            {t("storage.thisDevice")}
          </WorkspaceDropdownItem>
          <WorkspaceDropdownItem disabled={busy} onSelect={onSaveToDropbox}>
            <CloudIcon />
            Dropbox
          </WorkspaceDropdownItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <WorkspaceDropdownItem disabled={busy} onSelect={onDownloadCopy}>
            <DownloadIcon />
            {t("actions.downloadCopy")}
          </WorkspaceDropdownItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type WorkspaceDocumentActionsMenuProps = {
  activeShare: boolean;
  busy: boolean;
  canExport: boolean;
  canInsertImage: boolean;
  canShare: boolean;
  className?: string;
  onExportHtml: () => void;
  onPrintPdf: () => void;
  onInsertImage: () => void;
  onShareFile: () => void;
};

export function WorkspaceDocumentActionsMenu({
  activeShare,
  busy,
  canExport,
  canInsertImage,
  canShare,
  className,
  onExportHtml,
  onPrintPdf,
  onInsertImage,
  onShareFile,
}: WorkspaceDocumentActionsMenuProps) {
  let { t } = useI18n();
  let disabled = busy || (!canShare && !canInsertImage && !canExport);

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
