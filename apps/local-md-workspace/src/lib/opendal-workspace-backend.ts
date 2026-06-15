import type {
  CreateOpendalBrowserOperatorOptions,
  OpendalBrowserEntry,
  OpendalBrowserOperator,
  OpendalBrowserOperatorConfig,
  OpendalBrowserProvider,
  OpendalBrowserWriteOptions,
} from "@codemirror-treesitter/opendal-wasm-browser";
import {
  buildMarkdownTreeFromEntries,
  normalizeMarkdownFileName,
  normalizeWorkspaceDirectoryName,
  normalizeWorkspaceCreateTarget,
  starterMarkdown,
  type WorkspaceBackend,
  type WorkspaceBackendKind,
  type WorkspaceEntry,
  type WorkspaceEntryStat,
  type WorkspaceSourceRevision,
  type WorkspaceWriteOptions,
  type WorkspaceWriteResult,
} from "./workspace-backend.ts";

const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const OPENDAL_WASM_BUILD_COMMAND = "vp run @codemirror-treesitter/opendal-wasm-browser#build:wasm";
const generatedModuleUrl = new URL(
  "../../../../packages/opendal-wasm-browser/pkg/opendal_wasm_browser.js",
  import.meta.url,
).href;
const wasmModuleUrl = new URL(
  "../../../../packages/opendal-wasm-browser/pkg/opendal_wasm_browser_bg.wasm",
  import.meta.url,
).href;

export type OpendalWorkspaceAccessToken = {
  accessToken: string;
  expiresAt: number;
};

export type OpendalWorkspaceProvider = Extract<
  OpendalBrowserProvider,
  "dropbox" | "gdrive" | "onedrive"
>;

export type OpendalWorkspaceBackendOptions = {
  createOperator?: OpendalOperatorFactory;
  defaultName: string;
  expiredTokenPattern?: RegExp;
  getAccessToken: () => Promise<OpendalWorkspaceAccessToken>;
  kind: Extract<WorkspaceBackendKind, "opendal-dropbox" | "opendal-gdrive" | "opendal-onedrive">;
  name?: string;
  notFoundPattern?: RegExp;
  provider: OpendalWorkspaceProvider;
  refreshAccessToken: () => Promise<OpendalWorkspaceAccessToken>;
  root?: string;
};

export type OpendalOperatorFactory = (
  config: OpendalBrowserOperatorConfig,
  options: CreateOpendalBrowserOperatorOptions,
) => Promise<OpendalBrowserOperator>;

type OpendalOperatorFactoryWindow = Window & {
  __localMdWorkspaceTestDropboxOperatorFactory?: OpendalOperatorFactory;
  __localMdWorkspaceTestOpendalOperatorFactory?: OpendalOperatorFactory;
};

type OpendalWriteQueue = {
  pending?: OpendalPendingWrite;
  running: boolean;
};

type OpendalPendingWrite = {
  options?: WorkspaceWriteOptions;
  rejects: Array<(error: unknown) => void>;
  resolves: Array<(result: WorkspaceWriteResult | void) => void>;
  value: string;
};

