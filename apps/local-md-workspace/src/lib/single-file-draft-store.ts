const DB_NAME = "local-md-workspace";
const DB_VERSION = 1;
const STORE_NAME = "workspace";
const DRAFT_KEY_PREFIX = "single-file-draft:";
const LAST_DRAFT_KEY = "single-file-draft:last";

export type SingleFileDraft = {
  id: string;
  name: string;
  value: string;
  createdAt: number;
  updatedAt: number;
};

export async function createSingleFileDraft(
  input: { name?: string; value?: string; now?: number } = {},
): Promise<SingleFileDraft> {
  let now = input.now ?? Date.now();
  let draft: SingleFileDraft = {
    createdAt: now,
    id: createDraftId(),
    name: input.name?.trim() || "Untitled.md",
    updatedAt: now,
    value: input.value ?? "",
  };

  await saveSingleFileDraft(draft);
  await rememberLastSingleFileDraft(draft.id);
  return draft;
}

export async function loadSingleFileDraft(id: string): Promise<SingleFileDraft | null> {
  if (!id || !canUseIndexedDb()) return null;

  try {
    let db = await openSingleFileDraftDatabase();
    try {
      return parseSingleFileDraft(await getValue(db, draftKey(id)));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function loadLastSingleFileDraft(): Promise<SingleFileDraft | null> {
  if (!canUseIndexedDb()) return null;

  try {
    let db = await openSingleFileDraftDatabase();
    try {
      let id = await getValue<string>(db, LAST_DRAFT_KEY);
      return typeof id == "string" ? await loadSingleFileDraft(id) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function saveSingleFileDraft(draft: SingleFileDraft): Promise<void> {
  if (!canUseIndexedDb()) {
    throw new Error("Browser draft storage is unavailable. Save the file to persistent storage.");
  }

  let db = await openSingleFileDraftDatabase();
  try {
    await putValue(db, draftKey(draft.id), { ...draft });
  } finally {
    db.close();
  }
}

export async function deleteSingleFileDraft(id: string): Promise<void> {
  if (!id || !canUseIndexedDb()) return;

  let db = await openSingleFileDraftDatabase();
  try {
    await deleteValue(db, draftKey(id));
    let lastId = await getValue<string>(db, LAST_DRAFT_KEY);
    if (lastId == id) await deleteValue(db, LAST_DRAFT_KEY);
  } finally {
    db.close();
  }
}

export async function rememberLastSingleFileDraft(id: string): Promise<void> {
  if (!id || !canUseIndexedDb()) return;

  let db = await openSingleFileDraftDatabase();
  try {
    await putValue(db, LAST_DRAFT_KEY, id);
  } finally {
    db.close();
  }
}

export async function clearLastSingleFileDraft(id?: string): Promise<void> {
  if (!canUseIndexedDb()) return;

  let db = await openSingleFileDraftDatabase();
  try {
    if (id) {
      let lastId = await getValue<string>(db, LAST_DRAFT_KEY);
      if (lastId != id) return;
    }
    await deleteValue(db, LAST_DRAFT_KEY);
  } finally {
    db.close();
  }
}

function canUseIndexedDb() {
  return typeof window != "undefined" && Boolean(window.indexedDB);
}

function createDraftId() {
  return typeof globalThis.crypto?.randomUUID == "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function draftKey(id: string) {
  return `${DRAFT_KEY_PREFIX}${id}`;
}

function parseSingleFileDraft(value: unknown): SingleFileDraft | null {
  if (!value || typeof value != "object") return null;
  let record = value as Partial<SingleFileDraft>;
  if (
    typeof record.id != "string" ||
    typeof record.name != "string" ||
    typeof record.value != "string" ||
    typeof record.createdAt != "number" ||
    typeof record.updatedAt != "number" ||
    !Number.isFinite(record.createdAt) ||
    !Number.isFinite(record.updatedAt)
  ) {
    return null;
  }

  return {
    createdAt: record.createdAt,
    id: record.id,
    name: record.name,
    updatedAt: record.updatedAt,
    value: record.value,
  };
}

function openSingleFileDraftDatabase() {
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

async function deleteValue(db: IDBDatabase, key: IDBValidKey) {
  let transaction = db.transaction(STORE_NAME, "readwrite");
  let done = transactionComplete(transaction);
  let request = transaction.objectStore(STORE_NAME).delete(key);
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
