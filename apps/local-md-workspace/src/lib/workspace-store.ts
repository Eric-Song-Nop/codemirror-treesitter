import type { AccessDirectoryHandle } from "@/lib/file-system";

const DB_NAME = "local-md-workspace";
const DB_VERSION = 1;
const STORE_NAME = "workspace";
const HANDLE_KEY = "directory-handle";
const LOCAL_WORKSPACE_RECORDS_KEY = "local-workspaces";
const DROPBOX_CONFIG_KEY = "local-md-workspace:dropbox-config";
const GOOGLE_DRIVE_CONFIG_KEY = "local-md-workspace:google-drive-config";
const ONEDRIVE_CONFIG_KEY = "local-md-workspace:onedrive-config";
const WORKSPACE_KIND_KEY = "local-md-workspace:workspace-kind";
const SELECTED_PATH_KEY_PREFIX = "local-md-workspace:selected-path";

export type StoredDropboxWorkspaceConfig = {
  appKey: string;
  root?: string;
};

export type StoredGoogleDriveWorkspaceConfig = {
  clientId: string;
  root?: string;
};

export type StoredOneDriveWorkspaceConfig = {
  clientId: string;
  root?: string;
};

export type StoredWorkspaceKind = "local" | "dropbox" | "gdrive" | "onedrive";

export type StoredWorkspaceSelectedPathContext = {
  kind: StoredWorkspaceKind;
  workspaceId: string;
};

export type StoredLocalWorkspaceRecord = {
  handle: AccessDirectoryHandle;
  id: string;
  lastOpenedAt: number;
  name: string;
};

