import type { FileTreeDeleteTarget } from "@/components/FileTree";
import type { DocumentRecoveryAction } from "@/components/workspace/DocumentRecoveryDialogs";
import type { WorkspaceCollaborativeDocument } from "@/lib/workspace/documents";
import { defaultSidebarOpen } from "@/lib/workspace/constants";
import {
  loadStoredDropboxWorkspaceConfig,
  loadStoredWorkspaceKind,
  type StoredDropboxWorkspaceConfig,
  type StoredLocalWorkspaceRecord,
  type StoredWorkspaceKind,
} from "@/lib/workspace/store";
import type { MarkdownDirectoryNode, MarkdownFileNode } from "@/lib/workspace/tree";
import type { SaveState, SingleFileSource } from "@/lib/workspace/types";
import type {
  DocumentSourceState,
  WorkspaceIdentity,
  WorkspaceRuntime,
} from "@/lib/workspace/runtime/types";
import { createStore, type StoreApi } from "zustand/vanilla";

export type WorkspaceDocumentOpening = {
  path: string;
};

export type WorkspaceDocumentView = {
  document: WorkspaceCollaborativeDocument;
  file: MarkdownFileNode;
  saveState: SaveState;
  value: string;
};

/**
 * Key for the editor document. The document text itself is not stored here:
 * it lives in the Loro document (workspace files) or the editor session
 * (standalone files) and is read through {@link workspaceLiveObjects}.
 */
export type WorkspaceEditorDocumentKey = {
  path: string;
  version: number;
};

/** Plain-data description of the active workspace runtime. */
export type WorkspaceRuntimeKey = {
  generation: number;
  identity: WorkspaceIdentity;
};

/** Plain-data description of the collaborative document shown in the editor. */
export type WorkspaceDocumentViewKey = {
  docId: string;
  generation: number;
  path: string;
};

export type WorkspaceDocumentSourceKind = DocumentSourceState["kind"];

export type WorkspaceAppSnapshot = {
  agentActivated: boolean;
  agentOpen: boolean;
  busy: boolean;
  documentSourceKind: WorkspaceDocumentSourceKind | null;
  documentView: WorkspaceDocumentViewKey | null;
  dropboxConnecting: boolean;
  editorDocument: WorkspaceEditorDocumentKey;
  errorMessage: string;
  openingDocument: WorkspaceDocumentOpening | null;
  recoveryCopyPath: string;
  recoveryDialogAction: DocumentRecoveryAction | null;
  recoveryDialogError: string;
  restoreChecking: boolean;
  retryLoadPath: string | null;
  saveState: SaveState;
  selectedFile: MarkdownFileNode | null;
  sidebarOpen: boolean;
  singleFileSource: SingleFileSource | null;
  storedDropboxConfig: StoredDropboxWorkspaceConfig | null;
  storedLocalWorkspace: StoredLocalWorkspaceRecord | null;
  storedWorkspaceKind: StoredWorkspaceKind | null;
  tree: MarkdownDirectoryNode | null;
  treeSelection: FileTreeDeleteTarget | null;
  workspace: WorkspaceRuntimeKey | null;
  workspacePermission: PermissionState | null;
};

/**
 * Live, disposable objects that back the plain keys in the store. They are
 * owned by the workspace lifecycle code and must not be put in Zustand state.
 */
export type WorkspaceLiveObjects = {
  collabDocument: WorkspaceCollaborativeDocument | null;
  editorValue: string;
  generation: number;
  workspaceRuntime: WorkspaceRuntime | null;
};

const liveObjectsByStore = new WeakMap<WorkspaceAppStore, WorkspaceLiveObjects>();

export function workspaceLiveObjects(store: WorkspaceAppStore): WorkspaceLiveObjects {
  let live = liveObjectsByStore.get(store);
  if (!live) {
    live = { collabDocument: null, editorValue: "", generation: 0, workspaceRuntime: null };
    liveObjectsByStore.set(store, live);
  }
  return live;
}

export type WorkspaceStateUpdate<Value> = Value | ((current: Value) => Value);
export type WorkspaceStateSetter<Value> = (update: WorkspaceStateUpdate<Value>) => void;

export type WorkspaceAppState = WorkspaceAppSnapshot & {
  setField<Key extends keyof WorkspaceAppSnapshot>(
    key: Key,
    update: WorkspaceStateUpdate<WorkspaceAppSnapshot[Key]>,
  ): void;
};

