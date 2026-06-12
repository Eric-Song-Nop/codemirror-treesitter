import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Command as CommandPrimitive } from "cmdk";
import {
  CheckIcon,
  CloudIcon,
  FileTextIcon,
  FolderOpenIcon,
  ImagePlusIcon,
  SearchIcon,
  SidebarCloseIcon,
  SidebarOpenIcon,
  type LucideProps,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MarkdownFileNode } from "@/lib/workspace-backend";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type WorkspaceCommandPaletteProps = {
  browserSupported: boolean;
  busy: boolean;
  canInsertImage: boolean;
  disabled?: boolean;
  dropboxConnecting: boolean;
  files: MarkdownFileNode[];
  selectedPath: string | null;
  sidebarOpen: boolean;
  onConnectDropbox: () => void;
  onInsertImage: () => void;
  onOpenFolder: () => void;
  onSelectFile: (file: MarkdownFileNode) => void;
  onToggleSidebar: () => void;
};

type PaletteAction = {
  detail: string;
  disabled?: boolean;
  icon: ComponentType<LucideProps>;
  id: string;
  keywords: string[];
  title: string;
  onSelect: () => void;
};

export function WorkspaceCommandPalette({
  browserSupported,
  busy,
  canInsertImage,
  disabled = false,
  dropboxConnecting,
  files,
  selectedPath,
  sidebarOpen,
  onConnectDropbox,
  onInsertImage,
  onOpenFolder,
  onSelectFile,
  onToggleSidebar,
}: WorkspaceCommandPaletteProps) {
  let { t } = useI18n();
  let [open, setOpen] = useState(false);

  useEffect(() => {
    let handleKeyDown = (event: KeyboardEvent) => {
      if (disabled) return;
      if (event.key.toLowerCase() != "p" || !event.shiftKey) return;
      if (!event.metaKey && !event.ctrlKey) return;

      event.preventDefault();
      setOpen((current) => !current);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [disabled]);

  let actions = useMemo<PaletteAction[]>(
    () => [
      {
        detail: busy
          ? t("command.openFolder.detail.busy")
          : browserSupported
            ? t("command.openFolder.detail.ready")
            : t("command.openFolder.detail.unavailable"),
        disabled: busy || !browserSupported,
        icon: FolderOpenIcon,
        id: "open-folder",
        keywords: t("command.openFolder.keywords").split(/\s+/),
        title: t("actions.openFolder"),
        onSelect: onOpenFolder,
      },
      {
        detail: dropboxConnecting
          ? t("command.connectDropbox.detail.connecting")
          : busy
            ? t("command.connectDropbox.detail.busy")
            : t("command.connectDropbox.detail.ready"),
        disabled: busy || dropboxConnecting,
        icon: CloudIcon,
        id: "connect-dropbox",
        keywords: t("command.connectDropbox.keywords").split(/\s+/),
        title: t("actions.connectDropbox"),
        onSelect: onConnectDropbox,
      },
      {
        detail: sidebarOpen
          ? t("command.toggleSidebar.detail.hide")
          : t("command.toggleSidebar.detail.show"),
        icon: sidebarOpen ? SidebarCloseIcon : SidebarOpenIcon,
        id: "toggle-sidebar",
        keywords: t("command.toggleSidebar.keywords").split(/\s+/),
        title: t("command.toggleSidebar.title"),
        onSelect: onToggleSidebar,
      },
      {
        detail: busy
          ? t("command.insertImage.detail.busy")
          : canInsertImage
            ? t("command.insertImage.detail.ready")
            : t("command.insertImage.detail.unavailable"),
        disabled: busy || !canInsertImage,
        icon: ImagePlusIcon,
        id: "insert-image",
        keywords: t("command.insertImage.keywords").split(/\s+/),
        title: t("actions.insertImage"),
        onSelect: onInsertImage,
      },
    ],
    [
      browserSupported,
      busy,
      canInsertImage,
      dropboxConnecting,
      onConnectDropbox,
      onInsertImage,
      onOpenFolder,
      onToggleSidebar,
      sidebarOpen,
      t,
    ],
  );

  let runCommand = (action: () => void) => {
    setOpen(false);
    action();
  };
  let showFileCommands = open && files.length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="top-[18svh] translate-y-0 overflow-hidden p-0 sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("command.title")}</DialogTitle>
          <DialogDescription>{t("command.searchDescription")}</DialogDescription>
        </DialogHeader>
        <CommandPrimitive
          label={t("command.label")}
          className="flex max-h-[min(640px,72svh)] min-h-0 flex-col overflow-hidden bg-popover text-popover-foreground"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3 text-muted-foreground [&_svg:not([class*='size-'])]:size-4">
            <SearchIcon />
            <CommandPrimitive.Input
              autoFocus
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              placeholder={t("command.placeholder")}
            />
          </div>
          <CommandPrimitive.List className="max-h-[calc(min(640px,72svh)-2.75rem)] min-h-0 overflow-y-auto p-1">
            <CommandPrimitive.Empty className="py-8 text-center text-sm text-muted-foreground">
              {t("command.empty")}
            </CommandPrimitive.Empty>

            {showFileCommands && (
              <CommandPrimitive.Group
                heading={t("command.files")}
                className="overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {files.map((file) => (
                  <CommandItem
                    key={file.path}
                    active={file.path == selectedPath}
                    detail={file.path}
                    icon={FileTextIcon}
                    keywords={[file.path, file.name]}
                    title={file.name}
                    value={`file ${file.name} ${file.path}`}
                    onSelect={() => runCommand(() => onSelectFile(file))}
                  />
                ))}
              </CommandPrimitive.Group>
            )}

            <CommandPrimitive.Group
              heading={t("command.workspace")}
              className="overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              {actions.map((action) => (
                <CommandItem
                  key={action.id}
                  detail={action.detail}
                  disabled={action.disabled}
                  icon={action.icon}
                  keywords={action.keywords}
                  title={action.title}
                  value={`${action.title} ${action.detail} ${action.keywords.join(" ")}`}
                  onSelect={() => runCommand(action.onSelect)}
                />
              ))}
            </CommandPrimitive.Group>
          </CommandPrimitive.List>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}

type CommandItemProps = {
  active?: boolean;
  detail: string;
  disabled?: boolean;
  icon: ComponentType<LucideProps>;
  keywords: string[];
  title: string;
  value: string;
  onSelect: () => void;
};

function CommandItem({
  active = false,
  detail,
  disabled,
  icon: Icon,
  keywords,
  title,
  value,
  onSelect,
}: CommandItemProps) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "group flex min-h-11 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45 data-[selected=true]:bg-muted data-[selected=true]:text-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
        active && "bg-muted/60",
      )}
      disabled={disabled}
      keywords={keywords}
      value={value}
      onSelect={onSelect}
    >
      <Icon className="text-muted-foreground group-data-[selected=true]:text-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      {active && <CheckIcon className="text-primary" />}
    </CommandPrimitive.Item>
  );
}