export async function loadStoredLocalWorkspaceRecord() {
  if (!canUseIndexedDb()) return null;

  try {
    let db = await openWorkspaceDatabase();
    try {
      let records = await loadLocalWorkspaceRecordsWithLegacyMigration(db);
      return records.toSorted((left, right) => right.lastOpenedAt - left.lastOpenedAt)[0] ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function rememberStoredLocalWorkspace(
  handle: AccessDirectoryHandle,
  options: { now?: number } = {},
) {
  if (!canUseIndexedDb()) return null;

  try {
    let db = await openWorkspaceDatabase();
    try {
      let now = options.now ?? Date.now();
      let records = await loadLocalWorkspaceRecordsWithLegacyMigration(db, now);
      let existing = await findMatchingLocalWorkspaceRecord(records, handle);
      let record: StoredLocalWorkspaceRecord = {
        handle,
        id: existing?.id ?? createLocalWorkspaceRecordId(),
        lastOpenedAt: now,
        name: handle.name || "Workspace",
      };
      let nextRecords = [record, ...records.filter((candidate) => candidate.id != record.id)];

      await putValue(db, LOCAL_WORKSPACE_RECORDS_KEY, nextRecords);
      await putValue(db, HANDLE_KEY, handle);
      return record;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function loadStoredWorkspaceHandle() {
  return (await loadStoredLocalWorkspaceRecord())?.handle ?? null;
}

export async function saveStoredWorkspaceHandle(handle: AccessDirectoryHandle) {
  await rememberStoredLocalWorkspace(handle);
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

export function loadStoredGoogleDriveWorkspaceConfig() {
  if (!canUseLocalStorage()) return null;

  try {
    let raw = window.localStorage.getItem(GOOGLE_DRIVE_CONFIG_KEY);
    if (!raw) return null;
    return parseGoogleDriveWorkspaceConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveStoredGoogleDriveWorkspaceConfig(config: StoredGoogleDriveWorkspaceConfig) {
  if (!canUseLocalStorage()) return;

  let normalized = parseGoogleDriveWorkspaceConfig(config);
  if (!normalized) return;
  try {
    window.localStorage.setItem(GOOGLE_DRIVE_CONFIG_KEY, JSON.stringify(normalized));
  } catch {}
}

export function loadStoredOneDriveWorkspaceConfig() {
  if (!canUseLocalStorage()) return null;

  try {
    let raw = window.localStorage.getItem(ONEDRIVE_CONFIG_KEY);
    if (!raw) return null;
    return parseOneDriveWorkspaceConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveStoredOneDriveWorkspaceConfig(config: StoredOneDriveWorkspaceConfig) {
  if (!canUseLocalStorage()) return;

  let normalized = parseOneDriveWorkspaceConfig(config);
  if (!normalized) return;
  try {
    window.localStorage.setItem(ONEDRIVE_CONFIG_KEY, JSON.stringify(normalized));
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

export function loadStoredWorkspaceSelectedPath(context: StoredWorkspaceSelectedPathContext) {
  if (!canUseLocalStorage()) return null;

  let key = selectedPathStorageKey(context);
  if (!key) return null;

  try {
    return normalizeWorkspacePath(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function saveStoredWorkspaceSelectedPath(
  context: StoredWorkspaceSelectedPathContext,
  path: string,
) {
  if (!canUseLocalStorage()) return;

  let key = selectedPathStorageKey(context);
  let normalized = normalizeWorkspacePath(path);
  if (!key || !normalized) return;

  try {
    window.localStorage.setItem(key, normalized);
  } catch {}
}

export function clearStoredWorkspaceSelectedPath(context: StoredWorkspaceSelectedPathContext) {
  if (!canUseLocalStorage()) return;

  let key = selectedPathStorageKey(context);
  if (!key) return;

  try {
    window.localStorage.removeItem(key);
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

function parseGoogleDriveWorkspaceConfig(value: unknown): StoredGoogleDriveWorkspaceConfig | null {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  if (typeof record.clientId != "string") return null;

  let clientId = record.clientId.trim();
  if (!clientId) return null;

  let root =
    typeof record.root == "string"
      ? record.root
          .trim()
          .replace(/\\/g, "/")
          .replace(/^\/+|\/+$/g, "")
      : "";

  return root ? { clientId, root } : { clientId };
}

function parseOneDriveWorkspaceConfig(value: unknown): StoredOneDriveWorkspaceConfig | null {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  if (typeof record.clientId != "string") return null;

  let clientId = record.clientId.trim();
  if (!clientId) return null;

  let root =
    typeof record.root == "string"
      ? record.root
          .trim()
          .replace(/\\/g, "/")
          .replace(/^\/+|\/+$/g, "")
      : "";

  return root ? { clientId, root } : { clientId };
}

function parseWorkspaceKind(value: unknown): StoredWorkspaceKind | null {
  if (typeof value != "string") return null;
  if (value == "local" || value == "dropbox" || value == "gdrive" || value == "onedrive") {
    return value;
  }
  return null;
}

function selectedPathStorageKey(context: StoredWorkspaceSelectedPathContext) {
  let workspaceId = normalizeWorkspacePath(context.workspaceId);
  if (!workspaceId) return null;
  return `${SELECTED_PATH_KEY_PREFIX}:${context.kind}:${encodeURIComponent(workspaceId)}`;
}

function normalizeWorkspacePath(value: unknown) {
  if (typeof value != "string") return null;

  let path = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  return path ? path : null;
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

async function loadLocalWorkspaceRecordsWithLegacyMigration(db: IDBDatabase, now = Date.now()) {
  let records = parseLocalWorkspaceRecords(
    await getValue<unknown>(db, LOCAL_WORKSPACE_RECORDS_KEY),
  );
  if (records.length) return records;

  let legacyHandle = await getValue<unknown>(db, HANDLE_KEY);
  if (!isAccessDirectoryHandle(legacyHandle)) return records;

  let record: StoredLocalWorkspaceRecord = {
    handle: legacyHandle,
    id: createLocalWorkspaceRecordId(),
    lastOpenedAt: now,
    name: legacyHandle.name || "Workspace",
  };

  await putValue(db, LOCAL_WORKSPACE_RECORDS_KEY, [record]);
  migrateStoredWorkspaceSelectedPath(
    { kind: "local", workspaceId: legacyLocalWorkspaceId(legacyHandle) },
    { kind: "local", workspaceId: record.id },
  );
  return [record];
}

async function findMatchingLocalWorkspaceRecord(
  records: StoredLocalWorkspaceRecord[],
  handle: AccessDirectoryHandle,
) {
  for (let record of records) {
    if (await areSameDirectoryHandle(record.handle, handle)) return record;
  }
  return null;
}

async function areSameDirectoryHandle(left: AccessDirectoryHandle, right: AccessDirectoryHandle) {
  if (left === right) return true;
  if (left.isSameEntry) {
    try {
      if (await left.isSameEntry(right)) return true;
    } catch {}
  }
  if (right.isSameEntry) {
    try {
      if (await right.isSameEntry(left)) return true;
    } catch {}
  }
  return false;
}

function migrateStoredWorkspaceSelectedPath(
  from: StoredWorkspaceSelectedPathContext,
  to: StoredWorkspaceSelectedPathContext,
) {
  if (!canUseLocalStorage()) return;

  let fromKey = selectedPathStorageKey(from);
  let toKey = selectedPathStorageKey(to);
  if (!fromKey || !toKey) return;

  try {
    if (normalizeWorkspacePath(window.localStorage.getItem(toKey))) return;
    let oldPath = normalizeWorkspacePath(window.localStorage.getItem(fromKey));
    if (oldPath) window.localStorage.setItem(toKey, oldPath);
  } catch {}
}

function parseLocalWorkspaceRecords(value: unknown) {
  if (!Array.isArray(value)) return [];

  let records: StoredLocalWorkspaceRecord[] = [];
  for (let item of value) {
    if (!item || typeof item != "object") continue;
    let record = item as Record<string, unknown>;
    if (typeof record.id != "string" || !record.id.trim()) continue;
    if (!isAccessDirectoryHandle(record.handle)) continue;

    let name =
      typeof record.name == "string" && record.name.trim()
        ? record.name.trim()
        : record.handle.name || "Workspace";
    let lastOpenedAt =
      typeof record.lastOpenedAt == "number" && Number.isFinite(record.lastOpenedAt)
        ? record.lastOpenedAt
        : 0;

    records.push({
      handle: record.handle,
      id: record.id.trim(),
      lastOpenedAt,
      name,
    });
  }
  return records;
}

function isAccessDirectoryHandle(value: unknown): value is AccessDirectoryHandle {
  return (
    Boolean(value) &&
    typeof value == "object" &&
    (value as AccessDirectoryHandle).kind == "directory" &&
    typeof (value as AccessDirectoryHandle).name == "string" &&
    typeof (value as AccessDirectoryHandle).getDirectoryHandle == "function" &&
    typeof (value as AccessDirectoryHandle).getFileHandle == "function" &&
    typeof (value as AccessDirectoryHandle).values == "function"
  );
}

function createLocalWorkspaceRecordId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID == "function") {
    return `local:${globalThis.crypto.randomUUID()}`;
  }
  return `local:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function legacyLocalWorkspaceId(handle: AccessDirectoryHandle) {
  return `local:${handle.name || "workspace"}`;
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