export type WorkspaceAppStore = StoreApi<WorkspaceAppState>;

export type WorkspaceAppSetters = {
  setAgentActivated: WorkspaceStateSetter<boolean>;
  setAgentOpen: WorkspaceStateSetter<boolean>;
  setBusy: WorkspaceStateSetter<boolean>;
  setDropboxConnecting: WorkspaceStateSetter<boolean>;
  setErrorMessage: WorkspaceStateSetter<string>;
  setRecoveryCopyPath: WorkspaceStateSetter<string>;
  setRecoveryDialogAction: WorkspaceStateSetter<DocumentRecoveryAction | null>;
  setRecoveryDialogError: WorkspaceStateSetter<string>;
  setRestoreChecking: WorkspaceStateSetter<boolean>;
  setRetryLoadPath: WorkspaceStateSetter<string | null>;
  setSaveState: WorkspaceStateSetter<SaveState>;
  setSidebarOpen: WorkspaceStateSetter<boolean>;
  setStoredDropboxConfig: WorkspaceStateSetter<StoredDropboxWorkspaceConfig | null>;
  setStoredLocalWorkspace: WorkspaceStateSetter<StoredLocalWorkspaceRecord | null>;
  setStoredWorkspaceKind: WorkspaceStateSetter<StoredWorkspaceKind | null>;
  setTree: WorkspaceStateSetter<MarkdownDirectoryNode | null>;
  setTreeSelection: WorkspaceStateSetter<FileTreeDeleteTarget | null>;
};

export function createWorkspaceAppStore(): WorkspaceAppStore {
  return createStore<WorkspaceAppState>()((set) => ({
    ...createInitialWorkspaceAppSnapshot(),
    setField(key, update) {
      set((state) => ({
        [key]: resolveWorkspaceStateUpdate(update, state[key]),
      }));
    },
  }));
}

export function createWorkspaceAppSetters(store: WorkspaceAppStore): WorkspaceAppSetters {
  let setter = <Key extends keyof WorkspaceAppSnapshot>(key: Key) =>
    ((update: WorkspaceStateUpdate<WorkspaceAppSnapshot[Key]>) => {
      store.getState().setField(key, update);
    }) as WorkspaceStateSetter<WorkspaceAppSnapshot[Key]>;

  return {
    setAgentActivated: setter("agentActivated"),
    setAgentOpen: setter("agentOpen"),
    setBusy: setter("busy"),
    setDropboxConnecting: setter("dropboxConnecting"),
    setErrorMessage: setter("errorMessage"),
    setRecoveryCopyPath: setter("recoveryCopyPath"),
    setRecoveryDialogAction: setter("recoveryDialogAction"),
    setRecoveryDialogError: setter("recoveryDialogError"),
    setRestoreChecking: setter("restoreChecking"),
    setRetryLoadPath: setter("retryLoadPath"),
    setSaveState: setter("saveState"),
    setSidebarOpen: setter("sidebarOpen"),
    setStoredDropboxConfig: setter("storedDropboxConfig"),
    setStoredLocalWorkspace: setter("storedLocalWorkspace"),
    setStoredWorkspaceKind: setter("storedWorkspaceKind"),
    setTree: setter("tree"),
    setTreeSelection: setter("treeSelection"),
  };
}

/** Installs the active workspace runtime and publishes its plain-data key. */
export function publishWorkspaceRuntime(
  store: WorkspaceAppStore,
  runtime: WorkspaceRuntime | null,
) {
  let live = workspaceLiveObjects(store);
  live.workspaceRuntime = runtime;
  store.setState({
    workspace: runtime ? { generation: ++live.generation, identity: runtime.identity } : null,
    workspacePermission: runtime?.host.permission?.state ?? null,
  });
}

/**
 * Publishes new editor text. The version only changes when the path or text
 * differs from the last published value, matching the editor's reset contract.
 */
export function publishEditorDocumentValue(
  store: WorkspaceAppStore,
  next: { path: string; value: string },
) {
  let live = workspaceLiveObjects(store);
  let current = store.getState().editorDocument;
  if (current.path == next.path && live.editorValue == next.value) return;
  live.editorValue = next.value;
  store.setState({ editorDocument: { path: next.path, version: current.version + 1 } });
}