export function createOpendalWorkspaceBackend(
  options: OpendalWorkspaceBackendOptions,
): WorkspaceBackend {
  let operator: OpendalBrowserOperator | null = null;
  let token: OpendalWorkspaceAccessToken | null = null;
  let createdDirectories = new Set<string>();
  let writeQueues = new Map<string, OpendalWriteQueue>();
  let knownRevisions = new Map<string, WorkspaceSourceRevision>();
  let root = normalizeOpendalRoot(options.root);
  let createOperator = options.createOperator ?? devTestOpendalOperatorFactory(options.provider);
  let backendName = options.name ?? options.defaultName;

  async function ensureOperator(forceRefresh = false) {
    if (forceRefresh || !token || token.expiresAt <= Date.now() + TOKEN_EXPIRY_SKEW_MS) {
      token = forceRefresh ? await options.refreshAccessToken() : await options.getAccessToken();
      operator = null;
    }

    if (!operator) {
      let config = opendalOperatorConfig(options.provider, token, root);
      operator = createOperator
        ? await createOperator(config, opendalOperatorRuntimeOptions() ?? {})
        : await createDefaultOpendalOperator(config, backendName);
    }

    return operator;
  }

  async function withOpendalRetry<T>(operation: (operator: OpendalBrowserOperator) => Promise<T>) {
    try {
      return await operation(await ensureOperator());
    } catch (error) {
      if (!isExpiredTokenError(error, options.expiredTokenPattern)) throw error;
      return operation(await ensureOperator(true));
    }
  }

  async function readText(path: string) {
    let revision = await readRevision(path);
    let value = await withOpendalRetry((operator) => operator.readText(path));
    if (revision) rememberRevision(path, revision, knownRevisions);
    return value;
  }

  async function readRevision(path: string) {
    try {
      let entry = await withOpendalRetry((operator) => operator.stat(path));
      rememberEntry(entry, knownRevisions);
      return entryRevision(entry);
    } catch (error) {
      if (isNotFoundError(error, options.notFoundPattern)) {
        knownRevisions.delete(path);
        return undefined;
      }
      throw error;
    }
  }

  async function writeText(path: string, value: string, writeOptions?: WorkspaceWriteOptions) {
    await ensureParentDirectory(path);
    let baseRevision = writeOptions?.baseRevision ?? knownRevisions.get(path);
    let entry = await withOpendalRetry((operator) => {
      let options = conditionalWriteOptions(operator, baseRevision);
      return operator.writeText(path, value, options);
    });

    if (entry) {
      rememberEntry(entry, knownRevisions);
    } else {
      knownRevisions.delete(path);
    }

    let revision = entry ? entryRevision(entry) : undefined;
    return revision ? { revision } : undefined;
  }

  async function writeQueuedText(
    path: string,
    value: string,
    writeOptions?: WorkspaceWriteOptions,
  ) {
    return writeText(path, value, writeOptions);
  }

  async function renamePath(from: string, to: string) {
    await ensureParentDirectory(to);
    await withOpendalRetry((operator) => operator.rename(from, to));
    moveKnownRevision(from, to, knownRevisions);
  }

  async function deletePath(path: string) {
    await withOpendalRetry((operator) => operator.delete(normalizeOpendalDirectoryPath(path)));
    forgetKnownRevision(path, knownRevisions);
  }

  async function ensureParentDirectory(path: string) {
    let parent = parentDirectory(path);
    if (!parent || createdDirectories.has(parent)) return;

    await createDirectory(parent, false);
  }

  async function createDirectory(path: string, allowImplicitParent = true) {
    let normalized = normalizeOpendalDirectoryPath(path);
    if (!normalized || createdDirectories.has(normalized)) return;

    await withOpendalRetry(async (operator) => {
      if (!operator.capabilities().nativeCreateDir) {
        if (allowImplicitParent) {
          throw new Error("OpenDAL backend does not support folder creation.");
        }
        return;
      }

      let current = "";
      for (let part of normalized.split("/")) {
        current = current ? `${current}/${part}` : part;
        if (createdDirectories.has(current)) continue;
        await operator.createDir(current);
        createdDirectories.add(current);
      }
    });
  }

  function queueWrite(path: string, value: string, writeOptions?: WorkspaceWriteOptions) {
    let queue = writeQueues.get(path);
    if (!queue) {
      queue = { running: false };
      writeQueues.set(path, queue);
    }

    return new Promise<void | WorkspaceWriteResult>((resolve, reject) => {
      if (queue.pending) {
        queue.pending.options = writeOptions;
        queue.pending.value = value;
        queue.pending.rejects.push(reject);
        queue.pending.resolves.push(resolve);
      } else {
        queue.pending = { options: writeOptions, rejects: [reject], resolves: [resolve], value };
      }
      void drainWriteQueue(path, queue);
    });
  }

  async function drainWriteQueue(path: string, queue: OpendalWriteQueue) {
    if (queue.running) return;
    queue.running = true;

    try {
      while (queue.pending) {
        let pending = queue.pending;
        queue.pending = undefined;

        try {
          let result = await writeQueuedText(path, pending.value, pending.options);
          for (let resolve of pending.resolves) resolve(result);
        } catch (error) {
          for (let reject of pending.rejects) reject(error);
        }
      }
    } finally {
      queue.running = false;
      if (queue.pending) {
        void drainWriteQueue(path, queue);
      } else {
        writeQueues.delete(path);
      }
    }
  }

  return {
    id: `${options.provider}:${root || "/"}`,
    kind: options.kind,
    name: backendName,
    createDirectory: (path) => createDirectory(path),
    async createFile(path) {
      let target = normalizeWorkspaceCreateTarget(path);
      if (target.kind == "directory") {
        await createDirectory(target.path);
        return null;
      }

      let nextPath = target.path;
      await queueWrite(nextPath, starterMarkdown(nextPath));
      return nextPath;
    },
    async deleteEntry(path, options) {
      await deletePath(path);
      if (options?.recursive)
        forgetCreatedDirectory(normalizeOpendalDirectoryPath(path), createdDirectories);
    },
    async deleteDirectory(path) {
      let normalized = normalizeOpendalDirectoryPath(path);
      if (!normalized) throw new Error("Enter a folder name.");

      await deletePath(normalized);
      forgetCreatedDirectory(normalized, createdDirectories);
    },
    async deleteFile(path) {
      await deletePath(path);
    },
    async listEntries(path) {
      let prefix = normalizeOpendalDirectoryPath(path);
      let entries = await withOpendalRetry((operator) => operator.list(prefix));
      for (let entry of entries) rememberEntry(entry, knownRevisions);
      return entries.map(entryToWorkspaceEntry);
    },
    async readBytes(path) {
      let value = await readText(path);
      return decodeBase64(value);
    },
    async readFile(path) {
      return readText(path);
    },
    async readTextFile(path) {
      return readText(path);
    },
    async readTree() {
      let entries = await withOpendalRetry((operator) => operator.list(""));
      for (let entry of entries) rememberEntry(entry, knownRevisions);
      return buildMarkdownTreeFromEntries(backendName, entries.map(entryToWorkspaceEntry));
    },
    async renameEntry(from, to) {
      await renamePath(from, to);
    },
    async renameDirectory(path, rawName) {
      let normalized = normalizeOpendalDirectoryPath(path);
      if (!normalized) throw new Error("Enter a folder name.");

      let nextName = normalizeWorkspaceDirectoryName(rawName);
      let nextPath = replaceFileName(normalized, nextName);
      if (nextPath == normalized) return normalized;

      await renamePath(normalized, nextPath);
      renameCreatedDirectory(normalized, nextPath, createdDirectories);
      return nextPath;
    },
    async renameFile(path, rawName) {
      let nextName = normalizeMarkdownFileName(rawName);
      let nextPath = replaceFileName(path, nextName);
      if (nextPath == path) return path;

      await renamePath(path, nextPath);
      return nextPath;
    },
    async writeFile(path, value, writeOptions) {
      return queueWrite(path, value, writeOptions);
    },
    async stat(path) {
      try {
        let entry = await withOpendalRetry((operator) => operator.stat(path));
        rememberEntry(entry, knownRevisions);
        return entryToWorkspaceStat(entry, true);
      } catch (error) {
        if (isNotFoundError(error, options.notFoundPattern)) {
          knownRevisions.delete(path);
          return {
            exists: false,
            isDirectory: false,
            isFile: false,
            path,
          };
        }
        throw error;
      }
    },
    async writeBytes(path, bytes) {
      await queueWrite(path, encodeBase64(bytes));
    },
    async writeTextFile(path, value) {
      await queueWrite(path, value);
    },
  };
}

