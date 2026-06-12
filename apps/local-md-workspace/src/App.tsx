import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
} from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import {
  CloudIcon,
  Clock3Icon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FileTextIcon,
  FolderOpenIcon,
  ImagePlusIcon,
  LinkIcon,
  MenuIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Share2Icon,
  ShieldCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserRoundIcon,
} from "lucide-react";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { VersionVector } from "loro-crdt";
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
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  FileTree,
  type FileTreeCreateKind,
  type FileTreeDeleteTarget,
} from "@/components/FileTree";
import { GroveMark } from "@/components/GroveMark";
import { LiveMdEditor, type LiveMdImageFilesInput } from "@/components/LiveMdEditor";
import { isSharedFilePath, SharedFileEditor } from "@/components/SharedFileEditor";
import { ThemeDropdownSubmenu, ThemeSelector } from "@/components/ThemeSelector";
import { WorkspaceCommandPalette } from "@/components/WorkspaceCommandPalette";
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
import {
  acknowledgeCollabDocumentSourceSaved,
  captureCollabDocumentMaterialization,
  collabDocumentNeedsSourceWrite,
  getCollabDocumentValue,
  ingestExternalMarkdownEdit,
  openMarkdownCollabDocument,
  saveCollabDocumentSnapshot,
  savePendingCollabDocumentUpdates,
  type CollabDocumentState,
  type CollabSourceImportResult,
} from "@/lib/collaboration/markdown-document";
import { hashMarkdownText } from "@/lib/markdown-hash";
import { isWorkspaceWriteConflictError } from "@/lib/workspace-file-conflict";
import { createCollabDocumentBroadcastSync } from "@/lib/collaboration/document-sync";
import {
  createOwnerShare,
  findOwnerShareRecordForPath,
  hostSecretStorageKey,
  revokeOwnerShare,
  rotateOwnerShare,
  type CreatedOwnerShare,
  type OwnerShareRecord,
} from "@/lib/collaboration/share-storage";
import { localFolderAccessUnavailableMessage } from "@/lib/browser-support";
import {
  ShareRelayConnection,
  type ShareRelayStatus,
} from "@/lib/collaboration/share-relay-connection";
import {
  configuredShareRelayOrigin,
  createRelayShareSession,
} from "@/lib/collaboration/share-relay-client";
import type { ShareExpirationOption } from "@/lib/collaboration/share-identity";
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
  createStandaloneMarkdownHtml,
  resolveMarkdownImagePath,
  snapshotMarkdownHtmlExportTheme,
} from "@/lib/export/markdown-html";
import {
  loadStoredDropboxWorkspaceConfig,
  loadStoredWorkspaceKind,
  loadStoredWorkspaceHandle,
  saveStoredDropboxWorkspaceConfig,
  saveStoredWorkspaceKind,
  saveStoredWorkspaceHandle,
  type StoredDropboxWorkspaceConfig,
  type StoredWorkspaceKind,
} from "@/lib/workspace-store";

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";
type FileDialogMode = "create" | "rename";

type EditorDocument = {
  path: string;
  value: string;
  version: number;
};

const emptyEditorExtensions: Extension[] = [];
const githubRepositoryUrl = "https://github.com/Eric-Song-Nop/codemirror-treesitter";
const mobileSidebarMediaQuery = "(max-width: 767px)";

function isMobileSidebarViewport() {
  return typeof window != "undefined" && window.matchMedia(mobileSidebarMediaQuery).matches;
}

function defaultSidebarOpen() {
  return !isMobileSidebarViewport();
}

type WorkspaceImageAsset = WorkspaceImageNode & {
  url: string;
};

type ActiveOwnerShareRecord = OwnerShareRecord & {
  guestCount?: number;
  hostOnline?: boolean;
  peerCount?: number;
  pendingHostSave?: boolean;
};

export function App() {
  if (isSharedFilePath(window.location.pathname)) {
    return <SharedFileEditor />;
  }

  return <LocalWorkspaceApp />;
}

