import { sha256ContentHash } from "@/lib/storage/opendal-workspace-object-store";
import type {
  SourceObservation,
  SourceRevision,
  WorkspaceCommitCondition,
  WorkspaceCommitResult,
  WorkspaceMetadata,
  WorkspacePathMutationResult,
  WorkspaceStorageKind,
} from "@/lib/storage/types";
import {
  buildMarkdownDirectoryFromEntries,
  buildMarkdownTreeFromEntries,
  joinWorkspacePath,
  normalizeMarkdownFileName,
  normalizeWorkspaceCreateTarget,
  normalizeWorkspaceDirectoryName,
  starterMarkdown,
  type CreatedWorkspaceImageNode,
  type WorkspaceEntry,
} from "@/lib/workspace-tree";
import type {
  WorkspaceIdentity,
  WorkspaceRuntime,
  WorkspaceTextSnapshot,
} from "@/lib/workspace-runtime/types";

export type MemoryWorkspaceRuntime = WorkspaceRuntime & {
  binaryFiles: Map<string, Uint8Array>;
  directories: Set<string>;
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
  let binaryFiles = new Map<string, Uint8Array>();
  let directories = new Set<string>([""]);
  for (let path of files.keys()) rememberParentDirectories(directories, path);

  let identity: WorkspaceIdentity = {
    id: options.id ?? "memory:test",
    kind: options.kind ?? "local",
    name: options.name ?? "Memory",
    sourceAliases: options.sourceAliases,
  };

  async function observeText(path: string): Promise<SourceObservation<WorkspaceTextSnapshot>> {
    path = normalizePath(path);
    let value = files.get(path);
    if (value == null) return { state: "missing" };
    let bytes = new TextEncoder().encode(value);
    let contentHash = await sha256ContentHash(bytes);
    let metadata = { size: bytes.byteLength };
    return {
      state: "present",
      value: {
        bytes,
        capture: "observed",
        contentHash,
        metadata,
        revision: memoryRevision(contentHash),
        value,
      },
    };
  }

  async function commitText(input: {
    condition: WorkspaceCommitCondition;
    path: string;
    value: string;
  }): Promise<WorkspaceCommitResult> {
    let path = normalizePath(input.path);
    let conflict = await textCommitConflict(path, input.condition, observeText);
    if (conflict) return conflict;
    files.set(path, input.value);
    binaryFiles.delete(path);
    rememberParentDirectories(directories, path);
    let observation = await observeText(path);
    if (observation.state != "present") throw new Error(`Failed to commit ${path}.`);
    return { revision: observation.value.revision, status: "committed" };
  }

  let runtime: MemoryWorkspaceRuntime = {
    assets: {
      async create(markdownFilePath, imageFile) {
        let parent = normalizePath(markdownFilePath).split("/").slice(0, -1).join("/");
        let assetsPath = joinWorkspacePath(parent, "assets");
        directories.add(assetsPath);
        rememberParentDirectories(directories, assetsPath);
        let rawName = imageFile.name || "image.png";
        let extension = rawName.match(/\.[^.]+$/)?.[0] ?? ".png";
        let baseName =
          rawName
            .slice(0, -extension.length)
            .normalize("NFKD")
            .replace(/[^a-zA-Z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase() || "image";
        let bytes = new Uint8Array(await imageFile.arrayBuffer());
        for (let suffix = 0; suffix < 10_000; suffix++) {
          let name = `${baseName}${suffix ? `-${suffix + 1}` : ""}${extension.toLowerCase()}`;
          let path = joinWorkspacePath(assetsPath, name);
          if (pathExists(path, files, binaryFiles, directories)) continue;
          binaryFiles.set(path, bytes);
          rememberParentDirectories(directories, path);
          return {
            file: imageFile,
            markdownReference: `assets/${name}`,
            name,
            path,
          } satisfies CreatedWorkspaceImageNode;
        }
        throw new Error("Could not allocate a unique image asset name.");
      },
      async delete(path) {
        return deletePath(path, false, files, binaryFiles, directories);
      },
      async read(path) {
        path = normalizePath(path);
        let bytes = binaryFiles.get(path);
        if (bytes) return Uint8Array.from(bytes);
        let value = files.get(path);
        if (value != null) return new TextEncoder().encode(value);
        throw new Error(`${path} does not exist.`);
      },
      async write({ condition, path, value }) {
        path = normalizePath(path);
        let conflict = await binaryCommitConflict(path, condition, files, binaryFiles, directories);
        if (conflict) return conflict;
        binaryFiles.set(path, Uint8Array.from(value));
        files.delete(path);
        rememberParentDirectories(directories, path);
        return {
          revision: await revisionForBytes(value),
          status: "committed",
        };
      },
    },
    binaryFiles,
    currentDocumentChanges: null,
    directories,
    dispose: async () => {},
    documents: {
      commit: commitText,
      observe: observeText,
    },
    entries: {
      async create(rawPath) {
        let target = normalizeWorkspaceCreateTarget(rawPath);
        if (pathExists(target.path, files, binaryFiles, directories)) {
          throw new Error(`${target.path} already exists.`);
        }
        if (target.kind == "directory") {
          directories.add(target.path);
          rememberParentDirectories(directories, target.path);
          return null;
        }
        files.set(target.path, starterMarkdown(target.path));
        rememberParentDirectories(directories, target.path);
        return target.path;
      },
      async delete({ kind, path, revision }) {
        path = normalizePath(path);
        if (revision) {
          let current = await probePath(path, files, binaryFiles, directories);
          if (current.state != "present") {
            return { path, reason: "source-missing", status: "conflict" };
          }
          let currentRevision =
            current.value.kind == "file"
              ? await revisionForPath(path, files, binaryFiles)
              : undefined;
          if (!currentRevision || !sameRevision(currentRevision, revision)) {
            return {
              current: currentRevision,
              path,
              reason: "source-changed",
              status: "conflict",
            };
          }
        }
        return deletePath(path, kind == "directory", files, binaryFiles, directories);
      },
      async move({ from, kind, revision, to }) {
        return movePath({ from, kind, revision, to }, files, binaryFiles, directories);
      },
      async probe(path) {
        return probePath(path, files, binaryFiles, directories);
      },
      async rename({ kind, path, rawName, revision }) {
        let name =
          kind == "file"
            ? normalizeMarkdownFileName(rawName)
            : normalizeWorkspaceDirectoryName(rawName);
        let parent = normalizePath(path).split("/").slice(0, -1).join("/");
        let to = joinWorkspacePath(parent, name);
        return {
          path: to,
          result: await movePath(
            { from: path, kind, revision, to },
            files,
            binaryFiles,
            directories,
          ),
        };
      },
    },
    files,
    host: {},
    identity,
    tree: {
      async listEntries(path) {
        return listEntries(path, files, binaryFiles, directories).map((entry) => ({
          kind: entry.isDirectory ? ("directory" as const) : ("file" as const),
          metadata: {},
          path: entry.path,
        }));
      },
      async readDirectory(path, name) {
        return buildMarkdownDirectoryFromEntries(
          name,
          path,
          listEntries(path, files, binaryFiles, directories),
        );
      },
      async readTree() {
        return buildMarkdownTreeFromEntries(
          identity.name,
          allEntries(files, binaryFiles, directories),
        );
      },
    },
  };
  return runtime;
}

async function textCommitConflict(
  path: string,
  condition: WorkspaceCommitCondition,
  observe: (path: string) => Promise<SourceObservation<WorkspaceTextSnapshot>>,
) {
  let current = await observe(path);
  if (condition.kind == "if-absent") {
    return current.state == "present"
      ? ({ current: current.value.revision, status: "conflict" } as const)
      : null;
  }
  if (condition.kind != "if-unchanged") return null;
  return current.state != "present" || !sameRevision(current.value.revision, condition.revision)
    ? ({
        current: current.state == "present" ? current.value.revision : undefined,
        status: "conflict",
      } as const)
    : null;
}

async function binaryCommitConflict(
  path: string,
  condition: WorkspaceCommitCondition,
  files: Map<string, string>,
  binaryFiles: Map<string, Uint8Array>,
  directories: Set<string>,
) {
  let exists = pathExists(path, files, binaryFiles, directories);
  if (condition.kind == "if-absent") return exists ? ({ status: "conflict" } as const) : null;
  if (condition.kind != "if-unchanged") return null;
  let current = await revisionForPath(path, files, binaryFiles);
  return !current || !sameRevision(current, condition.revision)
    ? ({ current, status: "conflict" } as const)
    : null;
}

async function probePath(
  rawPath: string,
  files: Map<string, string>,
  binaryFiles: Map<string, Uint8Array>,
  directories: Set<string>,
) {
  let path = normalizePath(rawPath);
  if (files.has(path) || binaryFiles.has(path)) {
    let bytes = binaryFiles.get(path) ?? new TextEncoder().encode(files.get(path) ?? "");
    return {
      state: "present" as const,
      value: {
        kind: "file" as const,
        metadata: { size: bytes.byteLength },
        revision: await revisionForBytes(bytes),
      },
    };
  }
  if (directories.has(path)) {
    return {
      state: "present" as const,
      value: { kind: "directory" as const, metadata: {} satisfies WorkspaceMetadata },
    };
  }
  return { state: "missing" as const };
}

async function revisionForPath(
  path: string,
  files: Map<string, string>,
  binaryFiles: Map<string, Uint8Array>,
) {
  let bytes = binaryFiles.get(path);
  if (!bytes) {
    let value = files.get(path);
    if (value == null) return undefined;
    bytes = new TextEncoder().encode(value);
  }
  return revisionForBytes(bytes);
}

async function revisionForBytes(bytes: Uint8Array): Promise<SourceRevision> {
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

async function deletePath(
  rawPath: string,
  recursive: boolean,
  files: Map<string, string>,
  binaryFiles: Map<string, Uint8Array>,
  directories: Set<string>,
): Promise<WorkspacePathMutationResult> {
  let path = normalizePath(rawPath);
  let exists = pathExists(path, files, binaryFiles, directories);
  if (!exists) return { status: "applied" };
  let prefix = `${path}/`;
  let hasChildren = [...files.keys(), ...binaryFiles.keys(), ...directories].some((item) =>
    item.startsWith(prefix),
  );
  if (hasChildren && !recursive) {
    return { reconcilePaths: [path], status: "unknown" };
  }
  files.delete(path);
  binaryFiles.delete(path);
  directories.delete(path);
  if (recursive) {
    for (let item of files.keys()) if (item.startsWith(prefix)) files.delete(item);
    for (let item of binaryFiles.keys()) if (item.startsWith(prefix)) binaryFiles.delete(item);
    for (let item of directories) if (item.startsWith(prefix)) directories.delete(item);
  }
  return { status: "applied" };
}

async function movePath(
  input: {
    from: string;
    kind: "directory" | "file";
    revision?: SourceRevision;
    to: string;
  },
  files: Map<string, string>,
  binaryFiles: Map<string, Uint8Array>,
  directories: Set<string>,
): Promise<WorkspacePathMutationResult> {
  let from = normalizePath(input.from);
  let to = normalizePath(input.to);
  if (!pathExists(from, files, binaryFiles, directories)) {
    return { path: from, reason: "source-missing", status: "conflict" };
  }
  if (pathExists(to, files, binaryFiles, directories)) {
    return { path: to, reason: "target-exists", status: "conflict" };
  }
  if (input.revision) {
    let current = await revisionForPath(from, files, binaryFiles);
    if (!current || !sameRevision(current, input.revision)) {
      return { current, path: from, reason: "source-changed", status: "conflict" };
    }
  }

  let moveMap = <T>(map: Map<string, T>) => {
    for (let [path, value] of Array.from(map)) {
      if (path != from && !path.startsWith(`${from}/`)) continue;
      map.delete(path);
      map.set(`${to}${path.slice(from.length)}`, value);
    }
  };
  moveMap(files);
  moveMap(binaryFiles);
  for (let path of Array.from(directories)) {
    if (path != from && !path.startsWith(`${from}/`)) continue;
    directories.delete(path);
    directories.add(`${to}${path.slice(from.length)}`);
  }
  rememberParentDirectories(directories, to);
  return { status: "applied" };
}

function listEntries(
  rawParent: string,
  files: Map<string, string>,
  binaryFiles: Map<string, Uint8Array>,
  directories: Set<string>,
) {
  let parent = normalizePath(rawParent, true);
  let prefix = parent ? `${parent}/` : "";
  let entries = new Map<string, WorkspaceEntry>();
  for (let path of [...directories, ...files.keys(), ...binaryFiles.keys()]) {
    if (!path || !path.startsWith(prefix)) continue;
    let relative = path.slice(prefix.length);
    if (!relative || relative.includes("/")) continue;
    entries.set(path, {
      isDirectory: directories.has(path),
      isFile: files.has(path) || binaryFiles.has(path),
      path,
    });
  }
  return [...entries.values()];
}

function allEntries(
  files: Map<string, string>,
  binaryFiles: Map<string, Uint8Array>,
  directories: Set<string>,
) {
  return [
    ...[...directories].filter(Boolean).map((path) => ({ isDirectory: true, isFile: false, path })),
    ...[...new Set([...files.keys(), ...binaryFiles.keys()])].map((path) => ({
      isDirectory: false,
      isFile: true,
      path,
    })),
  ];
}

function pathExists(
  path: string,
  files: Map<string, string>,
  binaryFiles: Map<string, Uint8Array>,
  directories: Set<string>,
) {
  return files.has(path) || binaryFiles.has(path) || directories.has(path);
}

function rememberParentDirectories(directories: Set<string>, rawPath: string) {
  let parts = normalizePath(rawPath, true).split("/").filter(Boolean);
  parts.pop();
  let parent = "";
  for (let part of parts) {
    parent = joinWorkspacePath(parent, part);
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
