import { sha256ContentHash } from "@/lib/workspace/storage/opendal-workspace-object-store";
import type {
  SourceObservation,
  SourceProbe,
  SourceRevision,
  SourceSnapshot,
  WorkspaceCommitRequest,
  WorkspaceCommitResult,
  WorkspaceDeleteRequest,
  WorkspaceEntry,
  WorkspaceMoveRequest,
  WorkspaceObjectStore,
  WorkspaceObjectStoreCapabilities,
  WorkspacePathMutationResult,
  WorkspaceStorageKind,
  WorkspaceTargetCondition,
} from "@/lib/workspace/storage/types";
import {
  OpendalWorkspaceAssetService,
  OpendalWorkspaceDocumentService,
  OpendalWorkspaceEntryService,
  OpendalWorkspaceTreeService,
} from "@/lib/workspace/runtime/services";
import type { WorkspaceIdentity, WorkspaceRuntime } from "@/lib/workspace/runtime/types";

export type MemoryWorkspaceRuntime = WorkspaceRuntime & {
  files: Map<string, string>;
};

export function createMemoryWorkspaceRuntime(
  entries: Iterable<readonly [string, string]> | Map<string, string> = [],
  options: {
    id?: string;
    kind?: WorkspaceStorageKind;
    name?: string;
    sourceAliases?: WorkspaceIdentity["sourceAliases"];
  } = {},
): MemoryWorkspaceRuntime {
  let files =
    entries instanceof Map
      ? entries
      : new Map(Array.from(entries, ([path, value]) => [normalizePath(path), value]));
  let identity: WorkspaceIdentity = {
    id: options.id ?? "memory:test",
    kind: options.kind ?? "local",
    name: options.name ?? "Memory",
    sourceAliases: options.sourceAliases,
  };
  let store = new MemoryWorkspaceObjectStore(identity.id, files);

  return {
    assets: new OpendalWorkspaceAssetService(store),
    currentDocumentChanges: null,
    dispose: async () => {},
    documents: new OpendalWorkspaceDocumentService(store),
    entries: new OpendalWorkspaceEntryService(store),
    files,
    host: {},
    identity,
    tree: new OpendalWorkspaceTreeService(store, identity.name),
  };
}

const memoryCapabilities: WorkspaceObjectStoreCapabilities = {
  commit: { ifAbsent: "observed", ifUnchanged: "observed" },
  createDirectory: { ifAbsent: "observed", supported: true },
  delete: { ifUnchanged: "observed", recursive: "native", single: true },
  move: {
    directory: "native",
    file: "native",
    sourceIfUnchanged: "observed",
    targetIfAbsent: "observed",
  },
};

class MemoryWorkspaceObjectStore implements WorkspaceObjectStore {
  readonly capabilities = memoryCapabilities;
  private readonly binaryFiles = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>([""]);

  constructor(
    readonly id: string,
    private readonly textFiles: Map<string, string>,
  ) {
    for (let path of textFiles.keys()) rememberParentDirectories(this.directories, path);
  }

  async probe(path: string): Promise<SourceObservation<SourceProbe>> {
    path = normalizePath(path);
    let bytes = this.bytes(path);
    if (bytes) {
      return {
        state: "present",
        value: {
          kind: "file",
          metadata: { size: bytes.byteLength },
          revision: await revisionForBytes(bytes),
        },
      };
    }
    return this.directories.has(path)
      ? { state: "present", value: { kind: "directory", metadata: {} } }
      : { state: "missing" };
  }

  async read(path: string): Promise<SourceObservation<SourceSnapshot>> {
    path = normalizePath(path);
    let bytes = this.bytes(path);
    if (!bytes) return { state: "missing" };
    let contentHash = await sha256ContentHash(bytes);
    return {
      state: "present",
      value: {
        bytes,
        capture: "observed",
        contentHash,
        metadata: { size: bytes.byteLength },
        revision: memoryRevision(contentHash),
      },
    };
  }

  async listDirectory(path: string): Promise<WorkspaceEntry[]> {
    let parent = normalizePath(path, true);
    let prefix = parent ? `${parent}/` : "";
    let paths = new Set([
      ...this.directories,
      ...this.textFiles.keys(),
      ...this.binaryFiles.keys(),
    ]);
    let entries: WorkspaceEntry[] = [];
    for (let item of paths) {
      if (!item || !item.startsWith(prefix)) continue;
      let relative = item.slice(prefix.length);
      if (!relative || relative.includes("/")) continue;
      let bytes = this.bytes(item);
      entries.push({
        kind: bytes ? "file" : "directory",
        metadata: bytes ? { size: bytes.byteLength } : {},
        path: item,
      });
    }
    return entries;
  }

