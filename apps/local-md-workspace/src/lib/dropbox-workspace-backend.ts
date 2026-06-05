import { createOpendalBrowserOperator } from "@codemirror-treesitter/opendal-wasm-browser";
import type {
  CreateOpendalBrowserOperatorOptions,
  OpendalBrowserOperator,
  OpendalBrowserOperatorConfig,
} from "@codemirror-treesitter/opendal-wasm-browser";
import type { DropboxAccessToken } from "./dropbox-oauth.ts";
import {
  buildMarkdownTreeFromPaths,
  normalizeMarkdownFileName,
  normalizeMarkdownPath,
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

    await withDropboxRetry(async (operator) => {
      if (!operator.capabilities().nativeCreateDir) return;
      await operator.createDir(parent);
      createdDirectories.add(parent);
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
      let nextPath = normalizeMarkdownPath(path);
      await queueWrite(nextPath, starterMarkdown(nextPath));
      return nextPath;
    },
    async deleteFile(path) {
      await withDropboxRetry((operator) => operator.delete(path));
    },
    async readFile(path) {
      return withDropboxRetry((operator) => operator.readText(path));
    },
    async readTree() {
      let entries = await withDropboxRetry((operator) => operator.list(""));
      return buildMarkdownTreeFromPaths(
        options.name ?? "Dropbox",
        entries.filter((entry) => entry.isFile).map((entry) => entry.path),
      );
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

function isDropboxExpiredTokenError(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  return /expired|expired_access_token|invalid_access_token/i.test(message);
}
