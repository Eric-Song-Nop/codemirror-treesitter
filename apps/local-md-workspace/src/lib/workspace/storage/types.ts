import type { Effect } from "effect";
import type { WorkspaceStorageError, WorkspaceStoreError } from "./errors.ts";

export {
  isPermissionDeniedError,
  isWorkspaceStorageError,
  storageErrorFromOpendal,
  workspaceStorageError,
  WorkspaceAuthExpired,
  WorkspaceAuthRenewalFailed,
  WorkspaceConflict,
  WorkspaceHostDisposed,
  WorkspaceMutationNotApplied,
  WorkspaceNotFound,
  WorkspacePermissionDenied,
  WorkspaceStorageFailure,
  WorkspaceTransientFailure,
  WorkspaceUnsupported,
  WorkspaceUnsupportedImage,
  type WorkspaceStorageError,
  type WorkspaceStorageErrorCode,
  type WorkspaceStoreError,
} from "./errors.ts";

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

/**
 * Conditional object storage for one workspace. Operations are Effects whose
 * error channel is the typed {@link WorkspaceStoreError} union; programming
 * errors (invalid paths) are defects.
 */
export interface WorkspaceObjectStore {
  readonly capabilities: WorkspaceObjectStoreCapabilities;
  readonly id: string;

  commit(
    request: WorkspaceCommitRequest,
  ): Effect.Effect<WorkspaceCommitResult, WorkspaceStoreError>;
  createDirectory(
    path: string,
    condition: WorkspaceTargetCondition,
  ): Effect.Effect<WorkspacePathMutationResult, WorkspaceStoreError>;
  delete(
    request: WorkspaceDeleteRequest,
  ): Effect.Effect<WorkspacePathMutationResult, WorkspaceStoreError>;
  listDirectory(path: string): Effect.Effect<WorkspaceEntry[], WorkspaceStoreError>;
  move(
    request: WorkspaceMoveRequest,
  ): Effect.Effect<WorkspacePathMutationResult, WorkspaceStoreError>;
  probe(path: string): Effect.Effect<SourceObservation<SourceProbe>, WorkspaceStoreError>;
  read(path: string): Effect.Effect<SourceObservation<SourceSnapshot>, WorkspaceStoreError>;
}