function LocalWorkspaceApp() {
  let [workspaceBackend, setWorkspaceBackend] = useState<WorkspaceBackend | null>(null);
  let [storedWorkspaceHandle, setStoredWorkspaceHandle] = useState<AccessDirectoryHandle | null>(
    null,
  );
  let [storedDropboxConfig, setStoredDropboxConfig] = useState<StoredDropboxWorkspaceConfig | null>(
    () => loadStoredDropboxWorkspaceConfig(),
  );
  let [storedWorkspaceKind, setStoredWorkspaceKind] = useState<StoredWorkspaceKind | null>(() =>
    loadStoredWorkspaceKind(),
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
  let [collabDocument, setCollabDocument] = useState<CollabDocumentState | null>(null);
  let [saveState, setSaveState] = useState<SaveState>("idle");
  let [errorMessage, setErrorMessage] = useState("");
  let [retryLoadPath, setRetryLoadPath] = useState<string | null>(null);
  let [busy, setBusy] = useState(false);
  let [dropboxConnecting, setDropboxConnecting] = useState(false);
  let [restoreChecking, setRestoreChecking] = useState(false);
  let [sidebarOpen, setSidebarOpen] = useState(() => defaultSidebarOpen());
  let [fileDialogMode, setFileDialogMode] = useState<FileDialogMode | null>(null);
  let [fileDialogTarget, setFileDialogTarget] = useState<FileTreeDeleteTarget | null>(null);
  let [fileDialogValue, setFileDialogValue] = useState("");
  let [fileDialogError, setFileDialogError] = useState("");
  let [deleteTarget, setDeleteTarget] = useState<FileTreeDeleteTarget | null>(null);
  let [shareDialogOpen, setShareDialogOpen] = useState(false);
  let [shareExpiration, setShareExpiration] = useState<ShareExpirationOption>("7d");
  let [shareError, setShareError] = useState("");
  let [shareCreating, setShareCreating] = useState(false);
  let [shareCopied, setShareCopied] = useState(false);
  let [createdShare, setCreatedShare] = useState<CreatedOwnerShare | null>(null);
  let [activeShareRecord, setActiveShareRecord] = useState<ActiveOwnerShareRecord | null>(null);
  let [imageAssetVersion, setImageAssetVersion] = useState(0);

  let editorElementRef = useRef<LiveMdEditorElement | null>(null);
  let workspaceBackendRef = useRef<WorkspaceBackend | null>(null);
  let selectedFileBackendRef = useRef<WorkspaceBackend | null>(null);
  let selectedFileRef = useRef<MarkdownFileNode | null>(null);
  let collabDocumentRef = useRef<CollabDocumentState | null>(null);
  let collabSyncCleanupRef = useRef<() => void>(() => {});
  let shareHostConnectionRef = useRef<ShareRelayConnection | null>(null);
  let shareHostRecordRef = useRef<OwnerShareRecord | null>(null);
  let shareHostUpdateCleanupRef = useRef<() => void>(() => {});
  let editorValueRef = useRef("");
  let cleanValueRef = useRef("");
  let dirtyRef = useRef(false);
  let editVersionRef = useRef(0);
  let saveStateRef = useRef<SaveState>("idle");
  let saveTimerRef = useRef<number | null>(null);
  let saveOperationRef = useRef(0);
  let loadFileRequestRef = useRef(0);
  let dropboxTokenRef = useRef<DropboxAccessToken | null>(null);
  let dropboxTokenAppKeyRef = useRef("");
  let dropboxAuthPromiseRef = useRef<Promise<DropboxAccessToken> | null>(null);
  let dropboxAutoRestoreAttemptedRef = useRef(false);
  let dropboxRedirectPendingRef = useRef(isDropboxRedirectCallbackWindow());
  let imageAssetsRef = useRef(new Map<string, WorkspaceImageAsset>());
  let imageInputRef = useRef<HTMLInputElement | null>(null);
  let [localRestoreChecked, setLocalRestoreChecked] = useState(false);

  useEffect(() => {
    workspaceBackendRef.current = workspaceBackend;
  }, [workspaceBackend]);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  useEffect(() => {
    collabDocumentRef.current = collabDocument;
  }, [collabDocument]);

  useEffect(
    () => () => {
      collabSyncCleanupRef.current();
      shareHostUpdateCleanupRef.current();
      shareHostConnectionRef.current?.close();
      collabDocumentRef.current?.dispose();
      revokeImageAssetUrls(imageAssetsRef.current);
      imageAssetsRef.current = new Map();
    },
    [],
  );

  useEffect(() => {
    completeDropboxPopupOAuthIfPresent();
  }, []);

  let selectedPath = selectedFile?.path ?? null;
  let rootName = tree?.name ?? workspaceBackend?.name ?? storedWorkspaceHandle?.name ?? "Grove";
  let selectedPathLabel = selectedFile
    ? selectedFile.path == selectedFile.name
      ? ""
      : selectedFile.path
    : "";
  let headerTitle = selectedFile?.name ?? rootName;
  let headerSubtitle = selectedFile
    ? selectedPathLabel
    : workspaceBackend
      ? files.length == 1
        ? "1 markdown file"
        : `${files.length} markdown files`
      : "";
  let browserSupported = supportsDirectoryPicker();
  let folderAccessUnavailableMessage = browserSupported
    ? ""
    : localFolderAccessUnavailableMessage();

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

  let stopOwnerShareHost = useCallback(() => {
    shareHostUpdateCleanupRef.current();
    shareHostUpdateCleanupRef.current = () => {};
    shareHostConnectionRef.current?.close();
    shareHostConnectionRef.current = null;
    shareHostRecordRef.current = null;
  }, []);

  let sendHostSaveAck = useCallback((path: string, value: string, savedVersion: VersionVector) => {
    let record = shareHostRecordRef.current;
    let connection = shareHostConnectionRef.current;
    if (!record || !connection || record.path != path) return;

    let materializedHash = hashMarkdownText(value);
    connection.enqueueHostSaveAck(
      new TextEncoder().encode(
        JSON.stringify({
          materializedHash,
          savedAt: Date.now(),
          shareId: record.shareId,
          versionVector: serializeVersionVector(savedVersion),
        }),
      ),
    );
    setActiveShareRecord((current) =>
      current?.shareId == record.shareId
        ? { ...current, lastHostSavedVersion: materializedHash }
        : current,
    );
  }, []);

  let sendHostDocumentUpdate = useCallback((path: string, update: Uint8Array | null) => {
    if (!update?.byteLength) return;
    let record = shareHostRecordRef.current;
    let connection = shareHostConnectionRef.current;
    if (!record || !connection || record.path != path) return;
    connection.enqueueDocumentUpdate(update);
  }, []);

  let applyCollabDocumentValue = useCallback(
    (document: CollabDocumentState, value = getCollabDocumentValue(document)) => {
      if (selectedFileRef.current?.path != document.path) return value;
      editorValueRef.current = value;
      editVersionRef.current += 1;
      setEditorDocument((current) => ({
        path: document.path,
        value,
        version: current.version + 1,
      }));
      return value;
    },
    [],
  );

  let saveCurrentFile = useCallback(async () => {
    let backend = selectedFileBackendRef.current;
    let file = selectedFileRef.current;
    if (!backend || !file) return true;

    let selectedDocument = collabDocumentRef.current;
    let document = selectedDocument?.path == file.path ? selectedDocument : null;
    let value = document ? getCollabDocumentValue(document) : editorValueRef.current;
    let editVersion = editVersionRef.current;
    if (!document && !dirtyRef.current && value == cleanValueRef.current) return true;

    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    if (!document && value == cleanValueRef.current) {
      dirtyRef.current = false;
      setSaveStateSynced("saved");
      return true;
    }

    let operation = ++saveOperationRef.current;
    setSaveStateSynced("saving");

    try {
      let sourceImport: CollabSourceImportResult | null = null;
      if (document) {
        sourceImport = await ingestExternalMarkdownEdit(backend, document);
        if (sourceImport) {
          sendHostDocumentUpdate(file.path, sourceImport.update);
          value = applyCollabDocumentValue(document, sourceImport.value);
        } else {
          value = getCollabDocumentValue(document);
        }
        editVersion = editVersionRef.current;

        if (
          !sourceImport &&
          !collabDocumentNeedsSourceWrite(document) &&
          !dirtyRef.current &&
          value == cleanValueRef.current
        ) {
          setSaveStateSynced("saved");
          return true;
        }
      }

      if (document && document.path == file.path) {
        let materialization = captureCollabDocumentMaterialization(document);
        value = materialization.value;
        await saveCollabDocumentSnapshot(backend, document);
        await backend.writeFile(file.path, materialization.value);
        await acknowledgeCollabDocumentSourceSaved(backend, document, materialization.value, {
          externalEdit: sourceImport?.externalEdit,
          frontiers: materialization.frontiers,
          versionVector: materialization.versionVector,
        });
        sendHostSaveAck(file.path, materialization.value, materialization.version);
      } else {
        await backend.writeFile(file.path, value);
      }
      if (operation == saveOperationRef.current && selectedFileRef.current?.path == file.path) {
        cleanValueRef.current = value;
        if (editVersion == editVersionRef.current) {
          dirtyRef.current = false;
          setSaveStateSynced("saved");
        }
      }
      return true;
    } catch (error) {
      if (isWorkspaceWriteConflictError(error)) {
        try {
          let externalValue = await backend.readFile(file.path);
          if (document && document.path == file.path) {
            let sourceImport: CollabSourceImportResult | null = null;
            if (externalValue != value) {
              sourceImport = await ingestExternalMarkdownEdit(backend, document, externalValue);
              if (sourceImport) sendHostDocumentUpdate(file.path, sourceImport.update);
              value = applyCollabDocumentValue(document, getCollabDocumentValue(document));
            }

            let materialization = captureCollabDocumentMaterialization(document);
            value = materialization.value;
            await saveCollabDocumentSnapshot(backend, document);
            if (externalValue != materialization.value) {
              await backend.writeFile(file.path, materialization.value);
            }
            await acknowledgeCollabDocumentSourceSaved(backend, document, materialization.value, {
              externalEdit: sourceImport?.externalEdit,
              frontiers: materialization.frontiers,
              versionVector: materialization.versionVector,
            });
            sendHostSaveAck(file.path, materialization.value, materialization.version);
            if (
              operation == saveOperationRef.current &&
              selectedFileRef.current?.path == file.path
            ) {
              cleanValueRef.current = value;
              if (editVersion == editVersionRef.current) {
                dirtyRef.current = false;
                setSaveStateSynced("saved");
              }
            }
            return true;
          }

          if (externalValue == value) {
            if (
              operation == saveOperationRef.current &&
              selectedFileRef.current?.path == file.path
            ) {
              cleanValueRef.current = value;
              if (editVersion == editVersionRef.current) {
                dirtyRef.current = false;
                setSaveStateSynced("saved");
              }
            }
            return true;
          }
        } catch {
          // Fall through to the original storage error below.
        }
      }

      setSaveStateSynced("error");
      setRetryLoadPath(null);
      setErrorMessage(errorToMessage(error));
      return false;
    }
  }, [applyCollabDocumentValue, sendHostDocumentUpdate, sendHostSaveAck, setSaveStateSynced]);

  let scheduleAutoSave = useCallback(() => {
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);

    let delay = selectedFileBackendRef.current?.kind == "opendal-dropbox" ? 2500 : 650;
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveCurrentFile();
    }, delay);
  }, [saveCurrentFile]);

  let startOwnerShareHost = useCallback(
    async (
      record: OwnerShareRecord,
      backend: WorkspaceBackend,
      document: CollabDocumentState,
      options: { actionLabel?: string; shouldContinue?: () => boolean } = {},
    ) => {
      if (options.shouldContinue && !options.shouldContinue()) return;
      stopOwnerShareHost();

      let actionLabel = options.actionLabel ?? "Link created";
      let hostSecret = readHostSecret(record);
      if (!hostSecret) {
        setShareError(`${actionLabel}, but this browser cannot host it without the host key.`);
        return;
      }

      try {
        let session = await createRelayShareSession(
          configuredShareRelayOrigin(),
          record.shareId,
          "host",
          hostSecret,
        );
        if (options.shouldContinue && !options.shouldContinue()) return;
        setActiveShareRecord((current) =>
          current?.shareId == record.shareId
            ? {
                ...current,
                expiresAt: session.shareExpiresAt,
                guestCount: session.guestCount,
                hostOnline: session.hostOnline,
                peerCount: session.peerCount,
                pendingHostSave: session.pendingHostSave,
              }
            : current,
        );
        let connection = new ShareRelayConnection({
          clientId: getOrCreateOwnerShareClientId(),
          doc: document.doc,
          onDocumentImported: () => {
            editorValueRef.current = getCollabDocumentValue(document);
            editVersionRef.current += 1;
            dirtyRef.current = true;
            setSaveStateSynced("pending");
            void savePendingCollabDocumentUpdates(backend, document).catch(() => {});
            scheduleAutoSave();
          },
          onError: (message) => setShareError(message),
          onShareStatus: (status) => {
            setActiveShareRecord((current) =>
              current?.shareId == status.shareId ? mergeOwnerShareStatus(current, status) : current,
            );
          },
          relayOrigin: configuredShareRelayOrigin(),
          sessionToken: session.sessionToken,
          shareId: record.shareId,
        });
        shareHostConnectionRef.current = connection;
        shareHostRecordRef.current = record;
        shareHostUpdateCleanupRef.current = document.doc.subscribeLocalUpdates((bytes) => {
          connection.enqueueDocumentUpdate(bytes);
        });
        connection.connect();
      } catch (error) {
        if (options.shouldContinue && !options.shouldContinue()) return;
        setShareError(`${actionLabel}, but host sync did not start: ${errorToMessage(error)}`);
      }
    },
    [scheduleAutoSave, setSaveStateSynced, stopOwnerShareHost],
  );

  let handleEditorInput = useCallback(
    (value: string) => {
      editorValueRef.current = value;
      let backend = selectedFileBackendRef.current;
      let document = collabDocumentRef.current;
      if (backend && document) {
        void savePendingCollabDocumentUpdates(backend, document).catch(() => {});
      }
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
      let requestId = ++loadFileRequestRef.current;
      let isCurrentLoadRequest = () => loadFileRequestRef.current == requestId;

      setBusy(true);
      setErrorMessage("");
      setRetryLoadPath(null);

      try {
        if ((options.saveCurrent ?? true) && !(await saveCurrentFile())) return;
        if (!isCurrentLoadRequest()) return;

        let restoredShareRecord = await findOwnerShareRecordForPath(backend, file.path).catch(
          () => null,
        );
        if (!isCurrentLoadRequest()) return;
        let document = await openMarkdownCollabDocument(backend, file.path);
        if (!isCurrentLoadRequest()) {
          document.dispose();
          return;
        }
        let value = document.value;
        if (shareHostRecordRef.current?.path != file.path) stopOwnerShareHost();
        collabSyncCleanupRef.current();
        collabDocumentRef.current?.dispose();
        collabSyncCleanupRef.current = () => {};
        selectedFileRef.current = file;
        selectedFileBackendRef.current = backend;
        collabDocumentRef.current = document;
        if (document) {
          let handleRemoteDocumentUpdate = () => {
            if (selectedFileRef.current?.path != document.path) return;
            void (async () => {
              try {
                editorValueRef.current = getCollabDocumentValue(document);
                editVersionRef.current += 1;
                dirtyRef.current = true;
                setSaveStateSynced("pending");
                await saveCollabDocumentSnapshot(backend, document);
                scheduleAutoSave();
              } catch (error) {
                setSaveStateSynced("error");
                setErrorMessage(errorToMessage(error));
              }
            })();
          };
          collabSyncCleanupRef.current = createCollabDocumentBroadcastSync({
            backend,
            doc: document.doc,
            docId: document.docId,
            onRemoteUpdate: handleRemoteDocumentUpdate,
          });
        }
        let needsSourceWrite = document ? collabDocumentNeedsSourceWrite(document) : false;
        editorValueRef.current = value;
        cleanValueRef.current = value;
        dirtyRef.current = needsSourceWrite;
        editVersionRef.current = 0;
        setSelectedFile(file);
        setCollabDocument(document);
        setTreeSelection({ kind: "file", name: file.name, path: file.path });
        setEditorDocument((current) => ({
          path: file.path,
          value,
          version: current.version + 1,
        }));
        setSaveStateSynced(needsSourceWrite ? "pending" : "saved");
        setActiveShareRecord(restoredShareRecord);
        setCreatedShare(null);
        if (restoredShareRecord && document) {
          void startOwnerShareHost(restoredShareRecord, backend, document, {
            shouldContinue: isCurrentLoadRequest,
          });
        }
        if (needsSourceWrite) scheduleAutoSave();
        setRetryLoadPath(null);
      } catch (error) {
        if (!isCurrentLoadRequest()) return;
        setErrorMessage(errorToMessage(error));
        setRetryLoadPath(file.path);
      } finally {
        if (isCurrentLoadRequest()) setBusy(false);
      }
    },
    [
      saveCurrentFile,
      scheduleAutoSave,
      setSaveStateSynced,
      startOwnerShareHost,
      stopOwnerShareHost,
    ],
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
        loadFileRequestRef.current += 1;
        stopOwnerShareHost();
        collabSyncCleanupRef.current();
        collabSyncCleanupRef.current = () => {};
        collabDocumentRef.current?.dispose();
        selectedFileRef.current = null;
        selectedFileBackendRef.current = null;
        collabDocumentRef.current = null;
        editorValueRef.current = "";
        cleanValueRef.current = "";
        dirtyRef.current = false;
        editVersionRef.current = 0;
        setActiveShareRecord(null);
        setCreatedShare(null);
        setSelectedFile(null);
        setCollabDocument(null);
        setTreeSelection(null);
        setEditorDocument((current) => ({
          path: "",
          value: "",
          version: current.version + 1,
        }));
        setSaveStateSynced("idle");
      }
    },
    [loadFile, replaceImageAssets, setSaveStateSynced, stopOwnerShareHost],
  );

  let rememberWorkspaceHandle = useCallback((handle: AccessDirectoryHandle) => {
    setStoredWorkspaceHandle(handle);
    setStoredWorkspaceKind("local");
    void saveStoredWorkspaceHandle(handle).catch(() => {});
    saveStoredWorkspaceKind("local");
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
    setRetryLoadPath(null);
    if (!supportsDirectoryPicker()) {
      setErrorMessage(localFolderAccessUnavailableMessage());
      return;
    }

    setBusy(true);
    try {
      let handle = await pickWorkspaceDirectory();
      if (!(await ensureReadWritePermission(handle))) {
        setErrorMessage("Read-write folder permission was not granted.");
        setRetryLoadPath(null);
        return;
      }
      let backend = createLocalWorkspaceBackend(handle);
      dropboxTokenRef.current = null;
      dropboxTokenAppKeyRef.current = "";
      setWorkspaceBackend(backend);
      rememberWorkspaceHandle(handle);
      setSidebarOpen(defaultSidebarOpen());
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
      setRetryLoadPath(null);
      if (!options.skipSaveCurrent && !(await saveCurrentFile())) return false;

      let appKey = config.appKey.trim();
      if (!appKey) {
        setErrorMessage("Dropbox app key is required.");
        setRetryLoadPath(null);
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
        let { createDropboxWorkspaceBackend } = await import("@/lib/dropbox-workspace-backend");
        let backend = createDropboxWorkspaceBackend({
          getAccessToken,
          name: "Dropbox workspace",
          refreshAccessToken,
          root,
        });
        setWorkspaceBackend(backend);
        let storedConfig = root ? { appKey, root } : { appKey };
        setStoredDropboxConfig(storedConfig);
        setStoredWorkspaceKind("dropbox");
        saveStoredDropboxWorkspaceConfig(storedConfig);
        saveStoredWorkspaceKind("dropbox");
        setSidebarOpen(defaultSidebarOpen());
        await loadTree(backend, options.restoreDraft?.selectedPath ?? null, {
          saveBeforeSelect: false,
        });
        if (options.restoreDraft) restoreDropboxRedirectEditorDraft(backend, options.restoreDraft);
        return true;
      } catch (error) {
        setErrorMessage(errorToMessage(error));
        setRetryLoadPath(null);
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
    setRetryLoadPath(null);
    try {
      if (!(await ensureReadWritePermission(storedWorkspaceHandle))) {
        setErrorMessage("Read-write folder permission was not granted.");
        setRetryLoadPath(null);
        return;
      }

      let backend = createLocalWorkspaceBackend(storedWorkspaceHandle);
      dropboxTokenRef.current = null;
      dropboxTokenAppKeyRef.current = "";
      setWorkspaceBackend(backend);
      setSidebarOpen(defaultSidebarOpen());
      await loadTree(backend, null, { saveBeforeSelect: false });
    } catch (error) {
      setErrorMessage(errorToMessage(error));
      setRetryLoadPath(null);
    } finally {
      setBusy(false);
    }
  }, [loadTree, storedWorkspaceHandle]);

  let restoreDropboxWorkspace = useCallback(async () => {
    if (!storedDropboxConfig) return;
    let appKey = defaultDropboxAppKey();
    if (!appKey) {
      setErrorMessage(
        "Dropbox workspace is not configured. Set VITE_DROPBOX_APP_KEY for this app.",
      );
      setRetryLoadPath(null);
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
    setRetryLoadPath(null);
    try {
      await loadTree(workspaceBackend, selectedFileRef.current?.path ?? null);
    } catch (error) {
      setErrorMessage(errorToMessage(error));
      setRetryLoadPath(null);
    } finally {
      setBusy(false);
    }
  }, [loadTree, saveCurrentFile, workspaceBackend]);

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
          setRetryLoadPath(null);
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
    if (dropboxRedirectPendingRef.current) {
      setLocalRestoreChecked(true);
      return;
    }
    if (!browserSupported) {
      setLocalRestoreChecked(true);
      return;
    }
    if (workspaceBackend) {
      setLocalRestoreChecked(true);
      return;
    }
    if (storedWorkspaceKind == "dropbox" && storedDropboxConfig) {
      setLocalRestoreChecked(true);
      return;
    }

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
        setSidebarOpen(defaultSidebarOpen());
        await loadTree(backend, null, { saveBeforeSelect: false });
      } catch (error) {
        if (!canceled) setErrorMessage(errorToMessage(error));
      } finally {
        if (!canceled) {
          setRestoreChecking(false);
          setLocalRestoreChecked(true);
        }
      }
    })();

    return () => {
      canceled = true;
    };
  }, [browserSupported, loadTree, storedDropboxConfig, storedWorkspaceKind, workspaceBackend]);

  useEffect(() => {
    if (
      !localRestoreChecked ||
      dropboxRedirectPendingRef.current ||
      workspaceBackend ||
      !storedDropboxConfig ||
      dropboxAutoRestoreAttemptedRef.current
    ) {
      return;
    }
    if (storedWorkspaceKind && storedWorkspaceKind != "dropbox") return;
    if (!storedWorkspaceKind && storedWorkspaceHandle) return;

    dropboxAutoRestoreAttemptedRef.current = true;
    void openDropboxWorkspace(storedDropboxConfig, { skipSaveCurrent: true });
  }, [
    localRestoreChecked,
    openDropboxWorkspace,
    storedDropboxConfig,
    storedWorkspaceHandle,
    storedWorkspaceKind,
    workspaceBackend,
  ]);

  useEffect(
    () => () => {
      if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );

  let selectFile = useCallback(
    (file: MarkdownFileNode) => {
      if (!workspaceBackend) return;
      void loadFile(workspaceBackend, file);
      if (isMobileSidebarViewport()) setSidebarOpen(false);
    },
    [loadFile, workspaceBackend],
  );

  let toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => !open);
  }, []);

  let openCreateDialog = useCallback(
    (target: FileTreeDeleteTarget | null = treeSelection, kind: FileTreeCreateKind = "file") => {
      setFileDialogError("");
      setFileDialogTarget(null);
      setFileDialogValue(
        kind == "directory"
          ? defaultNewFolderPath(tree, target)
          : defaultNewFilePath(files, target),
      );
      setFileDialogMode("create");
    },
    [files, tree, treeSelection],
  );

  let openRenameDialog = useCallback(
    (target?: FileTreeDeleteTarget) => {
      let renameTarget =
        target ??
        (selectedFile
          ? {
              kind: "file" as const,
              name: selectedFile.name,
              path: selectedFile.path,
            }
          : null);
      if (!renameTarget) return;
      setFileDialogError("");
      setFileDialogTarget(renameTarget);
      setFileDialogValue(renameTarget.name);
      setFileDialogMode("rename");
    },
    [selectedFile],
  );

  let connectDropbox = () => {
    let appKey = defaultDropboxAppKey();
    if (!appKey) {
      setErrorMessage(
        "Dropbox workspace is not configured. Set VITE_DROPBOX_APP_KEY for this app.",
      );
      setRetryLoadPath(null);
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
      setFileDialogTarget(null);
      setFileDialogError("");
    }
  };

  let submitFileDialog = async (value: string) => {
    if (!workspaceBackend || !fileDialogMode) return;
    if (!(await saveCurrentFile())) return;

    setFileDialogError("");
    setBusy(true);
    setRetryLoadPath(null);
    try {
      let currentTarget = fileDialogTarget;
      let nextPath =
        fileDialogMode == "create"
          ? await workspaceBackend.createFile(value)
          : currentTarget?.kind == "file"
            ? await workspaceBackend.renameFile(currentTarget.path, value)
            : currentTarget?.kind == "directory"
              ? await renameWorkspaceDirectory(workspaceBackend, currentTarget.path, value)
              : null;
      let nextSelectedPath =
        currentTarget?.kind == "directory" && nextPath
          ? pathAfterDirectoryRename(
              selectedFileRef.current?.path ?? null,
              currentTarget.path,
              nextPath,
            )
          : nextPath;

      setFileDialogMode(null);
      setFileDialogTarget(null);
      await loadTree(workspaceBackend, nextSelectedPath ?? selectedFileRef.current?.path ?? null, {
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
    setRetryLoadPath(null);
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
      setRetryLoadPath(null);
    } finally {
      setBusy(false);
    }
  };

  let retryUnavailableCollabFile = useCallback(async () => {
    let backend = workspaceBackend;
    let retryPath = retryLoadPath;
    if (!backend || !retryPath) return;

    let file = files.find((item) => item.path == retryPath);
    if (!file) {
      await refreshWorkspace();
      return;
    }

    await loadFile(backend, file, { saveCurrent: false });
  }, [files, loadFile, refreshWorkspace, retryLoadPath, workspaceBackend]);

  let ensureSelectedCollabDocument = useCallback(
    async (backend: WorkspaceBackend, file: MarkdownFileNode) => {
      let current = collabDocumentRef.current;
      if (current?.path == file.path) return current;

      let document = await openMarkdownCollabDocument(backend, file.path);

      collabSyncCleanupRef.current();
      collabDocumentRef.current?.dispose();
      collabDocumentRef.current = document;
      collabSyncCleanupRef.current = createCollabDocumentBroadcastSync({
        backend,
        doc: document.doc,
        docId: document.docId,
        onRemoteUpdate: () => {
          if (selectedFileRef.current?.path != document.path) return;
          void (async () => {
            try {
              editorValueRef.current = getCollabDocumentValue(document);
              editVersionRef.current += 1;
              dirtyRef.current = true;
              setSaveStateSynced("pending");
              await saveCollabDocumentSnapshot(backend, document);
              scheduleAutoSave();
            } catch (error) {
              setSaveStateSynced("error");
              setErrorMessage(errorToMessage(error));
            }
          })();
        },
      });

      let value = document.value;
      let needsSourceWrite = collabDocumentNeedsSourceWrite(document);
      editorValueRef.current = value;
      cleanValueRef.current = value;
      dirtyRef.current = needsSourceWrite;
      editVersionRef.current += 1;
      setCollabDocument(document);
      setEditorDocument((currentDocument) => ({
        path: file.path,
        value,
        version: currentDocument.version + 1,
      }));
      setSaveStateSynced(needsSourceWrite ? "pending" : "saved");
      if (needsSourceWrite) scheduleAutoSave();
      return document;
    },
    [scheduleAutoSave, setSaveStateSynced],
  );

  let openShareDialog = useCallback(() => {
    setShareDialogOpen(true);
    setShareError("");
    setShareCopied(false);
    setCreatedShare(null);
    setShareExpiration("7d");
  }, []);

  let closeShareDialog = useCallback((open: boolean) => {
    setShareDialogOpen(open);
    if (!open) {
      setShareError("");
      setShareCopied(false);
    }
  }, []);

  let createSharedFileLink = useCallback(async () => {
    let backend = workspaceBackendRef.current;
    let file = selectedFileRef.current;
    if (!backend || !file) return;
    if (!(await saveCurrentFile())) return;

    setShareCreating(true);
    setShareError("");
    setShareCopied(false);
    try {
      let document = await ensureSelectedCollabDocument(backend, file);
      let share = await createOwnerShare({
        backend,
        baseUrl: window.location.href,
        document,
        expiration: shareExpiration,
        file,
        relayOrigin: configuredShareRelayOrigin(),
      });
      setCreatedShare(share);
      setActiveShareRecord(share.record);
      await startOwnerShareHost(share.record, backend, document);
    } catch (error) {
      setShareError(errorToMessage(error));
    } finally {
      setShareCreating(false);
    }
  }, [ensureSelectedCollabDocument, saveCurrentFile, shareExpiration, startOwnerShareHost]);

  let rotateSharedFileLink = useCallback(async () => {
    let backend = workspaceBackendRef.current;
    let record = activeShareRecord;
    if (!backend || !record || record.revokedAt != null) return;

    let document = collabDocumentRef.current;
    let shouldRestartHost = document?.path == record.path;
    let hostSecret = readHostSecret(record);
    if (!hostSecret) {
      setShareError("This browser cannot rotate the link without the host key.");
      return;
    }

    setShareCreating(true);
    setShareError("");
    setShareCopied(false);
    if (shouldRestartHost) stopOwnerShareHost();
    try {
      let share = await rotateOwnerShare({
        backend,
        baseUrl: window.location.href,
        expiration: shareExpiration,
        hostSecret,
        record,
        relayOrigin: configuredShareRelayOrigin(),
      });
      setCreatedShare(share);
      setActiveShareRecord(share.record);
      if (shouldRestartHost && document) {
        await startOwnerShareHost(share.record, backend, document, {
          actionLabel: "Link rotated",
        });
      }
    } catch (error) {
      setShareError(errorToMessage(error));
      if (shouldRestartHost && document) {
        void startOwnerShareHost(record, backend, document, {
          actionLabel: "Link rotation failed",
        });
      }
    } finally {
      setShareCreating(false);
    }
  }, [activeShareRecord, shareExpiration, startOwnerShareHost, stopOwnerShareHost]);

  let stopSharingFile = useCallback(async () => {
    let backend = workspaceBackendRef.current;
    let record = activeShareRecord;
    if (!backend || !record || record.revokedAt != null) return;

    let hostSecret = readHostSecret(record);
    if (!hostSecret) {
      setShareError("This browser cannot stop sharing without the host key.");
      return;
    }

    setShareCreating(true);
    setShareError("");
    setShareCopied(false);
    try {
      let nextRecord = await revokeOwnerShare({
        backend,
        hostSecret,
        record,
        relayOrigin: configuredShareRelayOrigin(),
      });
      stopOwnerShareHost();
      setActiveShareRecord(nextRecord);
      setCreatedShare(null);
    } catch (error) {
      setShareError(errorToMessage(error));
    } finally {
      setShareCreating(false);
    }
  }, [activeShareRecord, stopOwnerShareHost]);

  let copySharedFileLink = useCallback(async () => {
    if (!createdShare) return;

    try {
      await navigator.clipboard.writeText(createdShare.link);
      setShareCopied(true);
      setShareError("");
    } catch {
      setShareCopied(false);
      setShareError("Could not copy the link.");
    }
  }, [createdShare]);

  let exportCurrentFileAsHtml = useCallback(async () => {
    let file = selectedFileRef.current;
    if (!file) return;
    if (!(await saveCurrentFile())) return;

    let activeDocument =
      collabDocumentRef.current?.path == file.path ? collabDocumentRef.current : null;
    let markdown = activeDocument ? getCollabDocumentValue(activeDocument) : editorValueRef.current;

    setBusy(true);
    setErrorMessage("");
    try {
      let result = await createStandaloneMarkdownHtml({
        documentPath: file.path,
        markdown,
        resolveAsset(path) {
          return imageAssetsRef.current.get(path)?.file ?? null;
        },
        theme: snapshotMarkdownHtmlExportTheme(editorElementRef.current),
        title: htmlExportTitle(file.name),
      });

      downloadTextFile(htmlExportFileName(file.name), result.html, "text/html;charset=utf-8");
      if (result.warnings.length) {
        setErrorMessage(markdownHtmlExportWarningMessage(result.warnings.length));
      }
    } catch (error) {
      setErrorMessage(errorToMessage(error));
    } finally {
      setBusy(false);
    }
  }, [saveCurrentFile]);

  let resolveImageSource = useMemo<LiveMdImageSourceResolver>(() => {
    return (source) => {
      let imagePath = resolveMarkdownImagePath(source, editorDocument.path);
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
  let storageLabel = useMemo(() => workspaceStorageLabel(workspaceBackend), [workspaceBackend]);
  let activeShareForSelectedFile =
    activeShareRecord &&
    activeShareRecord.path == selectedFile?.path &&
    activeShareRecord.revokedAt == null
      ? activeShareRecord
      : null;
  let restoreAvailable = Boolean(storedWorkspaceHandle);
  let dropboxRestoreAvailable = Boolean(storedDropboxConfig);

  return (
    <TooltipProvider>
      <div className="flex h-svh min-h-0 overflow-hidden bg-background text-foreground">
        <aside
          className={cn(
            "flex w-[19rem] shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:w-[min(21rem,88vw)]",
            !sidebarOpen && "hidden",
          )}
        >
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <GroveMark className="size-8" decorative />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{rootName}</div>
              {workspaceBackend && (
                <div className="truncate text-xs text-sidebar-foreground/55">
                  {files.length == 1 ? "1 markdown file" : `${files.length} markdown files`}
                </div>
              )}
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
              onClick={() => openCreateDialog()}
              disabled={!workspaceBackend || busy}
            >
              <PlusIcon data-icon="inline-start" />
            </TooltipIconButton>
          </div>
          {tree ? (
            <FileTree
              root={tree}
              selectedPath={selectedPath}
              onCreateEntry={openCreateDialog}
              onDeleteEntry={requestDeleteEntry}
              onRenameEntry={openRenameDialog}
              onSelectEntry={setTreeSelection}
              onSelectFile={selectFile}
            />
          ) : (
            <div className="min-h-0 flex-1" />
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
              onClick={toggleSidebar}
            >
              <MenuIcon data-icon="inline-start" />
            </TooltipIconButton>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{headerTitle}</div>
              {headerSubtitle && (
                <div className="truncate text-xs text-muted-foreground">{headerSubtitle}</div>
              )}
            </div>
            <Badge variant={saveState == "error" ? "destructive" : "secondary"}>
              <SaveIcon data-icon="inline-start" />
              {saveLabel}
            </Badge>
            {workspaceBackend && storageLabel && (
              <Badge className="max-md:hidden" variant="secondary">
                {workspaceBackend.kind == "opendal-dropbox" ? (
                  <CloudIcon data-icon="inline-start" />
                ) : (
                  <FolderOpenIcon data-icon="inline-start" />
                )}
                {storageLabel}
              </Badge>
            )}
            {activeShareForSelectedFile && (
              <Badge className="max-md:hidden" variant="secondary">
                <Share2Icon data-icon="inline-start" />
                Shared file
              </Badge>
            )}
            <ThemeSelector className="max-md:hidden" />
            <input
              ref={imageInputRef}
              className="sr-only"
              type="file"
              accept="image/*"
              multiple
              onChange={handleImageInputChange}
            />
            <TooltipIconButton
              className="max-md:hidden"
              label="Share file"
              size="icon-sm"
              variant="ghost"
              disabled={!selectedFile || busy}
              onClick={openShareDialog}
            >
              <Share2Icon data-icon="inline-start" />
            </TooltipIconButton>
            <TooltipIconButton
              className="max-md:hidden"
              label="Insert image"
              size="icon-sm"
              variant="ghost"
              disabled={!workspaceBackend?.createImageAsset || !selectedFile || busy}
              onClick={() => imageInputRef.current?.click()}
            >
              <ImagePlusIcon data-icon="inline-start" />
            </TooltipIconButton>
            <TooltipIconButton
              className="max-md:hidden"
              label="Export HTML"
              size="icon-sm"
              variant="ghost"
              disabled={!selectedFile || busy}
              onClick={() => void exportCurrentFileAsHtml()}
            >
              <DownloadIcon data-icon="inline-start" />
            </TooltipIconButton>
            <TooltipIconButton
              className="max-md:hidden"
              label="Refresh"
              size="icon-sm"
              variant="ghost"
              disabled={!workspaceBackend || busy}
              onClick={() => void refreshWorkspace()}
            >
              <RefreshCwIcon data-icon="inline-start" />
            </TooltipIconButton>
            <MobileWorkspaceActions
              activeShare={Boolean(activeShareForSelectedFile)}
              busy={busy}
              canInsertImage={Boolean(workspaceBackend?.createImageAsset && selectedFile)}
              canRefresh={Boolean(workspaceBackend)}
              selectedFile={Boolean(selectedFile)}
              storageKind={workspaceBackend?.kind ?? null}
              storageLabel={storageLabel}
              onExportHtml={() => void exportCurrentFileAsHtml()}
              onInsertImage={() => imageInputRef.current?.click()}
              onRefresh={() => void refreshWorkspace()}
              onShareFile={openShareDialog}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild className="max-md:hidden" size="icon-sm" variant="ghost">
                  <a
                    aria-label="Open GitHub repository"
                    href={githubRepositoryUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <GitHubIcon data-icon="inline-start" />
                    <span className="sr-only">GitHub repository</span>
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>GitHub repository</TooltipContent>
            </Tooltip>
          </header>

          {errorMessage && (
            <div className="flex items-center gap-2 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <div className="min-w-0 flex-1">{errorMessage}</div>
              {retryLoadPath && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void retryUnavailableCollabFile()}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  Retry
                </Button>
              )}
            </div>
          )}

          <section className="local-md-editor min-h-0 flex-1">
            {selectedFile ? (
              <LiveMdEditor
                documentKey={`${editorDocument.path}:${editorDocument.version}`}
                extensions={collabDocument?.extensions ?? emptyEditorExtensions}
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
                folderAccessUnavailableMessage={folderAccessUnavailableMessage}
                hasWorkspace={Boolean(workspaceBackend)}
                dropboxConnecting={dropboxConnecting}
                dropboxRestoreAvailable={dropboxRestoreAvailable}
                restoreAvailable={restoreAvailable}
                restoreChecking={restoreChecking}
                onCreateFile={() => openCreateDialog()}
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

        <ShareFileDialog
          activeShare={activeShareForSelectedFile}
          busy={busy || shareCreating}
          copied={shareCopied}
          error={shareError}
          expiration={shareExpiration}
          file={selectedFile}
          link={createdShare?.link ?? ""}
          open={shareDialogOpen}
          shared={Boolean(activeShareForSelectedFile)}
          onCopyLink={copySharedFileLink}
          onCreateLink={createSharedFileLink}
          onExpirationChange={setShareExpiration}
          onOpenChange={closeShareDialog}
          onRotateLink={rotateSharedFileLink}
          onStopSharing={stopSharingFile}
        />

        <WorkspaceCommandPalette
          browserSupported={browserSupported}
          busy={busy}
          canInsertImage={Boolean(workspaceBackend?.createImageAsset && selectedFile)}
          disabled={fileDialogMode != null || shareDialogOpen || deleteTarget != null}
          dropboxConnecting={dropboxConnecting}
          files={files}
          selectedPath={selectedPath}
          sidebarOpen={sidebarOpen}
          onConnectDropbox={connectDropbox}
          onInsertImage={() => imageInputRef.current?.click()}
          onOpenFolder={() => void openWorkspace()}
          onSelectFile={selectFile}
          onToggleSidebar={toggleSidebar}
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

type MobileWorkspaceActionsProps = {
  activeShare: boolean;
  busy: boolean;
  canInsertImage: boolean;
  canRefresh: boolean;
  selectedFile: boolean;
  storageKind: WorkspaceBackend["kind"] | null;
  storageLabel: string;
  onExportHtml: () => void;
  onInsertImage: () => void;
  onRefresh: () => void;
  onShareFile: () => void;
};

function MobileWorkspaceActions({
  activeShare,
  busy,
  canInsertImage,
  canRefresh,
  selectedFile,
  storageKind,
  storageLabel,
  onExportHtml,
  onInsertImage,
  onRefresh,
  onShareFile,
}: MobileWorkspaceActionsProps) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button aria-label="More actions" className="md:hidden" size="icon-sm" variant="ghost">
          <EllipsisIcon data-icon="inline-start" />
          <span className="sr-only">More actions</span>
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={8}
          className="z-50 flex min-w-56 max-w-[calc(100vw-1rem)] flex-col gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          {(storageLabel || activeShare) && (
            <>
              <div className="flex flex-col gap-1 px-2 py-1.5 text-xs text-muted-foreground">
                {storageLabel && (
                  <div className="flex min-w-0 items-center gap-2">
                    {storageKind == "opendal-dropbox" ? (
                      <CloudIcon className="size-3.5 shrink-0" />
                    ) : (
                      <FolderOpenIcon className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{storageLabel}</span>
                  </div>
                )}
                {activeShare && (
                  <div className="flex min-w-0 items-center gap-2">
                    <Share2Icon className="size-3.5 shrink-0" />
                    <span className="truncate">Shared file</span>
                  </div>
                )}
              </div>
              <DropdownMenuPrimitive.Separator className="-mx-1 h-px bg-border" />
            </>
          )}
          <MobileDropdownItem disabled={!selectedFile || busy} onSelect={onShareFile}>
            <Share2Icon />
            Share file
          </MobileDropdownItem>
          <MobileDropdownItem disabled={!canInsertImage || busy} onSelect={onInsertImage}>
            <ImagePlusIcon />
            Insert image
          </MobileDropdownItem>
          <MobileDropdownItem disabled={!selectedFile || busy} onSelect={onExportHtml}>
            <DownloadIcon />
            Export HTML
          </MobileDropdownItem>
          <MobileDropdownItem disabled={!canRefresh || busy} onSelect={onRefresh}>
            <RefreshCwIcon />
            Refresh
          </MobileDropdownItem>
          <ThemeDropdownSubmenu itemClassName={mobileDropdownItemClassName} />
          <DropdownMenuPrimitive.Separator className="-mx-1 h-px bg-border" />
          <DropdownMenuPrimitive.Item asChild>
            <a
              aria-label="Open GitHub repository"
              className={mobileDropdownItemClassName}
              href={githubRepositoryUrl}
              rel="noreferrer"
              target="_blank"
            >
              <GitHubIcon data-icon="inline-start" />
              GitHub repository
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

function GitHubIcon(props: ComponentProps<"svg">) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" {...props}>
      <path
        fill="currentColor"
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
      />
    </svg>
  );
}

type WorkspaceEmptyProps = {
  browserSupported: boolean;
  busy: boolean;
  dropboxConnecting: boolean;
  dropboxRestoreAvailable: boolean;
  folderAccessUnavailableMessage: string;
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
  folderAccessUnavailableMessage,
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
      {!browserSupported && (
        <EmptyHeader>
          <EmptyTitle>Local folder access unavailable</EmptyTitle>
          <EmptyDescription>{folderAccessUnavailableMessage}</EmptyDescription>
        </EmptyHeader>
      )}
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
              Continue previous folder
            </Button>
            {dropboxRestoreAvailable && (
              <Button
                variant="outline"
                onClick={onRestoreDropbox}
                disabled={busy || dropboxConnecting}
              >
                <CloudIcon data-icon="inline-start" />
                Continue Dropbox
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
              Continue Dropbox
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
            <DialogTitle>{createMode ? "New file or folder" : "Rename"}</DialogTitle>
            <DialogDescription className="sr-only">
              {createMode
                ? "Create a Markdown file or folder path."
                : "Rename the selected file or folder."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor={inputId}>{createMode ? "Path" : "Name"}</FieldLabel>
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

type ShareFileDialogProps = {
  activeShare: ActiveOwnerShareRecord | null;
  busy: boolean;
  copied: boolean;
  error: string;
  expiration: ShareExpirationOption;
  file: MarkdownFileNode | null;
  link: string;
  open: boolean;
  shared: boolean;
  onCopyLink: () => Promise<void>;
  onCreateLink: () => Promise<void>;
  onExpirationChange: (value: ShareExpirationOption) => void;
  onOpenChange: (open: boolean) => void;
  onRotateLink: () => Promise<void>;
  onStopSharing: () => Promise<void>;
};

function ShareFileDialog({
  activeShare,
  busy,
  copied,
  error,
  expiration,
  file,
  link,
  open,
  shared,
  onCopyLink,
  onCreateLink,
  onExpirationChange,
  onOpenChange,
  onRotateLink,
  onStopSharing,
}: ShareFileDialogProps) {
  let expirationId = "shared-file-expiration";
  let linkId = "shared-file-link";
  let filePath = file?.path ?? "No file selected";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <div className="flex max-h-[min(720px,calc(100svh-2rem))] flex-col">
          <DialogHeader className="border-b bg-muted/30 px-5 py-4 pr-12">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                <Share2Icon className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-lg">Share file</DialogTitle>
                <DialogDescription className="mt-1 flex min-w-0 items-center gap-1.5">
                  <FileTextIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{filePath}</span>
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {link ? (
              <div className="rounded-lg border bg-card/60 p-3">
                <div className="mb-2 flex min-w-0 items-center gap-2">
                  <LinkIcon className="size-4 shrink-0 text-primary" />
                  <div className="text-sm font-medium">Edit link</div>
                </div>
                <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
                  Anyone with this link can edit this file.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id={linkId}
                    readOnly
                    value={link}
                    className="h-8 min-w-0 flex-1 bg-background/70 font-mono text-xs text-muted-foreground"
                  />
                  <Button type="button" disabled={busy} onClick={onCopyLink}>
                    <CopyIcon data-icon="inline-start" />
                    {copied ? "Copied" : "Copy link"}
                  </Button>
                </div>
              </div>
            ) : shared ? (
              <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3">
                <LinkIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Anyone with this link can edit this file. Rotate the link to copy a fresh guest
                  URL.
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/10 p-3">
                <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">Create an edit link</div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Anyone with this link can edit this file. Guests only see this file.
                  </p>
                </div>
              </div>
            )}

            {shared && (
              <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:gap-4">
                <div className="flex items-center gap-2">
                  <UserRoundIcon className="size-4 shrink-0" />
                  <span>{formatGuestCount(activeShare?.guestCount)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock3Icon className="size-4 shrink-0" />
                  <span>{formatCurrentShareExpiration(activeShare?.expiresAt)}</span>
                </div>
              </div>
            )}

            <Field className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <FieldLabel htmlFor={expirationId}>
                    {shared ? "Rotate expires" : "Expires"}
                  </FieldLabel>
                  <p className="text-xs text-muted-foreground">
                    {shared ? "New guest links" : formatExpirationHint(expiration)}
                  </p>
                </div>
                <select
                  id={expirationId}
                  className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy}
                  value={expiration}
                  onChange={(event) =>
                    onExpirationChange(event.currentTarget.value as ShareExpirationOption)
                  }
                >
                  <option value="24h">24h</option>
                  <option value="7d">7 days</option>
                  <option value="30d">30 days</option>
                </select>
              </div>
            </Field>
          </div>

          <DialogFooter className="mx-0 mb-0 rounded-none bg-muted/30 px-5 py-3 sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            {shared ? (
              <>
                <Button type="button" variant="destructive" disabled={busy} onClick={onStopSharing}>
                  Stop sharing
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={onRotateLink}>
                  <RefreshCwIcon data-icon="inline-start" />
                  Rotate link
                </Button>
              </>
            ) : (
              <Button type="button" disabled={busy || !file} onClick={onCreateLink}>
                <Share2Icon data-icon="inline-start" />
                Create link
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatGuestCount(count: number | undefined) {
  if (count == null) return "Unknown";
  return count == 1 ? "1 guest" : `${count} guests`;
}

function formatCurrentShareExpiration(expiresAt: number | null | undefined) {
  if (expiresAt == null) return "Current link expiration unknown";
  let prefix = expiresAt <= Date.now() ? "Current link expired" : "Current link expires";
  return `${prefix} ${formatTimestamp(expiresAt)}`;
}

function formatExpirationHint(expiration: ShareExpirationOption) {
  switch (expiration) {
    case "24h":
      return "Short review";
    case "7d":
      return "Default";
    case "30d":
      return "Long-running";
  }
}

function formatTimestamp(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
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

function htmlExportTitle(fileName: string) {
  return fileName.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || "Markdown export";
}

function htmlExportFileName(fileName: string) {
  let baseName = fileName.replace(/\.md$/i, "").trim() || "markdown-export";
  return `${sanitizeExportFileName(baseName)}.html`;
}

function sanitizeExportFileName(value: string) {
  let sanitized = "";
  for (let character of value) {
    sanitized +=
      character.charCodeAt(0) < 32 || invalidExportFileNameCharacters.has(character)
        ? "-"
        : character;
  }
  return sanitized.replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "export";
}

const invalidExportFileNameCharacters = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);

function markdownHtmlExportWarningMessage(count: number) {
  return count == 1
    ? "Exported HTML, but 1 image could not be embedded."
    : `Exported HTML, but ${count} images could not be embedded.`;
}

function downloadTextFile(fileName: string, value: string, type: string) {
  let blob = new Blob([value], { type });
  let url = URL.createObjectURL(blob);
  let anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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

async function renameWorkspaceDirectory(backend: WorkspaceBackend, path: string, rawName: string) {
  if (!backend.renameDirectory) throw new Error("This workspace cannot rename folders.");
  return backend.renameDirectory(path, rawName);
}

function pathAfterDirectoryRename(
  selectedPath: string | null,
  currentDirectoryPath: string,
  nextDirectoryPath: string,
) {
  if (!selectedPath?.startsWith(`${currentDirectoryPath}/`)) return selectedPath;
  return `${nextDirectoryPath}${selectedPath.slice(currentDirectoryPath.length)}`;
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

function defaultNewFolderPath(
  tree: MarkdownDirectoryNode | null,
  selection: FileTreeDeleteTarget | null,
) {
  let parentPath =
    selection?.kind == "directory"
      ? selection.path
      : selection?.kind == "file"
        ? directoryPath(selection.path)
        : "";
  let directoryPaths = tree ? collectDirectoryPaths(tree) : new Set<string>();
  let basePath = joinWorkspacePath(parentPath, "New folder");
  if (!directoryPaths.has(basePath)) return `${basePath}/`;

  for (let index = 2; index < 1000; index += 1) {
    let path = joinWorkspacePath(parentPath, `New folder ${index}`);
    if (!directoryPaths.has(path)) return `${path}/`;
  }

  return joinWorkspacePath(parentPath, "Untitled folder/");
}

function collectDirectoryPaths(root: MarkdownDirectoryNode) {
  let paths = new Set<string>();
  let visit = (directory: MarkdownDirectoryNode) => {
    if (directory.path) paths.add(directory.path);
    for (let child of directory.children) {
      if (child.kind == "directory") visit(child);
    }
  };
  visit(root);
  return paths;
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

function workspaceStorageLabel(backend: WorkspaceBackend | null) {
  if (!backend) return "";
  return backend.kind == "opendal-dropbox" ? "Dropbox" : "Local";
}

function mergeOwnerShareStatus(
  record: ActiveOwnerShareRecord,
  status: ShareRelayStatus,
): ActiveOwnerShareRecord {
  return {
    ...record,
    expiresAt: status.expiresAt,
    guestCount: status.guestCount,
    hostOnline: status.hostOnline,
    peerCount: status.peerCount,
    pendingHostSave: status.pendingHostSave,
  };
}

function readHostSecret(record: OwnerShareRecord) {
  try {
    return (
      localStorage.getItem(record.hostSecretRef) ??
      localStorage.getItem(hostSecretStorageKey(record.shareId))
    );
  } catch {
    return null;
  }
}

function serializeVersionVector(version: VersionVector) {
  return [...version.toJSON()].map(([peer, counter]) => [String(peer), counter]);
}

function getOrCreateOwnerShareClientId() {
  try {
    let existing = sessionStorage.getItem("local-md-workspace:owner-share-client-id");
    if (existing) return existing;
    let next = crypto.randomUUID();
    sessionStorage.setItem("local-md-workspace:owner-share-client-id", next);
    return next;
  } catch {
    return crypto.randomUUID();
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