  async commit(request: WorkspaceCommitRequest): Promise<WorkspaceCommitResult> {
    let path = normalizePath(request.path);
    let current = await this.read(path);
    if (request.condition.kind == "if-absent" && current.state == "present") {
      return { current: current.value.revision, status: "conflict" };
    }
    if (
      request.condition.kind == "if-unchanged" &&
      (current.state != "present" ||
        !sameRevision(current.value.revision, request.condition.revision))
    ) {
      return {
        current: current.state == "present" ? current.value.revision : undefined,
        status: "conflict",
      };
    }

    let bytes = Uint8Array.from(request.bytes);
    if (this.textFiles.has(path) || path.toLowerCase().endsWith(".md")) {
      this.textFiles.set(path, new TextDecoder().decode(bytes));
      this.binaryFiles.delete(path);
    } else {
      this.binaryFiles.set(path, bytes);
      this.textFiles.delete(path);
    }
    rememberParentDirectories(this.directories, path);
    return { revision: await revisionForBytes(bytes), status: "committed" };
  }

  async createDirectory(
    path: string,
    condition: WorkspaceTargetCondition,
  ): Promise<WorkspacePathMutationResult> {
    path = normalizePath(path);
    if (this.exists(path)) {
      return condition.kind == "unconditional"
        ? { status: "applied" }
        : { path, reason: "target-exists", status: "conflict" };
    }
    this.directories.add(path);
    rememberParentDirectories(this.directories, path);
    return { status: "applied" };
  }

  async delete(request: WorkspaceDeleteRequest): Promise<WorkspacePathMutationResult> {
    let path = normalizePath(request.path);
    if (request.condition.kind == "if-unchanged") {
      let current = await this.read(path);
      if (current.state != "present") {
        return { path, reason: "source-missing", status: "conflict" };
      }
      if (!sameRevision(current.value.revision, request.condition.revision)) {
        return {
          current: current.value.revision,
          path,
          reason: "source-changed",
          status: "conflict",
        };
      }
    }
    if (!this.exists(path)) return { status: "applied" };

    let prefix = `${path}/`;
    let descendants = this.paths().filter((item) => item.startsWith(prefix));
    if (descendants.length && !request.recursive) {
      return { reconcilePaths: [path], status: "unknown" };
    }
    this.textFiles.delete(path);
    this.binaryFiles.delete(path);
    this.directories.delete(path);
    for (let item of descendants) {
      this.textFiles.delete(item);
      this.binaryFiles.delete(item);
      this.directories.delete(item);
    }
    return { status: "applied" };
  }

  async move(request: WorkspaceMoveRequest): Promise<WorkspacePathMutationResult> {
    let from = normalizePath(request.from);
    let to = normalizePath(request.to);
    if (!this.exists(from)) {
      return { path: from, reason: "source-missing", status: "conflict" };
    }
    if (request.targetCondition.kind == "if-absent" && this.exists(to)) {
      return { path: to, reason: "target-exists", status: "conflict" };
    }
    if (request.sourceCondition.kind == "if-unchanged") {
      let current = await this.read(from);
      if (
        current.state != "present" ||
        !sameRevision(current.value.revision, request.sourceCondition.revision)
      ) {
        return {
          current: current.state == "present" ? current.value.revision : undefined,
          path: from,
          reason: current.state == "present" ? "source-changed" : "source-missing",
          status: "conflict",
        };
      }
    }

    moveMapEntries(this.textFiles, from, to);
    moveMapEntries(this.binaryFiles, from, to);
    for (let path of Array.from(this.directories)) {
      if (path != from && !path.startsWith(`${from}/`)) continue;
      this.directories.delete(path);
      this.directories.add(`${to}${path.slice(from.length)}`);
    }
    rememberParentDirectories(this.directories, to);
    return { status: "applied" };
  }

  private bytes(path: string) {
    let binary = this.binaryFiles.get(path);
    if (binary) return Uint8Array.from(binary);
    let text = this.textFiles.get(path);
    return text == null ? undefined : new TextEncoder().encode(text);
  }

  private exists(path: string) {
    return this.textFiles.has(path) || this.binaryFiles.has(path) || this.directories.has(path);
  }

  private paths() {
    return [...this.textFiles.keys(), ...this.binaryFiles.keys(), ...this.directories];
  }
}

async function revisionForBytes(bytes: Uint8Array) {
  return memoryRevision(await sha256ContentHash(bytes));
}

function memoryRevision(contentHash: string): SourceRevision {
  return { kind: "fingerprint", validation: "observed", value: `memory:${contentHash}` };
}

function sameRevision(left: SourceRevision, right: SourceRevision) {
  return (
    left.kind == right.kind && left.validation == right.validation && left.value == right.value
  );
}

function moveMapEntries<T>(map: Map<string, T>, from: string, to: string) {
  for (let [path, value] of Array.from(map)) {
    if (path != from && !path.startsWith(`${from}/`)) continue;
    map.delete(path);
    map.set(`${to}${path.slice(from.length)}`, value);
  }
}

function rememberParentDirectories(directories: Set<string>, rawPath: string) {
  let parts = normalizePath(rawPath, true).split("/").filter(Boolean);
  parts.pop();
  let parent = "";
  for (let part of parts) {
    parent = parent ? `${parent}/${part}` : part;
    directories.add(parent);
  }
}

function normalizePath(path: string, allowRoot = false) {
  let parts = path.trim().replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.some((part) => part == "." || part == "..")) {
    throw new Error("Memory workspace paths cannot contain . or .. segments.");
  }
  if (!parts.length && !allowRoot) throw new Error("Memory workspace path is required.");
  return parts.join("/");
}
