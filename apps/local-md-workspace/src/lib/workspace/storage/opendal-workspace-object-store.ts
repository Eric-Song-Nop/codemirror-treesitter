import {
  OpendalBrowserError,
  type OpendalCapabilities,
  type OpendalMetadata,
  type OpendalPathMutationResult,
  type OpendalWriteCondition,
} from "@codemirror-treesitter/opendal-wasm-browser";
import type { OpendalOperatorHost } from "./opendal-operator-host.ts";
import {
  BrowserWorkspacePathLock,
  type WorkspacePathLock,
  type WorkspacePathLockIntent,
} from "./workspace-path-lock.ts";
import {
  WorkspaceStorageError,
  storageErrorFromOpendal,
  type SourceObservation,
  type SourceProbe,
  type SourceRevision,
  type SourceSnapshot,
  type WorkspaceCommitRequest,
  type WorkspaceCommitResult,
  type WorkspaceDeleteRequest,
  type WorkspaceEntry,
  type WorkspaceMetadata,
  type WorkspaceMoveRequest,
  type WorkspaceObjectStore,
  type WorkspaceObjectStoreCapabilities,
  type WorkspacePathMutationResult,
  type WorkspaceTargetCondition,
} from "./types.ts";

type HashBytes = (bytes: Uint8Array) => Promise<string>;

