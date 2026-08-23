import type { CreatedWorkspaceImageNode, MarkdownDirectoryNode } from "../workspace-tree.ts";
import type {
  SourceObservation,
  SourceProbe,
  SourceRevision,
  SourceSnapshot,
  WorkspaceCommitCondition,
  WorkspaceCommitResult,
  WorkspacePathMutationResult,
  WorkspaceStorageError,
  WorkspaceStorageKind,
} from "../storage/types.ts";

export type WorkspaceIdentity = {
  id: string;
  kind: WorkspaceStorageKind;
  name: string;
  sourceAliases?: Array<{
    kind: WorkspaceStorageKind;
    namespace: string;
    workspaceId: string;
  }>;
};

export type WorkspaceTextSnapshot = SourceSnapshot & { value: string };

export interface WorkspaceDocumentPort {
  commit(input: {
    condition: WorkspaceCommitCondition;
    path: string;
    value: string;
  }): Promise<WorkspaceCommitResult>;
  observe(path: string): Promise<SourceObservation<WorkspaceTextSnapshot>>;
}

export interface WorkspaceTreePort {
  listEntries(path: string): Promise<
    Array<{
      kind: "directory" | "file";
      metadata: import("../storage/types.ts").WorkspaceMetadata;
      path: string;
    }>
  >;
  readDirectory(path: string, name: string): Promise<MarkdownDirectoryNode>;
  readTree(): Promise<MarkdownDirectoryNode>;
}

export interface WorkspaceEntryPort {
  create(rawPath: string): Promise<string | null>;
  delete(input: {
    kind: "directory" | "file";
    path: string;
    revision?: SourceRevision;
  }): Promise<WorkspacePathMutationResult>;
  rename(input: {
    kind: "directory" | "file";
    path: string;
    rawName: string;
    revision?: SourceRevision;
  }): Promise<{ path: string; result: WorkspacePathMutationResult }>;
  move(input: {
    from: string;
    kind: "directory" | "file";
    revision?: SourceRevision;
    to: string;
  }): Promise<WorkspacePathMutationResult>;
  probe(path: string): Promise<SourceObservation<SourceProbe>>;
}

export interface WorkspaceAssetPort {
  create(markdownFilePath: string, imageFile: File): Promise<CreatedWorkspaceImageNode>;
  delete(path: string): Promise<WorkspacePathMutationResult>;
  read(path: string): Promise<Uint8Array>;
  write(input: {
    condition: WorkspaceCommitCondition;
    path: string;
    value: Uint8Array;
  }): Promise<WorkspaceCommitResult>;
}

export type CurrentDocumentChangeHint =
  | { kind: "changed"; path: string }
  | { kind: "monitor-unavailable"; path: string }
  | { kind: "resync-required"; path: string };

export interface CurrentDocumentChangeSubscription {
  dispose(): void;
}

export interface CurrentDocumentChangeSource {
  subscribe(
    path: string,
    listener: (hint: CurrentDocumentChangeHint) => void,
  ): CurrentDocumentChangeSubscription;
}

export type WorkspaceHostCapabilities = {
  findFilePathForHandle?: (handle: unknown) => Promise<string | null>;
  queryPermission?: () => Promise<PermissionState>;
};

export type WorkspaceRuntime = {
  assets: WorkspaceAssetPort;
  currentDocumentChanges: CurrentDocumentChangeSource | null;
  dispose(): Promise<void>;
  documents: WorkspaceDocumentPort;
  entries: WorkspaceEntryPort;
  host: WorkspaceHostCapabilities;
  identity: WorkspaceIdentity;
  tree: WorkspaceTreePort;
};

export type DocumentSourceState =
  | { baseline: { contentHash: string; revision: SourceRevision }; kind: "present" }
  | {
      error: WorkspaceStorageError;
      kind: "unavailable";
      lastPresent?: { contentHash: string; revision: SourceRevision };
    }
  | {
      incoming: WorkspaceTextSnapshot;
      kind: "recovery-required";
      lastPresent: { contentHash: string; revision: SourceRevision };
    }
  | {
      kind: "missing";
      lastPresent?: { contentHash: string; revision: SourceRevision };
    };
