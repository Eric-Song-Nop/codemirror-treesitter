import type { OpendalBrowserError } from "@codemirror-treesitter/opendal-wasm-browser";

export type WorkspaceStorageKind =
  | "local"
  | "opendal-dropbox"
  | "opendal-gdrive"
  | "opendal-onedrive"
  | "opendal-s3";

export type WorkspaceStorageIdentity = {
  id: string;
  kind: WorkspaceStorageKind;
  name: string;
};

export type WorkspaceMetadata = {
  etag?: string;
  lastModified?: string;
  size?: number;
  version?: string;
};

export type SourceRevision =
  | { kind: "etag" | "version"; validation: "atomic"; value: string }
  | { kind: "fingerprint"; validation: "observed"; value: string };

export type SourceSnapshot = {
  bytes: Uint8Array;
  capture: "bound" | "observed";
  contentHash: string;
  metadata: WorkspaceMetadata;
  revision: SourceRevision;
};

export type SourceProbe = {
  kind: "directory" | "file";
  metadata: WorkspaceMetadata;
  revision?: SourceRevision;
};

export type WorkspaceStorageErrorCode =
  | "already-exists"
  | "authentication-expired"
  | "condition-failed"
  | "permission-denied"
  | "rate-limited"
  | "temporary"
  | "unknown"
  | "unsupported";

export class WorkspaceStorageError extends Error {
  readonly code: WorkspaceStorageErrorCode;
  readonly retryable: boolean;

  constructor(input: {
    cause?: unknown;
    code: WorkspaceStorageErrorCode;
    message: string;
    retryable?: boolean;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "WorkspaceStorageError";
    this.code = input.code;
    this.retryable = input.retryable ?? (input.code == "rate-limited" || input.code == "temporary");
  }
}

export type SourceObservation<T> =
  | { state: "missing" }
  | { error: WorkspaceStorageError; state: "unavailable" }
  | { state: "present"; value: T };

export type WorkspaceEntry = {
  kind: "directory" | "file";
  metadata: WorkspaceMetadata;
  path: string;
};

export type WorkspaceCommitCondition =
  | { kind: "if-absent" }
  | { kind: "if-unchanged"; revision: SourceRevision }
  | { kind: "unconditional" };

export type WorkspaceCommitRequest = {
  bytes: Uint8Array;
  condition: WorkspaceCommitCondition;
  path: string;
};

export type WorkspaceCommitResult =
  | { revision: SourceRevision; status: "committed" }
  | { current?: SourceRevision; status: "conflict" }
  | { reconcilePaths: string[]; status: "unknown" };

export type WorkspaceExistingPathCondition =
  | { kind: "if-unchanged"; revision: SourceRevision }
  | { kind: "unconditional" };

export type WorkspaceTargetCondition = { kind: "if-absent" } | { kind: "unconditional" };

export type WorkspaceDeleteRequest = {
  condition: WorkspaceExistingPathCondition;
  path: string;
  recursive?: boolean;
};

export type WorkspaceMoveRequest = {
  from: string;
  kind: "directory" | "file";
  sourceCondition: WorkspaceExistingPathCondition;
  targetCondition: WorkspaceTargetCondition;
  to: string;
};

export type WorkspacePathMutationResult =
  | { status: "applied" }
  | {
      current?: SourceRevision;
      path: string;
      reason: "source-changed" | "source-missing" | "target-exists";
      status: "conflict";
    }
  | {
      phase: "recursive-delete" | "source-remove" | "target-copy";
      reconcilePaths: string[];
      status: "partial";
    }
  | { reconcilePaths: string[]; status: "unknown" };

export type WorkspaceConditionCapability = "atomic" | "observed" | "unsupported";

export type WorkspaceObjectStoreCapabilities = {
  commit: {
    ifAbsent: WorkspaceConditionCapability;
    ifUnchanged: WorkspaceConditionCapability;
  };
  createDirectory: {
    ifAbsent: WorkspaceConditionCapability;
    supported: boolean;
  };
  delete: {
    ifUnchanged: WorkspaceConditionCapability;
    recursive: "emulated" | "native" | "unsupported";
    single: boolean;
  };
  move: {
    directory: "copy-delete" | "native" | "unsupported";
    file: "copy-delete" | "native" | "unsupported";
    sourceIfUnchanged: WorkspaceConditionCapability;
    targetIfAbsent: WorkspaceConditionCapability;
  };
};

export interface WorkspaceObjectStore {
  readonly capabilities: WorkspaceObjectStoreCapabilities;
  readonly id: string;

  commit(request: WorkspaceCommitRequest): Promise<WorkspaceCommitResult>;
  createDirectory(
    path: string,
    condition: WorkspaceTargetCondition,
  ): Promise<WorkspacePathMutationResult>;
  delete(request: WorkspaceDeleteRequest): Promise<WorkspacePathMutationResult>;
  listDirectory(path: string): Promise<WorkspaceEntry[]>;
  move(request: WorkspaceMoveRequest): Promise<WorkspacePathMutationResult>;
  probe(path: string): Promise<SourceObservation<SourceProbe>>;
  read(path: string): Promise<SourceObservation<SourceSnapshot>>;
}

export function storageErrorFromOpendal(error: OpendalBrowserError) {
  let code = error.code == "not-found" ? "unknown" : error.code;
  return new WorkspaceStorageError({
    cause: error,
    code,
    message: error.message,
    retryable: error.retryable,
  });
}
