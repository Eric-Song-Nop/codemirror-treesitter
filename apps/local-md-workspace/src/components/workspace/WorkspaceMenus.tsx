import type { ComponentProps } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import {
  CloudIcon,
  DownloadIcon,
  EllipsisIcon,
  FolderOpenIcon,
  ImagePlusIcon,
  LanguagesIcon,
  PrinterIcon,
  RefreshCwIcon,
  SaveIcon,
  Share2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeDropdownSubmenu } from "@/components/ThemeSelector";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { githubRepositoryUrl } from "@/lib/workspace/constants";
import { GitHubIcon } from "./GitHubIcon";

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
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button disabled={busy} size="sm">
          <SaveIcon data-icon="inline-start" />
          {t("actions.saveAs")}
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={8}
          className="z-50 flex min-w-48 max-w-[calc(100vw-1rem)] flex-col gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-in-95"
        >
          <MobileDropdownItem disabled={!canSaveToDevice || busy} onSelect={onSaveToDevice}>
            <FolderOpenIcon />
            {t("storage.thisDevice")}
          </MobileDropdownItem>
          <MobileDropdownItem disabled={busy} onSelect={onSaveToDropbox}>
            <CloudIcon />
            Dropbox
          </MobileDropdownItem>
          <DropdownMenuPrimitive.Separator className="-mx-1 h-px bg-border" />
          <MobileDropdownItem disabled={busy} onSelect={onDownloadCopy}>
            <DownloadIcon />
            {t("actions.downloadCopy")}
          </MobileDropdownItem>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

type MobileWorkspaceActionsProps = {
  activeShare: boolean;
  busy: boolean;
  canExport: boolean;
  canInsertImage: boolean;
  canRefresh: boolean;
  canShare: boolean;
  languageToggleLabel: string;
  onExportHtml: () => void;
  onPrintPdf: () => void;
  onInsertImage: () => void;
  onRefresh: () => void;
  onShareFile: () => void;
  onToggleLanguage: () => void;
};

export function MobileWorkspaceActions({
  activeShare,
  busy,
  canExport,
  canInsertImage,
  canRefresh,
  canShare,
  languageToggleLabel,
  onExportHtml,
  onPrintPdf,
  onInsertImage,
  onRefresh,
  onShareFile,
  onToggleLanguage,
}: MobileWorkspaceActionsProps) {
  let { t } = useI18n();

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button
          aria-label={t("actions.moreActions")}
          className="md:hidden"
          size="icon-sm"
          variant="ghost"
        >
          <EllipsisIcon data-icon="inline-start" />
          <span className="sr-only">{t("actions.moreActions")}</span>
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={8}
          className="z-50 flex min-w-56 max-w-[calc(100vw-1rem)] flex-col gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          {activeShare && (
            <>
              <div className="flex flex-col gap-1 px-2 py-1.5 text-xs text-muted-foreground">
                <div className="flex min-w-0 items-center gap-2">
                  <Share2Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{t("workspace.sharedFileBadge")}</span>
                </div>
              </div>
              <DropdownMenuPrimitive.Separator className="-mx-1 h-px bg-border" />
            </>
          )}
          <MobileDropdownItem disabled={!canShare || busy} onSelect={onShareFile}>
            <Share2Icon />
            {t("actions.shareFile")}
          </MobileDropdownItem>
          <MobileDropdownItem disabled={!canInsertImage || busy} onSelect={onInsertImage}>
            <ImagePlusIcon />
            {t("actions.insertImage")}
          </MobileDropdownItem>
          <MobileDropdownItem disabled={!canExport || busy} onSelect={onExportHtml}>
            <DownloadIcon />
            {t("actions.exportHtml")}
          </MobileDropdownItem>
          <MobileDropdownItem disabled={!canExport || busy} onSelect={onPrintPdf}>
            <PrinterIcon />
            {t("actions.printPdf")}
          </MobileDropdownItem>
          <MobileDropdownItem disabled={!canRefresh || busy} onSelect={onRefresh}>
            <RefreshCwIcon />
            {t("actions.refresh")}
          </MobileDropdownItem>
          <MobileDropdownItem onSelect={onToggleLanguage}>
            <LanguagesIcon />
            {languageToggleLabel}
          </MobileDropdownItem>
          <ThemeDropdownSubmenu itemClassName={mobileDropdownItemClassName} />
          <DropdownMenuPrimitive.Separator className="-mx-1 h-px bg-border" />
          <DropdownMenuPrimitive.Item asChild>
            <a
              aria-label={t("actions.openGitHubRepository")}
              className={mobileDropdownItemClassName}
              href={githubRepositoryUrl}
              rel="noreferrer"
              target="_blank"
            >
              <GitHubIcon data-icon="inline-start" />
              {t("actions.gitHubRepository")}
            </a>
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

const mobileDropdownItemClassName =
  "flex min-h-10 cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-muted data-[highlighted]:text-foreground [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

function MobileDropdownItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item className={cn(mobileDropdownItemClassName, className)} {...props} />
  );
}
