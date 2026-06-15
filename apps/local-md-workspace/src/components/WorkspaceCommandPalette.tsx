import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Command as CommandPrimitive } from "cmdk";
import {
  CheckIcon,
  CloudIcon,
  DownloadIcon,
  FileTextIcon,
  FolderOpenIcon,
  ImagePlusIcon,
  MoonIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  SidebarCloseIcon,
  SidebarOpenIcon,
  SunIcon,
  type LucideProps,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  flattenMarkdownFiles,
  type MarkdownDirectoryNode,
  type MarkdownFileNode,
} from "@/lib/workspace-backend";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { themeDefinitions, useTheme } from "@/theme";

type WorkspaceCommandPaletteProps = {
  browserSupported: boolean;
  busy: boolean;
  canInsertImage: boolean;
  canSaveAs: boolean;
  canSaveAsLocal: boolean;
  disabled?: boolean;
  dropboxConnecting: boolean;
  oneDriveConnecting: boolean;
  selectedPath: string | null;
  sidebarOpen: boolean;
  tree: MarkdownDirectoryNode | null;
  onConnectDropbox: () => void;
  onConnectOneDrive: () => void;
  onDownloadCopy: () => void;
  onInsertImage: () => void;
  onNewDraft: () => void;
  onOpenFolder: () => void;
  onSaveAsDropbox: () => void;
  onSaveAsOneDrive: () => void;
  onSaveAsLocal: () => void;
  onSelectFile: (file: MarkdownFileNode) => void;
  onToggleSidebar: () => void;
};

type PaletteAction = {
  active?: boolean;
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
  canSaveAs,
  canSaveAsLocal,
  disabled = false,
  dropboxConnecting,
  oneDriveConnecting,
  selectedPath,
  sidebarOpen,
  tree,
  onConnectDropbox,
  onConnectOneDrive,
  onDownloadCopy,
  onInsertImage,
  onNewDraft,
  onOpenFolder,
  onSaveAsDropbox,
  onSaveAsOneDrive,
  onSaveAsLocal,
  onSelectFile,
  onToggleSidebar,
}: WorkspaceCommandPaletteProps) {
  let { t } = useI18n();
  let [open, setOpen] = useState(false);
  let { setTheme, theme } = useTheme();
  let files = useMemo(() => (open && tree ? flattenMarkdownFiles(tree) : []), [open, tree]);

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
        detail: busy ? t("command.newDraft.detail.busy") : t("command.newDraft.detail.ready"),
        disabled: busy,
        icon: PlusIcon,
        id: "new-draft",
        keywords: t("command.newDraft.keywords").split(/\s+/),
        title: t("actions.newDraft"),
        onSelect: onNewDraft,
      },
      {
        detail: canSaveAsLocal
          ? t("command.saveAsLocal.detail.ready")
          : t("command.saveAsLocal.detail.unavailable"),
        disabled: busy || !canSaveAs || !canSaveAsLocal,
        icon: SaveIcon,
        id: "save-as-local",
        keywords: t("command.saveAsLocal.keywords").split(/\s+/),
        title: t("actions.saveAs"),
        onSelect: onSaveAsLocal,
      },
      {
        detail: dropboxConnecting ? t("command.saveAsDropbox.detail.connecting") : "Dropbox",
        disabled: busy || dropboxConnecting || !canSaveAs,
        icon: CloudIcon,
        id: "save-as-dropbox",
        keywords: t("command.saveAsDropbox.keywords").split(/\s+/),
        title: t("actions.saveAsDropbox"),
        onSelect: onSaveAsDropbox,
      },
      {
        detail: oneDriveConnecting ? t("command.saveAsOneDrive.detail.connecting") : "OneDrive",
        disabled: busy || oneDriveConnecting || !canSaveAs,
        icon: CloudIcon,
        id: "save-as-onedrive",
        keywords: t("command.saveAsOneDrive.keywords").split(/\s+/),
        title: t("actions.saveAsOneDrive"),
        onSelect: onSaveAsOneDrive,
      },
      {
        detail: t("command.downloadCopy.detail"),
        disabled: busy || !canSaveAs,
        icon: DownloadIcon,
        id: "download-copy",
        keywords: t("command.downloadCopy.keywords").split(/\s+/),
        title: t("actions.downloadCopy"),
        onSelect: onDownloadCopy,
      },
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
        detail: oneDriveConnecting
          ? t("command.connectOneDrive.detail.connecting")
          : busy
            ? t("command.connectOneDrive.detail.busy")
            : t("command.connectOneDrive.detail.ready"),
        disabled: busy || oneDriveConnecting,
        icon: CloudIcon,
        id: "connect-onedrive",
        keywords: t("command.connectOneDrive.keywords").split(/\s+/),
        title: t("actions.connectOneDrive"),
        onSelect: onConnectOneDrive,
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
      ...themeDefinitions.map((definition) => {
        let active = definition.id == theme;
        let appearanceDetail =
          definition.appearance == "dark"
            ? t("command.theme.detail.dark")
            : t("command.theme.detail.light");
        return {
          active,
          detail: active ? t("command.theme.detail.current") : appearanceDetail,
          icon: definition.appearance == "dark" ? MoonIcon : SunIcon,
          id: `theme-${definition.id}`,
          keywords: [
            ...t("command.theme.keywords").split(/\s+/),
            definition.appearance,
            definition.label,
          ],
          title: active
            ? t("command.theme.title.current", { label: definition.label })
            : t("command.theme.title.use", { label: definition.label }),
          onSelect: () => setTheme(definition.id),
        };
      }),
    ],
    [
      browserSupported,
      busy,
      canInsertImage,
      canSaveAs,
      canSaveAsLocal,
      dropboxConnecting,
      oneDriveConnecting,
      onConnectDropbox,
      onConnectOneDrive,
      onDownloadCopy,
      onInsertImage,
      onNewDraft,
      onOpenFolder,
      onSaveAsDropbox,
      onSaveAsOneDrive,
      onSaveAsLocal,
      onToggleSidebar,
      sidebarOpen,
      setTheme,
      t,
      theme,
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
                  active={action.active}
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