function conditionalWriteOptions(
  operator: OpendalBrowserOperator,
  revision: WorkspaceSourceRevision | undefined,
): OpendalBrowserWriteOptions | undefined {
  if (!revision?.etag || !operator.capabilities().nativeWriteWithIfMatch) return undefined;
  return { ifMatch: revision.etag };
}

function rememberEntry(
  entry: OpendalBrowserEntry,
  revisions: Map<string, WorkspaceSourceRevision>,
) {
  let revision = entryRevision(entry);
  if (!revision) return;
  revisions.set(entry.path, revision);
}

function rememberRevision(
  path: string,
  revision: WorkspaceSourceRevision | undefined,
  revisions: Map<string, WorkspaceSourceRevision>,
) {
  if (!revision) return;
  revisions.set(path, revision);
}

function entryRevision(entry: OpendalBrowserEntry): WorkspaceSourceRevision | undefined {
  let revision = {
    etag: emptyToUndefined(entry.etag),
    version: emptyToUndefined(entry.version),
  };
  return revision.etag || revision.version ? revision : undefined;
}

function entryToWorkspaceEntry(entry: OpendalBrowserEntry): WorkspaceEntry {
  return {
    isDirectory: entry.isDirectory,
    isFile: entry.isFile,
    path: entry.path,
    revision: entryRevision(entry),
  };
}

function entryToWorkspaceStat(entry: OpendalBrowserEntry, exists: boolean): WorkspaceEntryStat {
  return {
    ...entryToWorkspaceEntry(entry),
    exists,
    mtime: entry.lastModified ? Date.parse(entry.lastModified) || undefined : undefined,
    size: entry.size,
  };
}

function forgetCreatedDirectory(path: string, directories: Set<string>) {
  for (let directory of directories) {
    if (directory == path || directory.startsWith(`${path}/`)) {
      directories.delete(directory);
    }
  }
}