export type OpendalWorkspaceObjectStoreOptions = {
  captureAttempts?: number;
  hashBytes?: HashBytes;
  lock?: WorkspacePathLock;
};

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
    let normalizedPath = normalizeObjectPath(path);
    return this.withLock([{ mode: "shared", path: normalizedPath }], () =>
      this.probeUnlocked(normalizedPath),
    );
  }

  read(path: string) {
    let normalizedPath = normalizeObjectPath(path);
    return this.withLock([{ mode: "shared", path: normalizedPath }], () =>
      this.readUnlocked(normalizedPath),
    );
  }

  listDirectory(path: string) {
    let normalizedPath = normalizeObjectPath(path, true);
    return this.withLock([{ mode: "shared", path: normalizedPath }], async () => {
      try {
        let entries = await this.host.run({
          execute: (operator) => operator.list(normalizedPath),
          operation: "read",
        });
        return entries.map(metadataToWorkspaceEntry);
      } catch (error) {
        throw translateStorageFailure(error);
      }
    });
  }

  commit(request: WorkspaceCommitRequest) {
    let path = normalizeObjectPath(request.path);
    return this.withLock([{ mode: "exclusive", path }], () =>
      this.commitUnlocked({ ...request, bytes: Uint8Array.from(request.bytes), path }),
    );
  }

  createDirectory(path: string, condition: WorkspaceTargetCondition) {
    let normalizedPath = normalizeObjectPath(path);
    return this.withLock([{ mode: "exclusive", path: normalizedPath }], () =>
      this.createDirectoryUnlocked(normalizedPath, condition),
    );
  }

  delete(request: WorkspaceDeleteRequest) {
    let path = normalizeObjectPath(request.path);
    return this.withLock([{ mode: "exclusive", path }], () =>
      this.deleteUnlocked({ ...request, path }),
    );
  }

  move(request: WorkspaceMoveRequest) {
    let from = normalizeObjectPath(request.from);
    let to = normalizeObjectPath(request.to);
    return this.withLock(
      [
        { mode: "exclusive", path: from },
        { mode: "exclusive", path: to },
      ],
      () => this.moveUnlocked({ ...request, from, to }),
    );
  }

  private withLock<T>(intents: WorkspacePathLockIntent[], execute: () => Promise<T>) {
    return this.lock.run({ execute, intents, workspaceId: this.id });
  }

  private async probeUnlocked(path: string): Promise<SourceObservation<SourceProbe>> {
    try {
      let metadata = await this.host.run({
        execute: (operator) => operator.stat(path),
        operation: "read",
      });
      return {
        state: "present",
        value: {
          kind: metadata.kind,
          metadata: metadataToWorkspaceMetadata(metadata),
          revision: selectAtomicRevision(metadata, this.host.operatorInfo.capabilities),
        },
      };
    } catch (error) {
      return observationFromFailure(error);
    }
  }

  private async readUnlocked(path: string): Promise<SourceObservation<SourceSnapshot>> {
    let first;
    try {
      first = await this.host.run({
        execute: (operator) => operator.read(path),
        operation: "read",
      });
    } catch (error) {
      return observationFromFailure(error);
    }

    if (first.metadataBinding == "same-read") {
      return {
        state: "present",
        value: await this.snapshotFromBytes(first.bytes, first.metadata, "bound"),
      };
    }

    for (let attempt = 0; attempt < this.captureAttempts; attempt++) {
      try {
        let before = await this.host.run({
          execute: (operator) => operator.stat(path),
          operation: "read",
        });
        let read = await this.host.run({
          execute: (operator) => operator.read(path),
          operation: "read",
        });
        if (read.metadataBinding == "same-read") {
          return {
            state: "present",
            value: await this.snapshotFromBytes(read.bytes, read.metadata, "bound"),
          };
        }
        let after = await this.host.run({
          execute: (operator) => operator.stat(path),
          operation: "read",
        });
        if (!sameMetadataSample(before, after)) continue;

        let hasStableAtomicToken = Boolean(
          matchingAtomicRevision(before, after, this.host.operatorInfo.capabilities),
        );
        return {
          state: "present",
          value: await this.snapshotFromBytes(
            read.bytes,
            after,
            hasStableAtomicToken ? "bound" : "observed",
          ),
        };
      } catch (error) {
        return observationFromFailure(error);
      }
    }

    return {
      error: new WorkspaceStorageError({
        code: "temporary",
        message: `Could not establish a stable source observation for ${path}.`,
        retryable: true,
      }),
      state: "unavailable",
    };
  }

  private async snapshotFromBytes(
    bytes: Uint8Array,
    metadata: OpendalMetadata,
    capture: "bound" | "observed",
  ): Promise<SourceSnapshot> {
    let stableBytes = Uint8Array.from(bytes);
    let contentHash = await this.hashBytes(stableBytes);
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
  }

  private async commitUnlocked(request: WorkspaceCommitRequest): Promise<WorkspaceCommitResult> {
    let writeCondition: OpendalWriteCondition | undefined;
    if (request.condition.kind == "if-absent") {
      if (this.host.operatorInfo.capabilities.writeConditions.ifNotExists) {
        writeCondition = { kind: "if-not-exists" };
      } else {
        let current = await this.probeUnlocked(request.path);
        if (current.state == "present")
          return { current: current.value.revision, status: "conflict" };
        if (current.state == "unavailable") throw current.error;
      }
    } else if (request.condition.kind == "if-unchanged") {
      writeCondition = writeConditionForRevision(
        request.condition.revision,
        this.host.operatorInfo.capabilities,
      );
      if (!writeCondition) {
        let current = await this.readUnlocked(request.path);
        if (current.state == "missing") return { status: "conflict" };
        if (current.state == "unavailable") throw current.error;
        if (!sameRevision(current.value.revision, request.condition.revision)) {
          return { current: current.value.revision, status: "conflict" };
        }
      }
    }

    let receipt;
    try {
      receipt = await this.host.run({
        execute: (operator) =>
          operator.write({ bytes: request.bytes, condition: writeCondition, path: request.path }),
        operation: writeCondition ? "conditional-mutation" : "unconditional-mutation",
      });
    } catch (error) {
      if (error instanceof OpendalBrowserError) {
        if (error.code == "already-exists" || error.code == "condition-failed") {
          return { current: await this.currentRevisionUnlocked(request.path), status: "conflict" };
        }
        if (error.mutationOutcome == "unknown") {
          return { reconcilePaths: error.reconcilePaths ?? [request.path], status: "unknown" };
        }
      }
      throw translateStorageFailure(error);
    }

    if (receipt.metadataBinding == "write-response") {
      let revision = selectAtomicRevision(receipt.metadata, this.host.operatorInfo.capabilities);
      if (revision) return { revision, status: "committed" };
    }

    let readback = await this.readUnlocked(request.path);
    if (readback.state != "present" || !equalBytes(readback.value.bytes, request.bytes)) {
      return { reconcilePaths: [request.path], status: "unknown" };
    }
    return { revision: readback.value.revision, status: "committed" };
  }

  private async currentRevisionUnlocked(path: string) {
    let current = await this.readUnlocked(path);
    return current.state == "present" ? current.value.revision : undefined;
  }

  private async createDirectoryUnlocked(
    path: string,
    condition: WorkspaceTargetCondition,
  ): Promise<WorkspacePathMutationResult> {
    if (condition.kind == "if-absent") {
      let current = await this.probeUnlocked(path);
      if (current.state == "present") {
        return { path, reason: "target-exists", status: "conflict" };
      }
      if (current.state == "unavailable") throw current.error;
    }
    try {
      await this.host.run({
        execute: (operator) => operator.createDirectory(path),
        operation: "unconditional-mutation",
      });
      return { status: "applied" };
    } catch (error) {
      if (error instanceof OpendalBrowserError && error.code == "already-exists") {
        return condition.kind == "unconditional"
          ? { status: "applied" }
          : { path, reason: "target-exists", status: "conflict" };
      }
      if (error instanceof OpendalBrowserError && error.mutationOutcome == "unknown") {
        return { reconcilePaths: error.reconcilePaths ?? [path], status: "unknown" };
      }
      throw translateStorageFailure(error);
    }
  }

  private async deleteUnlocked(
    request: WorkspaceDeleteRequest,
  ): Promise<WorkspacePathMutationResult> {
    if (request.condition.kind == "if-unchanged") {
      let current = await this.readUnlocked(request.path);
      if (current.state == "missing") {
        return { path: request.path, reason: "source-missing", status: "conflict" };
      }
      if (current.state == "unavailable") throw current.error;
      if (!sameRevision(current.value.revision, request.condition.revision)) {
        return {
          current: current.value.revision,
          path: request.path,
          reason: "source-changed",
          status: "conflict",
        };
      }
    }

    try {
      let result = await this.host.run({
        execute: (operator) =>
          operator.delete({ path: request.path, recursive: request.recursive ?? false }),
        operation: "unconditional-mutation",
      });
      return operatorMutationResult(result);
    } catch (error) {
      if (error instanceof OpendalBrowserError && error.code == "not-found") {
        return request.condition.kind == "unconditional"
          ? { status: "applied" }
          : { path: request.path, reason: "source-missing", status: "conflict" };
      }
      throw translateStorageFailure(error);
    }
  }

  private async moveUnlocked(request: WorkspaceMoveRequest): Promise<WorkspacePathMutationResult> {
    let source = await this.probeUnlocked(request.from);
    if (source.state == "missing") {
      return { path: request.from, reason: "source-missing", status: "conflict" };
    }
    if (source.state == "unavailable") throw source.error;

    if (request.sourceCondition.kind == "if-unchanged") {
      let current = source.value.revision ? source : await this.readUnlocked(request.from);
      if (current.state != "present") {
        if (current.state == "unavailable") throw current.error;
        return { path: request.from, reason: "source-missing", status: "conflict" };
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
        };
      }
    }

    if (request.targetCondition.kind == "if-absent") {
      let target = await this.probeUnlocked(request.to);
      if (target.state == "present") {
        return { path: request.to, reason: "target-exists", status: "conflict" };
      }
      if (target.state == "unavailable") throw target.error;
    }

    try {
      let result = await this.host.run({
        execute: (operator) =>
          operator.rename({ from: request.from, kind: request.kind, to: request.to }),
        operation: "unconditional-mutation",
      });
      return operatorMutationResult(result);
    } catch (error) {
      if (error instanceof OpendalBrowserError && error.code == "already-exists") {
        return { path: request.to, reason: "target-exists", status: "conflict" };
      }
      if (error instanceof OpendalBrowserError && error.code == "not-found") {
        return { path: request.from, reason: "source-missing", status: "conflict" };
      }
      throw translateStorageFailure(error);
    }
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

function observationFromFailure<T>(error: unknown): SourceObservation<T> {
  if (error instanceof OpendalBrowserError) {
    if (error.code == "not-found") return { state: "missing" };
    return { error: storageErrorFromOpendal(error), state: "unavailable" };
  }
  throw error;
}

function translateStorageFailure(error: unknown) {
  if (error instanceof WorkspaceStorageError) return error;
  if (error instanceof OpendalBrowserError) return storageErrorFromOpendal(error);
  throw error;
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
