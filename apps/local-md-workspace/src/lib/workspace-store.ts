import type { AccessDirectoryHandle } from "@/lib/file-system";

const DB_NAME = "local-md-workspace";
const DB_VERSION = 1;
const STORE_NAME = "workspace";
const HANDLE_KEY = "directory-handle";

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

function canUseIndexedDb() {
  return typeof window != "undefined" && Boolean(window.indexedDB);
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