function renameCreatedDirectory(path: string, nextPath: string, directories: Set<string>) {
  let updates: string[] = [];
  for (let directory of directories) {
    if (directory == path || directory.startsWith(`${path}/`)) {
      directories.delete(directory);
      updates.push(`${nextPath}${directory.slice(path.length)}`);
    }
  }
  for (let directory of updates) directories.add(directory);
}

function opendalOperatorConfig(
  provider: OpendalWorkspaceProvider,
  token: OpendalWorkspaceAccessToken,
  root: string | undefined,
): OpendalBrowserOperatorConfig {
  switch (provider) {
    case "dropbox":
      return {
        accessToken: token.accessToken,
        provider: "dropbox",
        root,
      };
    case "gdrive":
      return {
        accessToken: token.accessToken,
        provider: "gdrive",
        root,
      };
    case "onedrive":
      return {
        accessToken: token.accessToken,
        provider: "onedrive",
        root,
      };
  }
}

async function createDefaultOpendalOperator(
  config: OpendalBrowserOperatorConfig,
  storageName: string,
) {
  try {
    let runtimeOptions = opendalOperatorRuntimeOptions();
    if (!runtimeOptions) {
      throw new Error("OpenDAL browser WASM assets are missing from the build.");
    }
    let { createOpendalBrowserOperator } =
      await import("@codemirror-treesitter/opendal-wasm-browser");
    return await createOpendalBrowserOperator(config, runtimeOptions);
  } catch (error) {
    throw unavailableOpendalRuntimeError(error, storageName);
  }
}

function opendalOperatorRuntimeOptions(): CreateOpendalBrowserOperatorOptions | null {
  return generatedModuleUrl && wasmModuleUrl ? { generatedModuleUrl, wasmModuleUrl } : null;
}

function unavailableOpendalRuntimeError(error: unknown, storageName: string) {
  let detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `${storageName} storage runtime is unavailable. Build the OpenDAL browser WASM package with \`${OPENDAL_WASM_BUILD_COMMAND}\`, then reconnect ${storageName} workspace. ${detail}`,
  );
}

function devTestOpendalOperatorFactory(provider: OpendalWorkspaceProvider) {
  if (!import.meta.env.DEV || typeof window == "undefined") return null;
  let testWindow = window as OpendalOperatorFactoryWindow;
  if (provider == "dropbox") {
    let dropboxFactory = testWindow.__localMdWorkspaceTestDropboxOperatorFactory;
    if (typeof dropboxFactory == "function") return dropboxFactory;
  }
  let factory = testWindow.__localMdWorkspaceTestOpendalOperatorFactory;
  return typeof factory == "function" ? factory : null;
}

function normalizeOpendalRoot(value: string | undefined) {
  let root = value
    ?.trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return root || undefined;
}

function replaceFileName(path: string, nextName: string) {
  let index = path.lastIndexOf("/");
  return index == -1 ? nextName : `${path.slice(0, index + 1)}${nextName}`;
}

function parentDirectory(path: string) {
  let index = path.lastIndexOf("/");
  return index == -1 ? "" : path.slice(0, index);
}

function normalizeOpendalDirectoryPath(path: string) {
  let normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return normalized || "";
}

function moveKnownRevision(
  from: string,
  to: string,
  revisions: Map<string, WorkspaceSourceRevision>,
) {
  let updates: Array<[string, WorkspaceSourceRevision]> = [];
  for (let [path, revision] of revisions) {
    if (path == from || path.startsWith(`${from}/`)) {
      revisions.delete(path);
      updates.push([`${to}${path.slice(from.length)}`, revision]);
    }
  }
  for (let [path, revision] of updates) revisions.set(path, revision);
}

function forgetKnownRevision(path: string, revisions: Map<string, WorkspaceSourceRevision>) {
  for (let knownPath of revisions.keys()) {
    if (knownPath == path || knownPath.startsWith(`${path}/`)) {
      revisions.delete(knownPath);
    }
  }
}

function isExpiredTokenError(error: unknown, pattern: RegExp | undefined) {
  let message = error instanceof Error ? error.message : String(error);
  return (pattern ?? /expired|expired_access_token|invalid_access_token|invalid_token|401/i).test(
    message,
  );
}

function isNotFoundError(error: unknown, pattern: RegExp | undefined) {
  let message = error instanceof Error ? error.message : String(error);
  return (
    (pattern ?? /not.?found|not_found|404/i).test(message) ||
    /path[/_. -]?not[/_. -]?found/i.test(message) ||
    /lookup[/_. -]?not[/_. -]?found/i.test(message)
  );
}

function decodeBase64(value: string) {
  let binary = atob(value);
  let bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array) {
  let chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

function emptyToUndefined(value: string | undefined) {
  let trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
