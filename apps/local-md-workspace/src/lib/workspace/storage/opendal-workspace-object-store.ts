import {
  OpendalBrowserError,
  type OpendalCapabilities,
  type OpendalMetadata,
  type OpendalPathMutationResult,
  type OpendalWriteCondition,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { Effect } from "effect";
import type {
  OpendalHostError,
  OpendalHostRequest,
  OpendalOperatorHost,
} from "./opendal-operator-host.ts";
import {
  BrowserWorkspacePathLock,
  type WorkspacePathLock,
  type WorkspacePathLockIntent,
} from "./workspace-path-lock.ts";
import {
  storageErrorFromOpendal,
  workspaceStorageError,
  type WorkspaceStoreError,
} from "./errors.ts";
import type {
  SourceObservation,
  SourceProbe,
  SourceRevision,
  SourceSnapshot,
  WorkspaceCommitRequest,
  WorkspaceCommitResult,
  WorkspaceDeleteRequest,
  WorkspaceEntry,
  WorkspaceMetadata,
  WorkspaceMoveRequest,
  WorkspaceObjectStore,
  WorkspaceObjectStoreCapabilities,
  WorkspacePathMutationResult,
  WorkspaceTargetCondition,
} from "./types.ts";

type HashBytes = (bytes: Uint8Array) => Promise<string>;

export type OpendalWorkspaceObjectStoreOptions = {
  captureAttempts?: number;
  hashBytes?: HashBytes;
  lock?: WorkspacePathLock;
};

/**
 * Conditional object storage over an OpenDAL operator host. Every operation is
 * an Effect that holds the workspace path locks for its duration; storage
 * failures are translated into the tagged {@link WorkspaceStoreError} union.
 */
export class OpendalWorkspaceObjectStore implements WorkspaceObjectStore {
  readonly capabilities: WorkspaceObjectStoreCapabilities;
  readonly id: string;
  private readonly captureAttempts: number;
  private readonly hashBytes: HashBytes;
  private readonly lock: WorkspacePathLock;

  constructor(
    private readonly host: OpendalOperatorHost,
    options: OpendalWorkspaceObjectStoreOptions = {},
  ) {
    this.id = host.identity.id;
    this.capabilities = objectStoreCapabilities(host.operatorInfo.capabilities);
    this.captureAttempts = options.captureAttempts ?? 3;
    if (!Number.isSafeInteger(this.captureAttempts) || this.captureAttempts < 1) {
      throw new RangeError("captureAttempts must be a positive safe integer.");
    }
    this.hashBytes = options.hashBytes ?? sha256ContentHash;
    this.lock = options.lock ?? new BrowserWorkspacePathLock();
  }

  probe(path: string) {
    return Effect.suspend(() => {
      let normalizedPath = normalizeObjectPath(path);
      return this.probeUnlocked(normalizedPath).pipe(
        this.withLock([{ mode: "shared", path: normalizedPath }]),
      );
    });
  }

  read(path: string) {
    return Effect.suspend(() => {
      let normalizedPath = normalizeObjectPath(path);
      return this.readUnlocked(normalizedPath).pipe(
        this.withLock([{ mode: "shared", path: normalizedPath }]),
      );
    });
  }

  listDirectory(path: string) {
    return Effect.suspend(() => {
      let normalizedPath = normalizeObjectPath(path, true);
      return this.runHost({
        execute: (operator) => operator.list(normalizedPath),
        operation: "read",
      }).pipe(
        Effect.map((entries) => entries.map(metadataToWorkspaceEntry)),
        Effect.mapError(translateStorageFailure),
        this.withLock([{ mode: "shared", path: normalizedPath }]),
      );
    });
  }

  commit(request: WorkspaceCommitRequest) {
    return Effect.suspend(() => {
      let path = normalizeObjectPath(request.path);
      return this.commitUnlocked({ ...request, bytes: Uint8Array.from(request.bytes), path }).pipe(
        this.withLock([{ mode: "exclusive", path }]),
      );
    });
  }

  createDirectory(path: string, condition: WorkspaceTargetCondition) {
    return Effect.suspend(() => {
      let normalizedPath = normalizeObjectPath(path);
      return this.createDirectoryUnlocked(normalizedPath, condition).pipe(
        this.withLock([{ mode: "exclusive", path: normalizedPath }]),
      );
    });
  }

  delete(request: WorkspaceDeleteRequest) {
    return Effect.suspend(() => {
      let path = normalizeObjectPath(request.path);
      return this.deleteUnlocked({ ...request, path }).pipe(
        this.withLock([{ mode: "exclusive", path }]),
      );
    });
  }

  move(request: WorkspaceMoveRequest) {
    return Effect.suspend(() => {
      let from = normalizeObjectPath(request.from);
      let to = normalizeObjectPath(request.to);
      return this.moveUnlocked({ ...request, from, to }).pipe(
        this.withLock([
          { mode: "exclusive", path: from },
          { mode: "exclusive", path: to },
        ]),
      );
    });
  }

  private withLock(intents: WorkspacePathLockIntent[]) {
    return this.lock.withLocks({ intents, workspaceId: this.id });
  }

  private runHost<T>(request: OpendalHostRequest<T>) {
    return this.host.run(request);
  }

  private probeUnlocked(
    path: string,
  ): Effect.Effect<SourceObservation<SourceProbe>, WorkspaceStoreError> {
    return this.runHost({ execute: (operator) => operator.stat(path), operation: "read" }).pipe(
      Effect.map(
        (metadata): SourceObservation<SourceProbe> => ({
          state: "present",
          value: {
            kind: metadata.kind,
            metadata: metadataToWorkspaceMetadata(metadata),
            revision: selectAtomicRevision(metadata, this.host.operatorInfo.capabilities),
          },
        }),
      ),
      Effect.catch(observationFromFailure<SourceProbe>),
    );
  }

  private readUnlocked(
    path: string,
  ): Effect.Effect<SourceObservation<SourceSnapshot>, WorkspaceStoreError> {
    return Effect.gen({ self: this }, function* () {
      let first = yield* this.runHost({
        execute: (operator) => operator.read(path),
        operation: "read",
      }).pipe(Effect.result);
      if (first._tag == "Failure")
        return yield* observationFromFailure<SourceSnapshot>(first.failure);

      if (first.success.metadataBinding == "same-read") {
        return {
          state: "present",
          value: yield* this.snapshotFromBytes(
            first.success.bytes,
            first.success.metadata,
            "bound",
          ),
        } satisfies SourceObservation<SourceSnapshot>;
      }

      for (let attempt = 0; attempt < this.captureAttempts; attempt++) {
        let sample = yield* this.captureSandwich(path).pipe(Effect.result);
        if (sample._tag == "Failure") {
          return yield* observationFromFailure<SourceSnapshot>(sample.failure);
        }
        if (sample.success) return sample.success;
      }

      return {
        error: workspaceStorageError({
          code: "temporary",
          message: `Could not establish a stable source observation for ${path}.`,
          retryable: true,
        }),
        state: "unavailable",
      } satisfies SourceObservation<SourceSnapshot>;
    });
  }

  /** One stat-read-stat sample; `null` when the metadata changed under the read. */
  private captureSandwich(
    path: string,
  ): Effect.Effect<SourceObservation<SourceSnapshot> | null, OpendalHostError> {
    return Effect.gen({ self: this }, function* () {
      let before = yield* this.runHost({
        execute: (operator) => operator.stat(path),
        operation: "read",
      });
      let read = yield* this.runHost({
        execute: (operator) => operator.read(path),
        operation: "read",
      });
      if (read.metadataBinding == "same-read") {
        return {
          state: "present",
          value: yield* this.snapshotFromBytes(read.bytes, read.metadata, "bound"),
        } satisfies SourceObservation<SourceSnapshot>;
      }
      let after = yield* this.runHost({
        execute: (operator) => operator.stat(path),
        operation: "read",
      });
      if (!sameMetadataSample(before, after)) return null;

      let hasStableAtomicToken = Boolean(
        matchingAtomicRevision(before, after, this.host.operatorInfo.capabilities),
      );
      return {
        state: "present",
        value: yield* this.snapshotFromBytes(
          read.bytes,
          after,
          hasStableAtomicToken ? "bound" : "observed",
        ),
      } satisfies SourceObservation<SourceSnapshot>;
    });
  }

  private snapshotFromBytes(
    bytes: Uint8Array,
    metadata: OpendalMetadata,
    capture: "bound" | "observed",
  ): Effect.Effect<SourceSnapshot> {
    return Effect.gen({ self: this }, function* () {
      let stableBytes = Uint8Array.from(bytes);
      let contentHash = yield* Effect.promise(() => this.hashBytes(stableBytes));
      let workspaceMetadata = metadataToWorkspaceMetadata(metadata);
      let atomic =
        capture == "bound"
          ? selectAtomicRevision(metadata, this.host.operatorInfo.capabilities)
          : undefined;
      return {
        bytes: stableBytes,
        capture,
        contentHash,
        metadata: workspaceMetadata,
        revision: atomic ?? observedFingerprint(contentHash, metadata.kind, workspaceMetadata),
      };
    });
  }

  private commitUnlocked(
    request: WorkspaceCommitRequest,
  ): Effect.Effect<WorkspaceCommitResult, WorkspaceStoreError> {
    return Effect.gen({ self: this }, function* () {
      let writeCondition: OpendalWriteCondition | undefined;
      if (request.condition.kind == "if-absent") {
        if (this.host.operatorInfo.capabilities.writeConditions.ifNotExists) {
          writeCondition = { kind: "if-not-exists" };
        } else {
          let current = yield* this.probeUnlocked(request.path);
          if (current.state == "present") {
            return { current: current.value.revision, status: "conflict" } as const;
          }
          if (current.state == "unavailable") return yield* Effect.fail(current.error);
        }
      } else if (request.condition.kind == "if-unchanged") {
        writeCondition = writeConditionForRevision(
          request.condition.revision,
          this.host.operatorInfo.capabilities,
        );
        if (!writeCondition) {
          let current = yield* this.readUnlocked(request.path);
          if (current.state == "missing") return { status: "conflict" } as const;
          if (current.state == "unavailable") return yield* Effect.fail(current.error);
          if (!sameRevision(current.value.revision, request.condition.revision)) {
            return { current: current.value.revision, status: "conflict" } as const;
          }
        }
      }

      let write = yield* this.runHost({
        execute: (operator) =>
          operator.write({ bytes: request.bytes, condition: writeCondition, path: request.path }),
        operation: writeCondition ? "conditional-mutation" : "unconditional-mutation",
      }).pipe(Effect.result);
      if (write._tag == "Failure") {
        let error = write.failure;
        if (error instanceof OpendalBrowserError) {
          if (error.code == "already-exists" || error.code == "condition-failed") {
            return {
              current: yield* this.currentRevisionUnlocked(request.path),
              status: "conflict",
            } as const;
          }
          if (error.mutationOutcome == "unknown") {
            return {
              reconcilePaths: error.reconcilePaths ?? [request.path],
              status: "unknown",
            } as const;
          }
        }
        return yield* Effect.fail(translateStorageFailure(error));
      }

      let receipt = write.success;
      if (receipt.metadataBinding == "write-response") {
        let revision = selectAtomicRevision(receipt.metadata, this.host.operatorInfo.capabilities);
        if (revision) return { revision, status: "committed" } as const;
      }

      let readback = yield* this.readUnlocked(request.path);
      if (readback.state != "present" || !equalBytes(readback.value.bytes, request.bytes)) {
        return { reconcilePaths: [request.path], status: "unknown" } as const;
      }
      return { revision: readback.value.revision, status: "committed" } as const;
    });
  }

  private currentRevisionUnlocked(path: string) {
    return this.readUnlocked(path).pipe(
      Effect.map((current) => (current.state == "present" ? current.value.revision : undefined)),
    );
  }

  private createDirectoryUnlocked(
    path: string,
    condition: WorkspaceTargetCondition,
  ): Effect.Effect<WorkspacePathMutationResult, WorkspaceStoreError> {
    return Effect.gen({ self: this }, function* () {
      if (condition.kind == "if-absent") {
        let current = yield* this.probeUnlocked(path);
        if (current.state == "present") {
          return { path, reason: "target-exists", status: "conflict" } as const;
        }
        if (current.state == "unavailable") return yield* Effect.fail(current.error);
      }
      let created = yield* this.runHost({
        execute: (operator) => operator.createDirectory(path),
        operation: "unconditional-mutation",
      }).pipe(Effect.result);
      if (created._tag == "Success") return { status: "applied" } as const;
      let error = created.failure;
      if (error instanceof OpendalBrowserError && error.code == "already-exists") {
        return condition.kind == "unconditional"
          ? ({ status: "applied" } as const)
          : ({ path, reason: "target-exists", status: "conflict" } as const);
      }
      if (error instanceof OpendalBrowserError && error.mutationOutcome == "unknown") {
        return { reconcilePaths: error.reconcilePaths ?? [path], status: "unknown" } as const;
      }
      return yield* Effect.fail(translateStorageFailure(error));
    });
  }

  private deleteUnlocked(
    request: WorkspaceDeleteRequest,
  ): Effect.Effect<WorkspacePathMutationResult, WorkspaceStoreError> {
    return Effect.gen({ self: this }, function* () {
      if (request.condition.kind == "if-unchanged") {
        let current = yield* this.readUnlocked(request.path);
        if (current.state == "missing") {
          return { path: request.path, reason: "source-missing", status: "conflict" } as const;
        }
        if (current.state == "unavailable") return yield* Effect.fail(current.error);
        if (!sameRevision(current.value.revision, request.condition.revision)) {
          return {
            current: current.value.revision,
            path: request.path,
            reason: "source-changed",
            status: "conflict",
          } as const;
        }
      }

      let deleted = yield* this.runHost({
        execute: (operator) =>
          operator.delete({ path: request.path, recursive: request.recursive ?? false }),
        operation: "unconditional-mutation",
      }).pipe(Effect.result);
      if (deleted._tag == "Success") return operatorMutationResult(deleted.success);
      let error = deleted.failure;
      if (error instanceof OpendalBrowserError && error.code == "not-found") {
        return request.condition.kind == "unconditional"
          ? ({ status: "applied" } as const)
          : ({ path: request.path, reason: "source-missing", status: "conflict" } as const);
      }
      return yield* Effect.fail(translateStorageFailure(error));
    });
  }

  private moveUnlocked(
    request: WorkspaceMoveRequest,
  ): Effect.Effect<WorkspacePathMutationResult, WorkspaceStoreError> {
    return Effect.gen({ self: this }, function* () {
      let source = yield* this.probeUnlocked(request.from);
      if (source.state == "missing") {
        return { path: request.from, reason: "source-missing", status: "conflict" } as const;
      }
      if (source.state == "unavailable") return yield* Effect.fail(source.error);

      if (request.sourceCondition.kind == "if-unchanged") {
        let current: SourceObservation<SourceProbe | SourceSnapshot> = source.value.revision
          ? source
          : yield* this.readUnlocked(request.from);
        if (current.state != "present") {
          if (current.state == "unavailable") return yield* Effect.fail(current.error);
          return { path: request.from, reason: "source-missing", status: "conflict" } as const;
        }
        if (
          !current.value.revision ||
          !sameRevision(current.value.revision, request.sourceCondition.revision)
        ) {
          return {
            current: current.value.revision,
            path: request.from,
            reason: "source-changed",
            status: "conflict",
          } as const;
        }
      }

      if (request.targetCondition.kind == "if-absent") {
        let target = yield* this.probeUnlocked(request.to);
        if (target.state == "present") {
          return { path: request.to, reason: "target-exists", status: "conflict" } as const;
        }
        if (target.state == "unavailable") return yield* Effect.fail(target.error);
      }

      let moved = yield* this.runHost({
        execute: (operator) =>
          operator.rename({ from: request.from, kind: request.kind, to: request.to }),
        operation: "unconditional-mutation",
      }).pipe(Effect.result);
      if (moved._tag == "Success") return operatorMutationResult(moved.success);
      let error = moved.failure;
      if (error instanceof OpendalBrowserError && error.code == "already-exists") {
        return { path: request.to, reason: "target-exists", status: "conflict" } as const;
      }
      if (error instanceof OpendalBrowserError && error.code == "not-found") {
        return { path: request.from, reason: "source-missing", status: "conflict" } as const;
      }
      return yield* Effect.fail(translateStorageFailure(error));
    });
  }
}

export async function sha256ContentHash(bytes: Uint8Array) {
  let stable = Uint8Array.from(bytes);
  let digest = await crypto.subtle.digest("SHA-256", stable.buffer);
  return `sha256:${base64Url(new Uint8Array(digest))}`;
}

export function observedFingerprint(
  contentHash: string,
  kind: "directory" | "file",
  metadata: WorkspaceMetadata,
): SourceRevision {
  let canonical = JSON.stringify([
    "grove-source-fingerprint",
    1,
    kind,
    contentHash,
    metadata.size ?? null,
    metadata.lastModified ?? null,
    metadata.etag ?? null,
    metadata.version ?? null,
  ]);
  return {
    kind: "fingerprint",
    validation: "observed",
    value: `fingerprint:v1:${base64Url(new TextEncoder().encode(canonical))}`,
  };
}

function objectStoreCapabilities(
  capabilities: OpendalCapabilities,
): WorkspaceObjectStoreCapabilities {
  let atomicUnchanged =
    capabilities.writeConditions.ifMatch || capabilities.writeConditions.ifVersion;
  let observedCommit = capabilities.read && capabilities.write;
  let observedMutation = capabilities.stat;
  return {
    commit: {
      ifAbsent: capabilities.writeConditions.ifNotExists
        ? "atomic"
        : capabilities.stat && capabilities.write
          ? "observed"
          : "unsupported",
      ifUnchanged: atomicUnchanged ? "atomic" : observedCommit ? "observed" : "unsupported",
    },
    createDirectory: {
      ifAbsent: capabilities.createDirectory && capabilities.stat ? "observed" : "unsupported",
      supported: capabilities.createDirectory,
    },
    delete: {
      ifUnchanged: capabilities.delete.single && observedCommit ? "observed" : "unsupported",
      recursive: capabilities.delete.recursive,
      single: capabilities.delete.single,
    },
    move: {
      directory: capabilities.rename.directory,
      file: capabilities.rename.file,
      sourceIfUnchanged: observedMutation ? "observed" : "unsupported",
      targetIfAbsent: observedMutation ? "observed" : "unsupported",
    },
  };
}

function selectAtomicRevision(metadata: OpendalMetadata, capabilities: OpendalCapabilities) {
  if (metadata.version && capabilities.writeConditions.ifVersion) {
    return {
      kind: "version",
      validation: "atomic",
      value: metadata.version,
    } satisfies SourceRevision;
  }
  if (metadata.etag && capabilities.writeConditions.ifMatch) {
    return { kind: "etag", validation: "atomic", value: metadata.etag } satisfies SourceRevision;
  }
  return undefined;
}

function matchingAtomicRevision(
  before: OpendalMetadata,
  after: OpendalMetadata,
  capabilities: OpendalCapabilities,
) {
  let beforeRevision = selectAtomicRevision(before, capabilities);
  let afterRevision = selectAtomicRevision(after, capabilities);
  return beforeRevision && afterRevision && sameRevision(beforeRevision, afterRevision)
    ? afterRevision
    : undefined;
}

function writeConditionForRevision(
  revision: SourceRevision,
  capabilities: OpendalCapabilities,
): OpendalWriteCondition | undefined {
  if (revision.validation != "atomic") return undefined;
  if (revision.kind == "version" && capabilities.writeConditions.ifVersion) {
    return { kind: "if-version", version: revision.value };
  }
  if (revision.kind == "etag" && capabilities.writeConditions.ifMatch) {
    return { etag: revision.value, kind: "if-match" };
  }
  return undefined;
}

function sameMetadataSample(before: OpendalMetadata, after: OpendalMetadata) {
  return (
    before.kind == after.kind &&
    before.size == after.size &&
    before.lastModified == after.lastModified &&
    before.etag == after.etag &&
    before.version == after.version
  );
}

function sameRevision(a: SourceRevision, b: SourceRevision) {
  return a.kind == b.kind && a.validation == b.validation && a.value == b.value;
}

function metadataToWorkspaceMetadata(metadata: OpendalMetadata): WorkspaceMetadata {
  return {
    etag: metadata.etag,
    lastModified: metadata.lastModified,
    size: metadata.size,
    version: metadata.version,
  };
}

function metadataToWorkspaceEntry(metadata: OpendalMetadata): WorkspaceEntry {
  return {
    kind: metadata.kind,
    metadata: metadataToWorkspaceMetadata(metadata),
    path: metadata.path,
  };
}

function observationFromFailure<T>(
  error: OpendalHostError,
): Effect.Effect<SourceObservation<T>, WorkspaceStoreError> {
  if (error instanceof OpendalBrowserError) {
    if (error.code == "not-found") return Effect.succeed({ state: "missing" });
    return Effect.succeed({ error: storageErrorFromOpendal(error), state: "unavailable" });
  }
  return Effect.fail(error);
}

function translateStorageFailure(error: OpendalHostError): WorkspaceStoreError {
  return error instanceof OpendalBrowserError ? storageErrorFromOpendal(error) : error;
}

function operatorMutationResult(result: OpendalPathMutationResult): WorkspacePathMutationResult {
  return result;
}

function normalizeObjectPath(path: string, allowRoot = false) {
  let normalized = path.trim().replace(/\\/g, "/");
  if (normalized.startsWith("/") && normalized != "/") {
    throw new Error("Workspace object paths must be relative.");
  }
  let parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part == "." || part == "..")) {
    throw new Error("Workspace object paths cannot include . or .. segments.");
  }
  if (!parts.length && !allowRoot) throw new Error("Workspace object operation requires a path.");
  return parts.join("/");
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  return a.byteLength == b.byteLength && a.every((value, index) => value == b[index]);
}

function base64Url(bytes: Uint8Array) {
  let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    let a = bytes[index]!;
    let b = bytes[index + 1];
    let c = bytes[index + 2];
    output += alphabet[a >> 2];
    output += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    output += b == null ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
    output += c == null ? "=" : alphabet[c & 63];
  }
  return output.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
