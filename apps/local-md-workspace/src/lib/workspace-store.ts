import type { AccessDirectoryHandle } from "@/lib/file-system";

const DB_NAME = "local-md-workspace";
const DB_VERSION = 1;
const STORE_NAME = "workspace";
const HANDLE_KEY = "directory-handle";
const DROPBOX_CONFIG_KEY = "local-md-workspace:dropbox-config";
const WORKSPACE_KIND_KEY = "local-md-workspace:workspace-kind";

export type StoredDropboxWorkspaceConfig = {
  appKey: string;
  root?: string;
};

export type StoredWorkspaceKind = "local" | "dropbox";

export async function loadStoredWorkspaceHandle() {
  if (!canUseIndexedDb()) return null;

  try {
    let db = await openWorkspaceDatabase();
    try {
      return await getValue<AccessDirectoryHandle>(db, HANDLE_KEY);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function saveStoredWorkspaceHandle(handle: AccessDirectoryHandle) {
  if (!canUseIndexedDb()) return;

  let db = await openWorkspaceDatabase();
  try {
    await putValue(db, HANDLE_KEY, handle);
  } finally {
    db.close();
  }
}

export function loadStoredDropboxWorkspaceConfig() {
  if (!canUseLocalStorage()) return null;

  try {
    let raw = window.localStorage.getItem(DROPBOX_CONFIG_KEY);
    if (!raw) return null;
    return parseDropboxWorkspaceConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveStoredDropboxWorkspaceConfig(config: StoredDropboxWorkspaceConfig) {
  if (!canUseLocalStorage()) return;

  let normalized = parseDropboxWorkspaceConfig(config);
  if (!normalized) return;
  try {
    window.localStorage.setItem(DROPBOX_CONFIG_KEY, JSON.stringify(normalized));
  } catch {}
}

export function loadStoredWorkspaceKind() {
  if (!canUseLocalStorage()) return null;

  try {
    return parseWorkspaceKind(window.localStorage.getItem(WORKSPACE_KIND_KEY));
  } catch {
    return null;
  }
}

export function saveStoredWorkspaceKind(kind: StoredWorkspaceKind) {
  if (!canUseLocalStorage()) return;

  try {
    window.localStorage.setItem(WORKSPACE_KIND_KEY, kind);
  } catch {}
}

function canUseIndexedDb() {
  return typeof window != "undefined" && Boolean(window.indexedDB);
}

function canUseLocalStorage() {
  return typeof window != "undefined" && Boolean(window.localStorage);
}

function parseDropboxWorkspaceConfig(value: unknown): StoredDropboxWorkspaceConfig | null {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  if (typeof record.appKey != "string") return null;

  let appKey = record.appKey.trim();
  if (!appKey) return null;

  let root =
    typeof record.root == "string"
      ? record.root
          .trim()
          .replace(/\\/g, "/")
          .replace(/^\/+|\/+$/g, "")
      : "";

  return root ? { appKey, root } : { appKey };
}

function parseWorkspaceKind(value: unknown): StoredWorkspaceKind | null {
  if (typeof value != "string") return null;
  if (value == "local" || value == "dropbox") return value;
  return null;
}

function openWorkspaceDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      let db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked."));
  });
}

async function getValue<T>(db: IDBDatabase, key: IDBValidKey) {
  let transaction = db.transaction(STORE_NAME, "readonly");
  let done = transactionComplete(transaction);
  let request = transaction.objectStore(STORE_NAME).get(key);
  let [result] = await Promise.all([requestResult<T | undefined>(request), done]);
  return result ?? null;
}

async function putValue<T>(db: IDBDatabase, key: IDBValidKey, value: T) {
  let transaction = db.transaction(STORE_NAME, "readwrite");
  let done = transactionComplete(transaction);
  let request = transaction.objectStore(STORE_NAME).put(value, key);
  await Promise.all([requestResult(request), done]);
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}
