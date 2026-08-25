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
import type { EditorDocument, SaveState, SingleFileSource } from "@/lib/workspace/types";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";
import { createStore, type StoreApi } from "zustand/vanilla";

export type WorkspaceDocumentOpening = {
  intentId: number;
  path: string;
};

export type WorkspaceDocumentView = {
  document: WorkspaceCollaborativeDocument;
  file: MarkdownFileNode;
  saveState: SaveState;
  value: string;
};

export type WorkspaceAppSnapshot = {
  agentActivated: boolean;
  agentOpen: boolean;
  busy: boolean;
  collabDocument: WorkspaceCollaborativeDocument | null;
  dropboxConnecting: boolean;
  editorDocument: EditorDocument;
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
  workspaceRuntime: WorkspaceRuntime | null;
};

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
  setEditorDocument: WorkspaceStateSetter<EditorDocument>;
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
  setWorkspaceRuntime: WorkspaceStateSetter<WorkspaceRuntime | null>;
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
    setEditorDocument: setter("editorDocument"),
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
    setWorkspaceRuntime: setter("workspaceRuntime"),
  };
}

export function publishWorkspaceDocumentOpening(
  store: WorkspaceAppStore,
  opening: WorkspaceDocumentOpening,
  activeValue?: string,
) {
  store.setState((state) => ({
    editorDocument:
      activeValue == null ? state.editorDocument : { ...state.editorDocument, value: activeValue },
    openingDocument: opening,
  }));
}

export function clearWorkspaceDocumentOpening(store: WorkspaceAppStore, intentId: number) {
  store.setState((state) =>
    state.openingDocument?.intentId == intentId ? { openingDocument: null } : state,
  );
}

export function clearWorkspaceDocumentView(store: WorkspaceAppStore, preserveOpening = false) {
  store.setState((state) => ({
    collabDocument: null,
    editorDocument: {
      path: "",
      value: "",
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
  store.setState((state) => ({
    collabDocument: null,
    editorDocument: {
      path: input.file.path,
      value: input.value,
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
  store.setState((state) => ({
    collabDocument: input.document,
    editorDocument: {
      path: input.file.path,
      value: input.value,
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

function createInitialWorkspaceAppSnapshot(): WorkspaceAppSnapshot {
  return {
    agentActivated: false,
    agentOpen: false,
    busy: false,
    collabDocument: null,
    dropboxConnecting: false,
    editorDocument: { path: "", value: "", version: 0 },
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
    workspaceRuntime: null,
  };
}

function resolveWorkspaceStateUpdate<Value>(
  update: WorkspaceStateUpdate<Value>,
  current: Value,
): Value {
  return typeof update == "function" ? (update as (current: Value) => Value)(current) : update;
}
