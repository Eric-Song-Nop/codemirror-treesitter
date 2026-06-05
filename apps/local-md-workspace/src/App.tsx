import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
} from "react";
import {
  CloudIcon,
  FolderOpenIcon,
  ImagePlusIcon,
  MenuIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import type { EditorView } from "@codemirror/view";
import type {
  LiveMdEditorElement,
  LiveMdImageSourceResolver,
} from "@codemirror-treesitter/live-md";
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
  DialogDescription,
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
import { FileTree, type FileTreeDeleteTarget } from "@/components/FileTree";
import { LiveMdEditor, type LiveMdImageFilesInput } from "@/components/LiveMdEditor";
import {
  authorizeDropboxWithPkce,
  completeDropboxRedirectOAuthIfPresent,
  completeDropboxPopupOAuthIfPresent,
  hasDropboxOAuthCallback,
  type DropboxAccessToken,
} from "@/lib/dropbox-oauth";
import {
  saveDropboxRedirectDraft,
  takeDropboxRedirectDraft,
  type DropboxRedirectDraft,
} from "@/lib/dropbox-redirect-draft";
import { createDropboxWorkspaceBackend } from "@/lib/dropbox-workspace-backend";
import {
  createLocalWorkspaceBackend,
  ensureReadWritePermission,
  pickWorkspaceDirectory,
  queryReadWritePermission,
  supportsDirectoryPicker,
  type AccessDirectoryHandle,
} from "@/lib/file-system";
import {
  flattenMarkdownFiles,
  type MarkdownDirectoryNode,
  type MarkdownFileNode,
  type WorkspaceBackend,
  type WorkspaceImageNode,
} from "@/lib/workspace-backend";
import { workspaceErrorMessage } from "@/lib/workspace-errors";
import { cn } from "@/lib/utils";
import {
  loadStoredDropboxWorkspaceConfig,
  loadStoredWorkspaceHandle,
  saveStoredDropboxWorkspaceConfig,
  saveStoredWorkspaceHandle,
  type StoredDropboxWorkspaceConfig,
} from "@/lib/workspace-store";

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";
type FileDialogMode = "create" | "rename";

type EditorDocument = {
  path: string;
  value: string;
  version: number;
};

type WorkspaceImageAsset = WorkspaceImageNode & {
  url: string;
};

export function App() {
  let [workspaceBackend, setWorkspaceBackend] = useState<WorkspaceBackend | null>(null);
  let [storedWorkspaceHandle, setStoredWorkspaceHandle] = useState<AccessDirectoryHandle | null>(
    null,
  );
  let [storedDropboxConfig, setStoredDropboxConfig] = useState<StoredDropboxWorkspaceConfig | null>(
    null,
  );
  let [tree, setTree] = useState<MarkdownDirectoryNode | null>(null);
  let [files, setFiles] = useState<MarkdownFileNode[]>([]);
  let [selectedFile, setSelectedFile] = useState<MarkdownFileNode | null>(null);
  let [treeSelection, setTreeSelection] = useState<FileTreeDeleteTarget | null>(null);
  let [editorDocument, setEditorDocument] = useState<EditorDocument>({
    path: "",
    value: "",
    version: 0,
  });
  let [saveState, setSaveState] = useState<SaveState>("idle");
  let [errorMessage, setErrorMessage] = useState("");
  let [busy, setBusy] = useState(false);
  let [dropboxConnecting, setDropboxConnecting] = useState(false);
  let [restoreChecking, setRestoreChecking] = useState(false);
  let [sidebarOpen, setSidebarOpen] = useState(true);
  let [fileDialogMode, setFileDialogMode] = useState<FileDialogMode | null>(null);
  let [fileDialogValue, setFileDialogValue] = useState("");
  let [fileDialogError, setFileDialogError] = useState("");
  let [deleteTarget, setDeleteTarget] = useState<FileTreeDeleteTarget | null>(null);
  let [imageAssetVersion, setImageAssetVersion] = useState(0);

  let editorElementRef = useRef<LiveMdEditorElement | null>(null);
  let workspaceBackendRef = useRef<WorkspaceBackend | null>(null);
  let selectedFileBackendRef = useRef<WorkspaceBackend | null>(null);
  let selectedFileRef = useRef<MarkdownFileNode | null>(null);
  let editorValueRef = useRef("");
  let cleanValueRef = useRef("");
  let dirtyRef = useRef(false);
  let editVersionRef = useRef(0);
  let saveStateRef = useRef<SaveState>("idle");
  let saveTimerRef = useRef<number | null>(null);
  let saveOperationRef = useRef(0);
  let dropboxTokenRef = useRef<DropboxAccessToken | null>(null);
  let dropboxTokenAppKeyRef = useRef("");
  let dropboxAuthPromiseRef = useRef<Promise<DropboxAccessToken> | null>(null);
  let dropboxRedirectPendingRef = useRef(isDropboxRedirectCallbackWindow());
  let imageAssetsRef = useRef(new Map<string, WorkspaceImageAsset>());
  let imageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    workspaceBackendRef.current = workspaceBackend;
  }, [workspaceBackend]);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  useEffect(
    () => () => {
      revokeImageAssetUrls(imageAssetsRef.current);
      imageAssetsRef.current = new Map();
    },
    [],
  );

  useEffect(() => {
    completeDropboxPopupOAuthIfPresent();
  }, []);

  let selectedPath = selectedFile?.path ?? null;
  let rootName =
    tree?.name ?? workspaceBackend?.name ?? storedWorkspaceHandle?.name ?? "Local Markdown";
  let selectedPathLabel = selectedFile
    ? selectedFile.path == selectedFile.name
      ? ""
      : selectedFile.path
    : workspaceBackend
      ? "No file selected"
      : "No folder selected";
  let browserSupported = supportsDirectoryPicker();

  let setSaveStateSynced = useCallback((nextState: SaveState) => {
    if (saveStateRef.current == nextState) return;
    saveStateRef.current = nextState;
    setSaveState(nextState);
  }, []);

  let replaceImageAssets = useCallback((nextAssets: WorkspaceImageAsset[]) => {
    revokeImageAssetUrls(imageAssetsRef.current);
    imageAssetsRef.current = new Map(nextAssets.map((asset) => [asset.path, asset]));
    setImageAssetVersion((version) => version + 1);
  }, []);

  let upsertImageAssets = useCallback((nextAssets: WorkspaceImageAsset[]) => {
    let assets = new Map(imageAssetsRef.current);
    for (let asset of nextAssets) {
      let previous = assets.get(asset.path);
      if (previous) URL.revokeObjectURL(previous.url);
      assets.set(asset.path, asset);
    }
    imageAssetsRef.current = assets;
    setImageAssetVersion((version) => version + 1);
  }, []);

  let saveCurrentFile = useCallback(async () => {
    let backend = selectedFileBackendRef.current;
    let file = selectedFileRef.current;
    if (!backend || !file) return true;

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
      return true;
    }

    let operation = ++saveOperationRef.current;
    setSaveStateSynced("saving");

    try {
      await backend.writeFile(file.path, value);
      if (operation == saveOperationRef.current && selectedFileRef.current?.path == file.path) {
        cleanValueRef.current = value;
        if (editVersion == editVersionRef.current) {
          dirtyRef.current = false;
          setSaveStateSynced("saved");
        }
      }
      return true;
    } catch (error) {
      setSaveStateSynced("error");
      setErrorMessage(errorToMessage(error));
      return false;
    }
  }, [setSaveStateSynced]);

  let scheduleAutoSave = useCallback(() => {
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);

    let delay = selectedFileBackendRef.current?.kind == "opendal-dropbox" ? 2500 : 650;
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveCurrentFile();
    }, delay);
  }, [saveCurrentFile]);

  let handleEditorInput = useCallback(
    (value: string) => {
      editorValueRef.current = value;
      editVersionRef.current += 1;
      dirtyRef.current = true;

      if (saveStateRef.current != "pending") {
        setSaveStateSynced("pending");
      }

      scheduleAutoSave();
    },
    [scheduleAutoSave, setSaveStateSynced],
  );

  let loadFile = useCallback(
    async (
      backend: WorkspaceBackend,
      file: MarkdownFileNode,
      options: { saveCurrent?: boolean } = {},
    ) => {
      if ((options.saveCurrent ?? true) && !(await saveCurrentFile())) return;

      setBusy(true);
      setErrorMessage("");
      try {
        let value = await backend.readFile(file.path);
        selectedFileRef.current = file;
        selectedFileBackendRef.current = backend;
        editorValueRef.current = value;
        cleanValueRef.current = value;
        dirtyRef.current = false;
        editVersionRef.current = 0;
        setSelectedFile(file);
        setTreeSelection({ kind: "file", name: file.name, path: file.path });
        setEditorDocument((current) => ({
          path: file.path,
          value,
          version: current.version + 1,
        }));
        setSaveStateSynced("saved");
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
      backend: WorkspaceBackend,
      nextSelectedPath?: null | string,
      options: { saveBeforeSelect?: boolean } = {},
    ) => {
      let [nextTree, nextImageNodes] = await Promise.all([
        backend.readTree(),
        backend.readImages?.() ?? Promise.resolve([]),
      ]);
      replaceImageAssets(await createWorkspaceImageAssets(nextImageNodes));
      let nextFiles = flattenMarkdownFiles(nextTree);
      setTree(nextTree);
      setFiles(nextFiles);

      let nextSelectedFile = nextSelectedPath
        ? (nextFiles.find((file) => file.path == nextSelectedPath) ?? null)
        : null;

      if (nextSelectedFile) {
        await loadFile(backend, nextSelectedFile, {
          saveCurrent: options.saveBeforeSelect ?? true,
        });
      } else {
        selectedFileRef.current = null;
        selectedFileBackendRef.current = null;
        editorValueRef.current = "";
        cleanValueRef.current = "";
        dirtyRef.current = false;
        editVersionRef.current = 0;
        setSelectedFile(null);
        setTreeSelection(null);
        setEditorDocument((current) => ({
          path: "",
          value: "",
          version: current.version + 1,
        }));
        setSaveStateSynced("idle");
      }
    },
    [loadFile, replaceImageAssets, setSaveStateSynced],
  );

  let rememberWorkspaceHandle = useCallback((handle: AccessDirectoryHandle) => {
    setStoredWorkspaceHandle(handle);
    void saveStoredWorkspaceHandle(handle).catch(() => {});
  }, []);

  let authorizeDropboxAccess = useCallback(async (appKey: string, root?: string) => {
    let normalizedAppKey = appKey.trim();
    if (dropboxAuthPromiseRef.current) return dropboxAuthPromiseRef.current;

    let redirectUri = defaultDropboxRedirectUri();
    let promise = authorizeDropboxWithPkce({
      allowFullPageRedirect: true,
      appKey: normalizedAppKey,
      ...(redirectUri ? { redirectUri } : {}),
      onBeforeFullPageRedirect: () => {
        let backend = workspaceBackendRef.current;
        let file = selectedFileRef.current;
        let shouldRestoreDirtyEditor =
          backend?.kind == "opendal-dropbox" && Boolean(file) && dirtyRef.current;

        saveDropboxRedirectDraft({
          appKey: normalizedAppKey,
          dirtyValue: shouldRestoreDirtyEditor ? editorValueRef.current : undefined,
          root,
          selectedPath: shouldRestoreDirtyEditor ? file?.path : undefined,
        });
      },
    });
    dropboxAuthPromiseRef.current = promise;

    try {
      let token = await promise;
      dropboxTokenRef.current = token;
      dropboxTokenAppKeyRef.current = normalizedAppKey;
      return token;
    } finally {
      if (dropboxAuthPromiseRef.current == promise) dropboxAuthPromiseRef.current = null;
    }
  }, []);

  let restoreDropboxRedirectEditorDraft = useCallback(
    (backend: WorkspaceBackend, draft: DropboxRedirectDraft) => {
      if (!draft.selectedPath || draft.dirtyValue == null) return false;

      let file = selectedFileRef.current;
      if (!file || file.path != draft.selectedPath) return false;

      selectedFileBackendRef.current = backend;
      editorValueRef.current = draft.dirtyValue;
      editVersionRef.current += 1;
      setEditorDocument((current) => ({
        path: file.path,
        value: draft.dirtyValue ?? "",
        version: current.version + 1,
      }));

      if (draft.dirtyValue == cleanValueRef.current) {
        dirtyRef.current = false;
        setSaveStateSynced("saved");
        return true;
      }

      dirtyRef.current = true;
      setSaveStateSynced("pending");
      scheduleAutoSave();
      return true;
    },
    [scheduleAutoSave, setSaveStateSynced],
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
      let backend = createLocalWorkspaceBackend(handle);
      dropboxTokenRef.current = null;
      dropboxTokenAppKeyRef.current = "";
      setWorkspaceBackend(backend);
      rememberWorkspaceHandle(handle);
      setSidebarOpen(true);
      await loadTree(backend, null);
    } catch (error) {
      if (!isAbortError(error)) setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [loadTree, rememberWorkspaceHandle]);

  let openDropboxWorkspace = useCallback(
    async (
      config: StoredDropboxWorkspaceConfig,
      options: {
        restoreDraft?: DropboxRedirectDraft | null;
        skipSaveCurrent?: boolean;
      } = {},
    ) => {
      setErrorMessage("");
      if (!options.skipSaveCurrent && !(await saveCurrentFile())) return false;

      let appKey = config.appKey.trim();
      if (!appKey) {
        setErrorMessage("Dropbox app key is required.");
        return false;
      }
      let root = normalizeDropboxRootInput(config.root);

      setBusy(true);
      setDropboxConnecting(true);

      try {
        let refreshAccessToken = () => authorizeDropboxAccess(appKey, root);
        let getAccessToken = async () => {
          let token = dropboxTokenRef.current;
          if (
            token &&
            dropboxTokenAppKeyRef.current == appKey &&
            token.expiresAt > Date.now() + 5 * 60 * 1000
          ) {
            return token;
          }
          return refreshAccessToken();
        };

        await getAccessToken();
        let backend = createDropboxWorkspaceBackend({
          getAccessToken,
          name: "Dropbox",
          refreshAccessToken,
          root,
        });
        setWorkspaceBackend(backend);
        let storedConfig = root ? { appKey, root } : { appKey };
        setStoredDropboxConfig(storedConfig);
        saveStoredDropboxWorkspaceConfig(storedConfig);
        setSidebarOpen(true);
        await loadTree(backend, options.restoreDraft?.selectedPath ?? null, {
          saveBeforeSelect: false,
        });
        if (options.restoreDraft) restoreDropboxRedirectEditorDraft(backend, options.restoreDraft);
        return true;
      } catch (error) {
        setErrorMessage(errorToMessage(error));
        return false;
      } finally {
        setDropboxConnecting(false);
        setBusy(false);
      }
    },
    [authorizeDropboxAccess, loadTree, restoreDropboxRedirectEditorDraft, saveCurrentFile],
  );

  let restoreStoredWorkspace = useCallback(async () => {
    if (!storedWorkspaceHandle) return;

    setBusy(true);
    setErrorMessage("");
    try {
      if (!(await ensureReadWritePermission(storedWorkspaceHandle))) {
        setErrorMessage("Read-write folder permission was not granted.");
        return;
      }

      let backend = createLocalWorkspaceBackend(storedWorkspaceHandle);
      dropboxTokenRef.current = null;
      dropboxTokenAppKeyRef.current = "";
      setWorkspaceBackend(backend);
      setSidebarOpen(true);
      await loadTree(backend, null, { saveBeforeSelect: false });
    } catch (error) {
      setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [loadTree, storedWorkspaceHandle]);

  let restoreDropboxWorkspace = useCallback(async () => {
    if (!storedDropboxConfig) return;
    let appKey = defaultDropboxAppKey();
    if (!appKey) {
      setErrorMessage("Dropbox is not configured. Set VITE_DROPBOX_APP_KEY for this app.");
      return;
    }
    await openDropboxWorkspace({
      appKey,
      root: storedDropboxConfig.root,
    });
  }, [openDropboxWorkspace, storedDropboxConfig]);

  let refreshWorkspace = useCallback(async () => {
    if (!workspaceBackend || !(await saveCurrentFile())) return;

    setBusy(true);
    setErrorMessage("");
    try {
      await loadTree(workspaceBackend, selectedFileRef.current?.path ?? null);
    } catch (error) {
      setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [loadTree, saveCurrentFile, workspaceBackend]);

  useEffect(() => {
    setStoredDropboxConfig(loadStoredDropboxWorkspaceConfig());
  }, []);

  useEffect(() => {
    if (!dropboxRedirectPendingRef.current) return;

    let canceled = false;
    setBusy(true);
    setDropboxConnecting(true);
    setErrorMessage("");

    void (async () => {
      try {
        let token = await completeDropboxRedirectOAuthIfPresent();
        if (canceled || !token) return;

        let draft = takeDropboxRedirectDraft();
        let restoreDraft = draft?.appKey == token.appKey ? draft : null;
        dropboxTokenRef.current = {
          accessToken: token.accessToken,
          expiresAt: token.expiresAt,
        };
        dropboxTokenAppKeyRef.current = token.appKey;

        await openDropboxWorkspace(
          {
            appKey: token.appKey,
            root: restoreDraft?.root,
          },
          {
            restoreDraft,
            skipSaveCurrent: true,
          },
        );
      } catch (error) {
        if (!canceled) {
          setErrorMessage(errorToMessage(error));
        }
      } finally {
        dropboxRedirectPendingRef.current = false;
        if (!canceled) {
          setDropboxConnecting(false);
          setBusy(false);
        }
      }
    })();

    return () => {
      canceled = true;
    };
  }, [openDropboxWorkspace]);

  useEffect(() => {
    if (!browserSupported || dropboxRedirectPendingRef.current) return;

    let canceled = false;
    setRestoreChecking(true);

    void (async () => {
      try {
        let handle = await loadStoredWorkspaceHandle();
        if (canceled || !handle) return;

        setStoredWorkspaceHandle(handle);

        if ((await queryReadWritePermission(handle)) != "granted") {
          return;
        }
        if (canceled) return;

        let backend = createLocalWorkspaceBackend(handle);
        dropboxTokenRef.current = null;
        dropboxTokenAppKeyRef.current = "";
        setWorkspaceBackend(backend);
        setSidebarOpen(true);
        await loadTree(backend, null, { saveBeforeSelect: false });
      } catch (error) {
        if (!canceled) setErrorMessage(errorToMessage(error));
      } finally {
        if (!canceled) setRestoreChecking(false);
      }
    })();

    return () => {
      canceled = true;
    };
  }, [browserSupported, loadTree]);

  useEffect(
    () => () => {
      if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );

  let selectFile = useCallback(
    (file: MarkdownFileNode) => {
      if (workspaceBackend) void loadFile(workspaceBackend, file);
    },
    [loadFile, workspaceBackend],
  );

  let openCreateDialog = () => {
    setFileDialogError("");
    setFileDialogValue(defaultNewFilePath(files, treeSelection));
    setFileDialogMode("create");
  };

  let openRenameDialog = () => {
    if (!selectedFile) return;
    setFileDialogError("");
    setFileDialogValue(selectedFile.name);
    setFileDialogMode("rename");
  };

  let connectDropbox = () => {
    let appKey = defaultDropboxAppKey();
    if (!appKey) {
      setErrorMessage("Dropbox is not configured. Set VITE_DROPBOX_APP_KEY for this app.");
      return;
    }

    void openDropboxWorkspace({
      appKey,
      root: storedDropboxConfig?.root ?? defaultDropboxRoot(),
    });
  };

  let closeFileDialog = (open: boolean) => {
    if (!open) {
      setFileDialogMode(null);
      setFileDialogError("");
    }
  };

  let submitFileDialog = async (value: string) => {
    if (!workspaceBackend || !fileDialogMode) return;
    if (!(await saveCurrentFile())) return;

    setFileDialogError("");
    setBusy(true);
    try {
      let nextPath =
        fileDialogMode == "create"
          ? await workspaceBackend.createFile(value)
          : selectedFile
            ? await workspaceBackend.renameFile(selectedFile.path, value)
            : null;

      setFileDialogMode(null);
      await loadTree(workspaceBackend, nextPath ?? selectedFileRef.current?.path ?? null, {
        saveBeforeSelect: false,
      });
    } catch (error) {
      setFileDialogError(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  };

  let requestDeleteEntry = useCallback((target: FileTreeDeleteTarget) => {
    setErrorMessage("");
    setDeleteTarget(target);
  }, []);

  let closeDeleteDialog = (open: boolean) => {
    if (!open) setDeleteTarget(null);
  };

  let deleteWorkspaceEntry = async () => {
    let backend = workspaceBackend;
    let target = deleteTarget;
    if (!backend || !target) return;
    if (!(await saveCurrentFile())) return;

    setBusy(true);
    setErrorMessage("");
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    saveOperationRef.current += 1;
    try {
      let nextSelectedPath = selectedFileRef.current?.path ?? null;
      if (target.kind == "directory") {
        if (!backend.deleteDirectory) throw new Error("This workspace cannot delete folders.");
        await backend.deleteDirectory(target.path);
        if (nextSelectedPath && isPathInsideDirectory(nextSelectedPath, target.path)) {
          nextSelectedPath = null;
        }
      } else {
        await backend.deleteFile(target.path);
        if (nextSelectedPath == target.path) nextSelectedPath = null;
      }

      setDeleteTarget(null);
      await loadTree(backend, nextSelectedPath, { saveBeforeSelect: false });
    } catch (error) {
      setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  };

  let resolveImageSource = useMemo<LiveMdImageSourceResolver>(() => {
    return (source) => {
      let imagePath = workspaceImagePathForSource(source, editorDocument.path);
      if (!imagePath) return source;
      return imageAssetsRef.current.get(imagePath)?.url ?? source;
    };
  }, [editorDocument.path, imageAssetVersion]);

  let handleEditorReady = useCallback((editor: LiveMdEditorElement | null) => {
    editorElementRef.current = editor;
  }, []);

  let insertImageFiles = useCallback(
    async (files: File[], options: { position?: number; view?: EditorView } = {}) => {
      let file = selectedFileRef.current;
      let backend = workspaceBackendRef.current;
      if (!backend?.createImageAsset || !file) return;

      let imageFiles = files.filter(isImageFile);
      if (!imageFiles.length) return;

      setBusy(true);
      setErrorMessage("");

      try {
        let insertedAssets: Array<WorkspaceImageAsset & { markdownReference: string }> = [];
        for (let imageFile of imageFiles) {
          let asset = await backend.createImageAsset(file.path, imageFile);
          insertedAssets.push({
            ...asset,
            url: URL.createObjectURL(imageFile),
          });
        }

        upsertImageAssets(insertedAssets);
        insertImageMarkdown(
          options.view ?? editorElementRef.current?.view ?? null,
          insertedAssets,
          options.position,
        );
      } catch (error) {
        setErrorMessage(errorToMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [upsertImageAssets],
  );

  let handleEditorImageFiles = useCallback(
    ({ files, position, view }: LiveMdImageFilesInput) => {
      void insertImageFiles(files, { position, view });
    },
    [insertImageFiles],
  );

  let handleImageInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      let files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      void insertImageFiles(files);
    },
    [insertImageFiles],
  );

  let saveLabel = useMemo(() => saveStateLabel(saveState, selectedFile), [saveState, selectedFile]);
  let restoreAvailable = Boolean(storedWorkspaceHandle);
  let dropboxRestoreAvailable = Boolean(storedDropboxConfig);

  return (
    <TooltipProvider>
      <div className="dark flex h-svh min-h-0 overflow-hidden bg-background text-foreground">
        <aside
          className={cn(
            "flex w-[19rem] shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:w-[min(21rem,88vw)]",
            !sidebarOpen && "hidden",
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
              label="Connect Dropbox"
              size="icon-sm"
              variant="ghost"
              onClick={connectDropbox}
              disabled={busy || dropboxConnecting}
            >
              <CloudIcon data-icon="inline-start" />
            </TooltipIconButton>
            <TooltipIconButton
              label="New file"
              size="icon-sm"
              variant="ghost"
              onClick={openCreateDialog}
              disabled={!workspaceBackend || busy}
            >
              <PlusIcon data-icon="inline-start" />
            </TooltipIconButton>
          </div>
          <Separator />
          {tree ? (
            <FileTree
              root={tree}
              selectedPath={selectedPath}
              onDeleteEntry={requestDeleteEntry}
              onSelectEntry={setTreeSelection}
              onSelectFile={selectFile}
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-4">
              <div className="flex w-full max-w-48 flex-col gap-2">
                {restoreAvailable && (
                  <Button
                    onClick={() => void restoreStoredWorkspace()}
                    disabled={!browserSupported || busy || restoreChecking}
                  >
                    <FolderOpenIcon data-icon="inline-start" />
                    Restore folder
                  </Button>
                )}
                {dropboxRestoreAvailable && (
                  <Button
                    variant={restoreAvailable ? "outline" : "default"}
                    onClick={() => void restoreDropboxWorkspace()}
                    disabled={busy || dropboxConnecting}
                  >
                    <CloudIcon data-icon="inline-start" />
                    Reconnect Dropbox
                  </Button>
                )}
                <Button
                  variant={restoreAvailable || dropboxRestoreAvailable ? "outline" : "default"}
                  onClick={() => void openWorkspace()}
                  disabled={!browserSupported || busy}
                >
                  <FolderOpenIcon data-icon="inline-start" />
                  Open folder
                </Button>
                <Button
                  variant="outline"
                  onClick={connectDropbox}
                  disabled={busy || dropboxConnecting}
                >
                  <CloudIcon data-icon="inline-start" />
                  Connect Dropbox
                </Button>
              </div>
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
              label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              size="icon-sm"
              variant="ghost"
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <MenuIcon data-icon="inline-start" />
            </TooltipIconButton>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {selectedFile?.name ?? "Local Markdown"}
              </div>
              {selectedPathLabel && (
                <div className="truncate text-xs text-muted-foreground">{selectedPathLabel}</div>
              )}
            </div>
            <Badge variant={saveState == "error" ? "destructive" : "secondary"}>
              <SaveIcon data-icon="inline-start" />
              {saveLabel}
            </Badge>
            <input
              ref={imageInputRef}
              className="sr-only"
              type="file"
              accept="image/*"
              multiple
              onChange={handleImageInputChange}
            />
            <TooltipIconButton
              label="Insert image"
              size="icon-sm"
              variant="ghost"
              disabled={!workspaceBackend?.createImageAsset || !selectedFile || busy}
              onClick={() => imageInputRef.current?.click()}
            >
              <ImagePlusIcon data-icon="inline-start" />
            </TooltipIconButton>
            <TooltipIconButton
              label="Refresh"
              size="icon-sm"
              variant="ghost"
              disabled={!workspaceBackend || busy}
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
                imageSource={resolveImageSource}
                initialValue={editorDocument.value}
                placeholder="Start writing..."
                onEditorReady={handleEditorReady}
                onImageFiles={handleEditorImageFiles}
                onInput={handleEditorInput}
              />
            ) : (
              <WorkspaceEmpty
                browserSupported={browserSupported}
                busy={busy}
                fileCount={files.length}
                hasWorkspace={Boolean(workspaceBackend)}
                dropboxConnecting={dropboxConnecting}
                dropboxRestoreAvailable={dropboxRestoreAvailable}
                restoreAvailable={restoreAvailable}
                restoreChecking={restoreChecking}
                onCreateFile={openCreateDialog}
                onOpenDropbox={connectDropbox}
                onOpenFolder={() => void openWorkspace()}
                onRestoreDropbox={() => void restoreDropboxWorkspace()}
                onRestoreFolder={() => void restoreStoredWorkspace()}
              />
            )}
          </section>
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

        <AlertDialog open={deleteTarget != null} onOpenChange={closeDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <Trash2Icon />
              </AlertDialogMedia>
              <AlertDialogTitle>
                {deleteTarget?.kind == "directory" ? "Delete folder?" : "Delete file?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {deleteTarget
                  ? deleteTarget.kind == "directory"
                    ? `${deleteTarget.path} and all files inside it will be deleted.`
                    : deleteTarget.path
                  : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void deleteWorkspaceEntry();
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
  busy: boolean;
  dropboxConnecting: boolean;
  dropboxRestoreAvailable: boolean;
  fileCount: number;
  hasWorkspace: boolean;
  restoreAvailable: boolean;
  restoreChecking: boolean;
  onCreateFile: () => void;
  onOpenDropbox: () => void;
  onOpenFolder: () => void;
  onRestoreDropbox: () => void;
  onRestoreFolder: () => void;
};

function WorkspaceEmpty({
  browserSupported,
  busy,
  dropboxConnecting,
  dropboxRestoreAvailable,
  fileCount,
  hasWorkspace,
  restoreAvailable,
  restoreChecking,
  onCreateFile,
  onOpenDropbox,
  onOpenFolder,
  onRestoreDropbox,
  onRestoreFolder,
}: WorkspaceEmptyProps) {
  return (
    <Empty className="h-full rounded-none border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderOpenIcon />
        </EmptyMedia>
        <EmptyTitle>{emptyTitle(hasWorkspace, fileCount)}</EmptyTitle>
        {!browserSupported && (
          <EmptyDescription>File System Access API is unavailable.</EmptyDescription>
        )}
      </EmptyHeader>
      <EmptyContent>
        {hasWorkspace ? (
          <Button onClick={onCreateFile} disabled={busy}>
            <PlusIcon data-icon="inline-start" />
            New file
          </Button>
        ) : restoreAvailable ? (
          <div className="flex flex-col gap-2">
            <Button
              onClick={onRestoreFolder}
              disabled={!browserSupported || busy || restoreChecking}
            >
              <FolderOpenIcon data-icon="inline-start" />
              Restore folder
            </Button>
            {dropboxRestoreAvailable && (
              <Button
                variant="outline"
                onClick={onRestoreDropbox}
                disabled={busy || dropboxConnecting}
              >
                <CloudIcon data-icon="inline-start" />
                Reconnect Dropbox
              </Button>
            )}
            <Button variant="outline" onClick={onOpenFolder} disabled={!browserSupported || busy}>
              <FolderOpenIcon data-icon="inline-start" />
              Open folder
            </Button>
            <Button variant="outline" onClick={onOpenDropbox} disabled={busy || dropboxConnecting}>
              <CloudIcon data-icon="inline-start" />
              Connect Dropbox
            </Button>
          </div>
        ) : dropboxRestoreAvailable ? (
          <div className="flex flex-col gap-2">
            <Button onClick={onRestoreDropbox} disabled={busy || dropboxConnecting}>
              <CloudIcon data-icon="inline-start" />
              Reconnect Dropbox
            </Button>
            <Button variant="outline" onClick={onOpenFolder} disabled={!browserSupported || busy}>
              <FolderOpenIcon data-icon="inline-start" />
              Open folder
            </Button>
            <Button variant="outline" onClick={onOpenDropbox} disabled={busy || dropboxConnecting}>
              <CloudIcon data-icon="inline-start" />
              Connect Dropbox
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Button onClick={onOpenFolder} disabled={!browserSupported || busy}>
              <FolderOpenIcon data-icon="inline-start" />
              Open folder
            </Button>
            <Button variant="outline" onClick={onOpenDropbox} disabled={busy || dropboxConnecting}>
              <CloudIcon data-icon="inline-start" />
              Connect Dropbox
            </Button>
          </div>
        )}
      </EmptyContent>
    </Empty>
  );
}

function emptyTitle(hasWorkspace: boolean, fileCount: number) {
  if (!hasWorkspace) return "No folder open";
  return fileCount ? "No file selected" : "No markdown files";
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
            <DialogTitle>{createMode ? "New file or folder" : "Rename file"}</DialogTitle>
            <DialogDescription className="sr-only">
              {createMode
                ? "Create a Markdown file or folder path."
                : "Rename the selected Markdown file."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor={inputId}>{createMode ? "Path" : "File name"}</FieldLabel>
              <Input
                id={inputId}
                aria-invalid={Boolean(error)}
                autoFocus
                placeholder={createMode ? "file.md, dir/, or dir/file.md" : undefined}
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

async function createWorkspaceImageAssets(nodes: WorkspaceImageNode[]) {
  let assets: WorkspaceImageAsset[] = [];
  for (let node of nodes) {
    assets.push({
      ...node,
      url: URL.createObjectURL(node.file),
    });
  }
  return assets;
}

function revokeImageAssetUrls(assets: ReadonlyMap<string, WorkspaceImageAsset>) {
  for (let asset of assets.values()) {
    URL.revokeObjectURL(asset.url);
  }
}

function insertImageMarkdown(
  view: EditorView | null,
  assets: Array<WorkspaceImageAsset & { markdownReference: string }>,
  position?: number,
) {
  if (!view || !assets.length) return;

  let selection = view.state.selection.main;
  let from = position ?? selection.from;
  let to = position ?? selection.to;
  let markdown = assets.map(imageAssetMarkdown).join("\n\n");
  let insert = blockInsertText(view.state.doc, from, to, markdown);

  view.dispatch({
    changes: { from, insert, to },
    scrollIntoView: true,
    selection: { anchor: from + insert.length },
    userEvent: "input.image",
  });
  view.focus();
}

function imageAssetMarkdown(asset: WorkspaceImageAsset & { markdownReference: string }) {
  return `![${imageAltText(asset.name)}](${asset.markdownReference})`;
}

function imageAltText(fileName: string) {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

function blockInsertText(
  doc: EditorView["state"]["doc"],
  from: number,
  to: number,
  markdown: string,
) {
  let before = doc.sliceString(Math.max(0, from - 2), from);
  let after = doc.sliceString(to, Math.min(doc.length, to + 2));
  let prefix = from == 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  let suffix =
    to == doc.length || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return `${prefix}${markdown}${suffix}`;
}

function workspaceImagePathForSource(source: string, documentPath: string) {
  if (!documentPath || isExternalImageSource(source)) return null;

  let path = stripImageSourceSuffix(source);
  if (!path || path.startsWith("//")) return null;

  try {
    path = decodeURI(path);
  } catch {
    return null;
  }

  return normalizeWorkspacePath(
    path.startsWith("/") ? path.slice(1) : joinWorkspacePath(directoryPath(documentPath), path),
  );
}

function isExternalImageSource(source: string) {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(source);
}

function stripImageSourceSuffix(source: string) {
  let suffixIndex = source.search(/[?#]/);
  return suffixIndex == -1 ? source : source.slice(0, suffixIndex);
}

function normalizeWorkspacePath(path: string) {
  let parts: string[] = [];
  for (let part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part == ".") continue;
    if (part == "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function directoryPath(path: string) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function joinWorkspacePath(parent: string, child: string) {
  return parent ? `${parent}/${child}` : child;
}

function isPathInsideDirectory(path: string, directory: string) {
  let normalizedDirectory = directory.replace(/\/+$/g, "");
  return path == normalizedDirectory || path.startsWith(`${normalizedDirectory}/`);
}

function isImageFile(file: File) {
  return (
    file.type.startsWith("image/") || /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(file.name)
  );
}

function defaultNewFilePath(files: MarkdownFileNode[], selection: FileTreeDeleteTarget | null) {
  let today = new Date().toISOString().slice(0, 10);
  let parentPath =
    selection?.kind == "directory"
      ? selection.path
      : selection?.kind == "file"
        ? directoryPath(selection.path)
        : "";
  let baseName = `${today}.md`;
  let basePath = joinWorkspacePath(parentPath, baseName);
  if (!files.some((file) => file.path == basePath)) return basePath;

  for (let index = 2; index < 1000; index += 1) {
    let path = joinWorkspacePath(parentPath, `${today}-${index}.md`);
    if (!files.some((file) => file.path == path)) return path;
  }

  return joinWorkspacePath(parentPath, "Untitled.md");
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

function defaultDropboxAppKey() {
  let configured = import.meta.env.VITE_DROPBOX_APP_KEY;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return "";
}

function defaultDropboxRoot() {
  let configured = import.meta.env.VITE_DROPBOX_ROOT;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return undefined;
}

function defaultDropboxRedirectUri() {
  let configured = import.meta.env.VITE_DROPBOX_REDIRECT_URI;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return undefined;
}

function normalizeDropboxRootInput(value: string | undefined) {
  let root = value
    ?.trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return root || undefined;
}

function isDropboxRedirectCallbackWindow() {
  return typeof window != "undefined" && !window.opener && hasDropboxOAuthCallback();
}

function errorToMessage(error: unknown) {
  return workspaceErrorMessage(error);
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name == "AbortError";
}