export function publishWorkspaceDocumentOpening(
  store: WorkspaceAppStore,
  opening: WorkspaceDocumentOpening,
  currentValue?: string,
) {
  if (currentValue != null) workspaceLiveObjects(store).editorValue = currentValue;
  store.setState({ openingDocument: opening });
}

export function clearWorkspaceDocumentOpening(store: WorkspaceAppStore) {
  store.setState({ openingDocument: null });
}

export function clearWorkspaceDocumentView(store: WorkspaceAppStore, preserveOpening = false) {
  let live = workspaceLiveObjects(store);
  live.collabDocument = null;
  live.editorValue = "";
  store.setState((state) => ({
    documentSourceKind: null,
    documentView: null,
    editorDocument: {
      path: "",
      version: state.editorDocument.version + 1,
    },
    openingDocument: preserveOpening ? state.openingDocument : null,
    saveState: "idle",
    selectedFile: null,
    singleFileSource: null,
    treeSelection: null,
  }));
}

export function publishSingleFileDocumentView(
  store: WorkspaceAppStore,
  input: {
    file: MarkdownFileNode;
    singleFileSource: SingleFileSource;
    value: string;
  },
) {
  let live = workspaceLiveObjects(store);
  live.collabDocument = null;
  live.editorValue = input.value;
  store.setState((state) => ({
    documentSourceKind: null,
    documentView: null,
    editorDocument: {
      path: input.file.path,
      version: state.editorDocument.version + 1,
    },
    openingDocument: null,
    saveState: "saved",
    selectedFile: input.file,
    singleFileSource: input.singleFileSource,
    treeSelection: null,
  }));
}

export function publishWorkspaceDocumentView(
  store: WorkspaceAppStore,
  input: WorkspaceDocumentView,
) {
  let live = workspaceLiveObjects(store);
  live.collabDocument = input.document;
  live.editorValue = input.value;
  store.setState((state) => ({
    documentSourceKind: documentSourceKind(input.document),
    documentView: {
      docId: input.document.docId,
      generation: ++live.generation,
      path: input.document.path,
    },
    editorDocument: {
      path: input.file.path,
      version: state.editorDocument.version + 1,
    },
    openingDocument: null,
    saveState: input.saveState,
    selectedFile: input.file,
    singleFileSource: null,
    treeSelection: {
      kind: "file",
      name: input.file.name,
      path: input.file.path,
    },
  }));
}

/** Refreshes the source status of the displayed document after it changes. */
export function publishWorkspaceDocumentSourceKind(
  store: WorkspaceAppStore,
  document: WorkspaceCollaborativeDocument,
) {
  if (workspaceLiveObjects(store).collabDocument !== document) return;
  let next = documentSourceKind(document);
  if (store.getState().documentSourceKind != next) store.setState({ documentSourceKind: next });
}

function documentSourceKind(
  document: WorkspaceCollaborativeDocument,
): WorkspaceDocumentSourceKind | null {
  // Test doubles may omit collaboration state.
  let state = document.collabState as WorkspaceCollaborativeDocument["collabState"] | undefined;
  return state?.source.kind ?? null;
}

function createInitialWorkspaceAppSnapshot(): WorkspaceAppSnapshot {
  return {
    agentActivated: false,
    agentOpen: false,
    busy: false,
    documentSourceKind: null,
    documentView: null,
    dropboxConnecting: false,
    editorDocument: { path: "", version: 0 },
    errorMessage: "",
    openingDocument: null,
    recoveryCopyPath: "",
    recoveryDialogAction: null,
    recoveryDialogError: "",
    restoreChecking: false,
    retryLoadPath: null,
    saveState: "idle",
    selectedFile: null,
    sidebarOpen: defaultSidebarOpen(),
    singleFileSource: null,
    storedDropboxConfig: loadStoredDropboxWorkspaceConfig(),
    storedLocalWorkspace: null,
    storedWorkspaceKind: loadStoredWorkspaceKind(),
    tree: null,
    treeSelection: null,
    workspace: null,
    workspacePermission: null,
  };
}

function resolveWorkspaceStateUpdate<Value>(
  update: WorkspaceStateUpdate<Value>,
  current: Value,
): Value {
  return typeof update == "function" ? (update as (current: Value) => Value)(current) : update;
}
