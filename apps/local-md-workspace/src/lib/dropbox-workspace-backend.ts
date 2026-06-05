import { createOpendalBrowserOperator } from "@codemirror-treesitter/opendal-wasm-browser";
import type {
  CreateOpendalBrowserOperatorOptions,
  OpendalBrowserOperator,
  OpendalBrowserOperatorConfig,
} from "@codemirror-treesitter/opendal-wasm-browser";
import type { DropboxAccessToken } from "./dropbox-oauth.ts";
import {
  buildMarkdownTreeFromEntries,
  normalizeMarkdownFileName,
  normalizeWorkspaceDirectoryName,
  normalizeWorkspaceCreateTarget,
  starterMarkdown,
  type WorkspaceBackend,
} from "./workspace-backend.ts";

const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const generatedModuleUrl = new URL(
  "../../../../packages/opendal-wasm-browser/pkg/opendal_wasm_browser.js",
  import.meta.url,
).href;
const wasmModuleUrl = new URL(
  "../../../../packages/opendal-wasm-browser/pkg/opendal_wasm_browser_bg.wasm",
  import.meta.url,
).href;

export type DropboxWorkspaceBackendOptions = {
  createOperator?: DropboxOperatorFactory;
  getAccessToken: () => Promise<DropboxAccessToken>;
  name?: string;
  refreshAccessToken: () => Promise<DropboxAccessToken>;
  root?: string;
};

type DropboxOperatorFactory = (
  config: OpendalBrowserOperatorConfig,
  options: CreateOpendalBrowserOperatorOptions,
) => Promise<OpendalBrowserOperator>;

type DropboxWriteQueue = {
  pending?: DropboxPendingWrite;
  running: boolean;
};

type DropboxPendingWrite = {
  rejects: Array<(error: unknown) => void>;
  resolves: Array<() => void>;
  value: string;
};

export function createDropboxWorkspaceBackend(
  options: DropboxWorkspaceBackendOptions,
): WorkspaceBackend {
  let operator: OpendalBrowserOperator | null = null;
  let token: DropboxAccessToken | null = null;
  let createdDirectories = new Set<string>();
  let writeQueues = new Map<string, DropboxWriteQueue>();
  let root = normalizeDropboxRoot(options.root);
  let createOperator = options.createOperator ?? createOpendalBrowserOperator;

  async function ensureOperator(forceRefresh = false) {
    if (forceRefresh || !token || token.expiresAt <= Date.now() + TOKEN_EXPIRY_SKEW_MS) {
      token = forceRefresh ? await options.refreshAccessToken() : await options.getAccessToken();
      operator = null;
    }

    if (!operator) {
      operator = await createOperator(dropboxOperatorConfig(token, root), {
        generatedModuleUrl,
        wasmModuleUrl,
      });
    }

    return operator;
  }

  async function withDropboxRetry<T>(operation: (operator: OpendalBrowserOperator) => Promise<T>) {
    try {
      return await operation(await ensureOperator());
    } catch (error) {
      if (!isDropboxExpiredTokenError(error)) throw error;
      return operation(await ensureOperator(true));
    }
  }

  async function writeText(path: string, value: string) {
    await ensureParentDirectory(path);
    await withDropboxRetry((operator) => operator.writeText(path, value));
  }

  async function ensureParentDirectory(path: string) {
    let parent = parentDirectory(path);
    if (!parent || createdDirectories.has(parent)) return;

    await createDirectory(parent, false);
  }

  async function createDirectory(path: string, allowImplicitParent = true) {
    let normalized = normalizeDropboxDirectoryPath(path);
    if (!normalized || createdDirectories.has(normalized)) return;

    await withDropboxRetry(async (operator) => {
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

  function queueWrite(path: string, value: string) {
    let queue = writeQueues.get(path);
    if (!queue) {
      queue = { running: false };
      writeQueues.set(path, queue);
    }

    return new Promise<void>((resolve, reject) => {
      if (queue.pending) {
        queue.pending.value = value;
        queue.pending.rejects.push(reject);
        queue.pending.resolves.push(resolve);
      } else {
        queue.pending = { rejects: [reject], resolves: [resolve], value };
      }
      void drainWriteQueue(path, queue);
    });
  }

  async function drainWriteQueue(path: string, queue: DropboxWriteQueue) {
    if (queue.running) return;
    queue.running = true;

    try {
      while (queue.pending) {
        let pending = queue.pending;
        queue.pending = undefined;

        try {
          await writeText(path, pending.value);
          for (let resolve of pending.resolves) resolve();
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
    id: `dropbox:${root || "/"}`,
    kind: "opendal-dropbox",
    name: options.name ?? "Dropbox",
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
    async deleteDirectory(path) {
      let normalized = normalizeDropboxDirectoryPath(path);
      if (!normalized) throw new Error("Enter a folder name.");

      await withDropboxRetry((operator) => operator.delete(normalized));
      forgetCreatedDirectory(normalized, createdDirectories);
    },
    async deleteFile(path) {
      await withDropboxRetry((operator) => operator.delete(path));
    },
    async readFile(path) {
      return withDropboxRetry((operator) => operator.readText(path));
    },
    async readTree() {
      let entries = await withDropboxRetry((operator) => operator.list(""));
      return buildMarkdownTreeFromEntries(options.name ?? "Dropbox", entries);
    },
    async renameDirectory(path, rawName) {
      let normalized = normalizeDropboxDirectoryPath(path);
      if (!normalized) throw new Error("Enter a folder name.");

      let nextName = normalizeWorkspaceDirectoryName(rawName);
      let nextPath = replaceFileName(normalized, nextName);
      if (nextPath == normalized) return normalized;

      await withDropboxRetry((operator) => operator.rename(normalized, nextPath));
      renameCreatedDirectory(normalized, nextPath, createdDirectories);
      return nextPath;
    },
    async renameFile(path, rawName) {
      let nextName = normalizeMarkdownFileName(rawName);
      let nextPath = replaceFileName(path, nextName);
      if (nextPath == path) return path;

      await ensureParentDirectory(nextPath);
      await withDropboxRetry((operator) => operator.rename(path, nextPath));
      return nextPath;
    },
    async writeFile(path, value) {
      await queueWrite(path, value);
    },
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

function dropboxOperatorConfig(
  token: DropboxAccessToken,
  root: string | undefined,
): OpendalBrowserOperatorConfig {
  return {
    accessToken: token.accessToken,
    provider: "dropbox",
    root,
  };
}

function normalizeDropboxRoot(value: string | undefined) {
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

function normalizeDropboxDirectoryPath(path: string) {
  let normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return normalized || "";
}

function isDropboxExpiredTokenError(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  return /expired|expired_access_token|invalid_access_token/i.test(message);
}
