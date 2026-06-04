import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  FolderOpenIcon,
  MenuIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { FileTree } from "@/components/FileTree";
import { LiveMdEditor } from "@/components/LiveMdEditor";
import {
  createMarkdownFile,
  deleteMarkdownFile,
  ensureReadWritePermission,
  flattenMarkdownFiles,
  pickWorkspaceDirectory,
  readMarkdownFile,
  readWorkspaceTree,
  renameMarkdownFile,
  supportsDirectoryPicker,
  writeMarkdownFile,
  type AccessDirectoryHandle,
  type MarkdownDirectoryNode,
  type MarkdownFileNode,
} from "@/lib/file-system";
import { cn } from "@/lib/utils";

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";
type FileDialogMode = "create" | "rename";

type EditorDocument = {
  path: string;
  value: string;
  version: number;
};

export function App() {
  let [rootHandle, setRootHandle] = useState<AccessDirectoryHandle | null>(null);
  let [tree, setTree] = useState<MarkdownDirectoryNode | null>(null);
  let [files, setFiles] = useState<MarkdownFileNode[]>([]);
  let [selectedFile, setSelectedFile] = useState<MarkdownFileNode | null>(null);
  let [editorDocument, setEditorDocument] = useState<EditorDocument>({
    path: "",
    value: "",
    version: 0,
  });
  let [saveState, setSaveState] = useState<SaveState>("idle");
  let [statusMessage, setStatusMessage] = useState("No folder open");
  let [errorMessage, setErrorMessage] = useState("");
  let [busy, setBusy] = useState(false);
  let [sidebarOpen, setSidebarOpen] = useState(true);
  let [fileDialogMode, setFileDialogMode] = useState<FileDialogMode | null>(null);
  let [fileDialogValue, setFileDialogValue] = useState("");
  let [fileDialogError, setFileDialogError] = useState("");
  let [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  let selectedFileRef = useRef<MarkdownFileNode | null>(null);
  let editorValueRef = useRef("");
  let cleanValueRef = useRef("");
  let dirtyRef = useRef(false);
  let editVersionRef = useRef(0);
  let saveStateRef = useRef<SaveState>("idle");
  let saveTimerRef = useRef<number | null>(null);
  let saveOperationRef = useRef(0);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  let selectedPath = selectedFile?.path ?? null;
  let rootName = tree?.name ?? "Local Markdown";
  let browserSupported = supportsDirectoryPicker();

  let setSaveStateSynced = useCallback((nextState: SaveState) => {
    if (saveStateRef.current == nextState) return;
    saveStateRef.current = nextState;
    setSaveState(nextState);
  }, []);

  let saveCurrentFile = useCallback(async () => {
    let file = selectedFileRef.current;
    if (!file) return true;

    let value = editorValueRef.current;
    let editVersion = editVersionRef.current;
    if (!dirtyRef.current && value == cleanValueRef.current) return true;

    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    if (value == cleanValueRef.current) {
      dirtyRef.current = false;
      setSaveStateSynced("saved");
      setStatusMessage("Saved to disk");
      return true;
    }

    let operation = ++saveOperationRef.current;
    setSaveStateSynced("saving");
    setStatusMessage("Saving");

    try {
      await writeMarkdownFile(file.handle, value);
      if (operation == saveOperationRef.current && selectedFileRef.current?.path == file.path) {
        cleanValueRef.current = value;
        if (editVersion == editVersionRef.current) {
          dirtyRef.current = false;
          setSaveStateSynced("saved");
          setStatusMessage("Saved to disk");
        }
      }
      return true;
    } catch (error) {
      setSaveStateSynced("error");
      setStatusMessage("Save failed");
      setErrorMessage(errorToMessage(error));
      return false;
    }
  }, [setSaveStateSynced]);

  let scheduleAutoSave = useCallback(() => {
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);

    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveCurrentFile();
    }, 650);
  }, [saveCurrentFile]);

  let handleEditorInput = useCallback(
    (value: string) => {
      editorValueRef.current = value;
      editVersionRef.current += 1;
      dirtyRef.current = true;

      if (saveStateRef.current != "pending") {
        setSaveStateSynced("pending");
        setStatusMessage("Unsaved changes");
      }

      scheduleAutoSave();
    },
    [scheduleAutoSave, setSaveStateSynced],
  );

  let loadFile = useCallback(
    async (file: MarkdownFileNode, options: { saveCurrent?: boolean } = {}) => {
      if ((options.saveCurrent ?? true) && !(await saveCurrentFile())) return;

      setBusy(true);
      setErrorMessage("");
      try {
        let value = await readMarkdownFile(file.handle);
        selectedFileRef.current = file;
        editorValueRef.current = value;
        cleanValueRef.current = value;
        dirtyRef.current = false;
        editVersionRef.current = 0;
        setSelectedFile(file);
        setEditorDocument((current) => ({
          path: file.path,
          value,
          version: current.version + 1,
        }));
        setSaveStateSynced("saved");
        setStatusMessage("Saved to disk");
      } catch (error) {
        setErrorMessage(errorToMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [saveCurrentFile, setSaveStateSynced],
  );

  let loadTree = useCallback(
    async (
      handle: AccessDirectoryHandle,
      nextSelectedPath?: null | string,
      options: { saveBeforeSelect?: boolean } = {},
    ) => {
      let nextTree = await readWorkspaceTree(handle);
      let nextFiles = flattenMarkdownFiles(nextTree);
      setTree(nextTree);
      setFiles(nextFiles);

      let nextSelectedFile =
        (nextSelectedPath && nextFiles.find((file) => file.path == nextSelectedPath)) ??
        nextFiles[0] ??
        null;

      if (nextSelectedFile) {
        await loadFile(nextSelectedFile, { saveCurrent: options.saveBeforeSelect ?? true });
      } else {
        selectedFileRef.current = null;
        editorValueRef.current = "";
        cleanValueRef.current = "";
        dirtyRef.current = false;
        editVersionRef.current = 0;
        setSelectedFile(null);
        setEditorDocument((current) => ({
          path: "",
          value: "",
          version: current.version + 1,
        }));
        setSaveStateSynced("idle");
        setStatusMessage("No markdown files");
      }
    },
    [loadFile, setSaveStateSynced],
  );

  let openWorkspace = useCallback(async () => {
    setErrorMessage("");
    if (!supportsDirectoryPicker()) {
      setErrorMessage("Use a Chromium browser on localhost to open a folder.");
      return;
    }

    setBusy(true);
    try {
      let handle = await pickWorkspaceDirectory();
      if (!(await ensureReadWritePermission(handle))) {
        setErrorMessage("Read-write folder permission was not granted.");
        return;
      }
      setRootHandle(handle);
      setSidebarOpen(true);
      await loadTree(handle, null);
    } catch (error) {
      if (!isAbortError(error)) setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [loadTree]);

  let refreshWorkspace = useCallback(async () => {
    if (!rootHandle || !(await saveCurrentFile())) return;

    setBusy(true);
    setErrorMessage("");
    try {
      await loadTree(rootHandle, selectedFileRef.current?.path ?? null);
    } catch (error) {
      setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [loadTree, rootHandle, saveCurrentFile]);

  useEffect(
    () => () => {
      if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );

  let selectFile = useCallback(
    (file: MarkdownFileNode) => {
      void loadFile(file);
    },
    [loadFile],
  );

  let openCreateDialog = () => {
    setFileDialogError("");
    setFileDialogValue(defaultNewFileName(files));
    setFileDialogMode("create");
  };

  let openRenameDialog = () => {
    if (!selectedFile) return;
    setFileDialogError("");
    setFileDialogValue(selectedFile.name);
    setFileDialogMode("rename");
  };

  let closeFileDialog = (open: boolean) => {
    if (!open) {
      setFileDialogMode(null);
      setFileDialogError("");
    }
  };

  let submitFileDialog = async (value: string) => {
    if (!rootHandle || !fileDialogMode) return;
    if (!(await saveCurrentFile())) return;

    setFileDialogError("");
    setBusy(true);
    try {
      let nextPath =
        fileDialogMode == "create"
          ? await createMarkdownFile(rootHandle, value)
          : selectedFile
            ? await renameMarkdownFile(rootHandle, selectedFile, value)
            : null;

      if (!nextPath) return;
      setFileDialogMode(null);
      await loadTree(rootHandle, nextPath);
    } catch (error) {
      setFileDialogError(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  };

  let deleteSelectedFile = async () => {
    if (!rootHandle || !selectedFile) return;

    setBusy(true);
    setErrorMessage("");
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    saveOperationRef.current += 1;
    try {
      await deleteMarkdownFile(rootHandle, selectedFile);
      setDeleteDialogOpen(false);
      await loadTree(rootHandle, null, { saveBeforeSelect: false });
    } catch (error) {
      setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  };

  let saveLabel = useMemo(() => saveStateLabel(saveState, selectedFile), [saveState, selectedFile]);

  return (
    <TooltipProvider>
      <div className="dark flex h-svh min-h-0 overflow-hidden bg-background text-foreground">
        <aside
          className={cn(
            "flex w-[19rem] shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:w-[min(21rem,88vw)]",
            !sidebarOpen && "max-md:hidden",
          )}
        >
          <div className="flex h-12 shrink-0 items-center gap-2 px-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{rootName}</div>
              <div className="truncate text-xs text-sidebar-foreground/55">
                {files.length == 1 ? "1 markdown file" : `${files.length} markdown files`}
              </div>
            </div>
            <TooltipIconButton
              label="Open folder"
              size="icon-sm"
              variant="ghost"
              onClick={() => void openWorkspace()}
              disabled={busy}
            >
              <FolderOpenIcon data-icon="inline-start" />
            </TooltipIconButton>
            <TooltipIconButton
              label="New file"
              size="icon-sm"
              variant="ghost"
              onClick={openCreateDialog}
              disabled={!rootHandle || busy}
            >
              <PlusIcon data-icon="inline-start" />
            </TooltipIconButton>
          </div>
          <Separator />
          {tree ? (
            <FileTree root={tree} selectedPath={selectedPath} onSelectFile={selectFile} />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-4">
              <Button onClick={() => void openWorkspace()} disabled={!browserSupported || busy}>
                <FolderOpenIcon data-icon="inline-start" />
                Open folder
              </Button>
            </div>
          )}
        </aside>

        {sidebarOpen && (
          <button
            type="button"
            aria-label="Close sidebar"
            className="fixed inset-0 z-20 bg-background/70 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <TooltipIconButton
              label="Toggle sidebar"
              size="icon-sm"
              variant="ghost"
              className="md:hidden"
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <MenuIcon data-icon="inline-start" />
            </TooltipIconButton>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {selectedFile?.name ?? "Local Markdown"}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {selectedFile?.path ?? "No folder selected"}
              </div>
            </div>
            <Badge variant={saveState == "error" ? "destructive" : "secondary"}>
              <SaveIcon data-icon="inline-start" />
              {saveLabel}
            </Badge>
            <TooltipIconButton
              label="Refresh"
              size="icon-sm"
              variant="ghost"
              disabled={!rootHandle || busy}
              onClick={() => void refreshWorkspace()}
            >
              <RefreshCwIcon data-icon="inline-start" />
            </TooltipIconButton>
            <TooltipIconButton
              label="Rename file"
              size="icon-sm"
              variant="ghost"
              disabled={!selectedFile || busy}
              onClick={openRenameDialog}
            >
              <PencilIcon data-icon="inline-start" />
            </TooltipIconButton>
            <TooltipIconButton
              label="Delete file"
              size="icon-sm"
              variant="ghost"
              disabled={!selectedFile || busy}
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2Icon data-icon="inline-start" />
            </TooltipIconButton>
          </header>

          {errorMessage && (
            <div className="border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </div>
          )}

          <section className="local-md-editor min-h-0 flex-1">
            {selectedFile ? (
              <LiveMdEditor
                documentKey={`${editorDocument.path}:${editorDocument.version}`}
                initialValue={editorDocument.value}
                placeholder="Start writing..."
                onInput={handleEditorInput}
              />
            ) : (
              <WorkspaceEmpty
                browserSupported={browserSupported}
                hasWorkspace={Boolean(rootHandle)}
                onCreateFile={openCreateDialog}
                onOpenFolder={() => void openWorkspace()}
              />
            )}
          </section>

          <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t px-3 text-xs text-muted-foreground">
            <span className="truncate">{statusMessage}</span>
            <span className="truncate">{selectedFile?.path ?? rootName}</span>
          </footer>
        </main>

        <FileNameDialog
          busy={busy}
          error={fileDialogError}
          mode={fileDialogMode}
          open={fileDialogMode != null}
          value={fileDialogValue}
          onOpenChange={closeFileDialog}
          onSubmit={submitFileDialog}
          onValueChange={setFileDialogValue}
        />

        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <Trash2Icon />
              </AlertDialogMedia>
              <AlertDialogTitle>Delete file?</AlertDialogTitle>
              <AlertDialogDescription>{selectedFile?.path}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void deleteSelectedFile();
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}

type TooltipIconButtonProps = ComponentProps<typeof Button> & {
  label: string;
};

function TooltipIconButton({ children, label, ...props }: TooltipIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button {...props}>
          {children}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

type WorkspaceEmptyProps = {
  browserSupported: boolean;
  hasWorkspace: boolean;
  onCreateFile: () => void;
  onOpenFolder: () => void;
};

function WorkspaceEmpty({
  browserSupported,
  hasWorkspace,
  onCreateFile,
  onOpenFolder,
}: WorkspaceEmptyProps) {
  return (
    <Empty className="h-full rounded-none border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderOpenIcon />
        </EmptyMedia>
        <EmptyTitle>{hasWorkspace ? "No markdown files" : "No folder open"}</EmptyTitle>
        {!browserSupported && (
          <EmptyDescription>File System Access API is unavailable.</EmptyDescription>
        )}
      </EmptyHeader>
      <EmptyContent>
        {hasWorkspace ? (
          <Button onClick={onCreateFile}>
            <PlusIcon data-icon="inline-start" />
            New file
          </Button>
        ) : (
          <Button onClick={onOpenFolder} disabled={!browserSupported}>
            <FolderOpenIcon data-icon="inline-start" />
            Open folder
          </Button>
        )}
      </EmptyContent>
    </Empty>
  );
}

type FileNameDialogProps = {
  busy: boolean;
  error: string;
  mode: FileDialogMode | null;
  open: boolean;
  value: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: string) => Promise<void>;
  onValueChange: (value: string) => void;
};

function FileNameDialog({
  busy,
  error,
  mode,
  open,
  value,
  onOpenChange,
  onSubmit,
  onValueChange,
}: FileNameDialogProps) {
  let inputId = "markdown-file-name";
  let createMode = mode == "create";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit(value);
          }}
        >
          <DialogHeader>
            <DialogTitle>{createMode ? "New file" : "Rename file"}</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor={inputId}>File name</FieldLabel>
              <Input
                id={inputId}
                aria-invalid={Boolean(error)}
                autoFocus
                value={value}
                onChange={(event) => onValueChange(event.target.value)}
              />
              <FieldError>{error}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {createMode ? "Create" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function defaultNewFileName(files: MarkdownFileNode[]) {
  let today = new Date().toISOString().slice(0, 10);
  let baseName = `${today}.md`;
  if (!files.some((file) => file.path == baseName)) return baseName;

  for (let index = 2; index < 1000; index += 1) {
    let name = `${today}-${index}.md`;
    if (!files.some((file) => file.path == name)) return name;
  }

  return "Untitled.md";
}

function saveStateLabel(saveState: SaveState, selectedFile: MarkdownFileNode | null) {
  if (!selectedFile) return "No file";
  switch (saveState) {
    case "pending":
      return "Unsaved";
    case "saving":
      return "Saving";
    case "error":
      return "Error";
    case "idle":
    case "saved":
      return "Saved";
  }
}

function errorToMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name == "AbortError";
}
