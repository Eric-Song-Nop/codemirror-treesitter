import type { SourceRevision } from "../storage/types.ts";

const dbName = "local-md-workspace-collab";
const dbVersion = 1;
const documentStoreName = "documents";
const updateStoreName = "updates";
const updateDocIdIndexName = "docId";
const localDocumentStoragePrefix = "local-md-workspace:collab-document:";
const localUpdatesStoragePrefix = "local-md-workspace:collab-updates:";

export type BrowserCollabDocumentMetadata = {
  docId: string;
  materializedAt: number;
  materializedFrontiers: SerializedCollabFrontier[];
  materializedHash: string;
  materializedValue: string;
  materializedVersionVector: SerializedCollabVersionVector;
  path: string;
  sourceContentHash?: string;
  sourceRevision?: SourceRevision;
  workspaceId: string;
};

export type SerializedCollabFrontier = {
  counter: number;
  peer: `${number}`;
};

export type SerializedCollabVersionVector = Array<[`${number}`, number]>;

export type BrowserCollabDocumentState = {
  metadata: BrowserCollabDocumentMetadata | null;
  snapshot: Uint8Array | null;
  updates: Uint8Array[];
};

type StoredDocumentRecord = Partial<BrowserCollabDocumentMetadata> & {
  snapshot?: Uint8Array | ArrayBuffer;
};

type StoredUpdateRecord = {
  docId: string;
  key: string;
  sequence: number;
  update: Uint8Array;
};

type SerializedDocumentRecord = Partial<BrowserCollabDocumentMetadata> & {
  snapshot?: string;
};

type SerializedUpdateRecord = Omit<StoredUpdateRecord, "update"> & {
  update: string;
};

let memoryDocuments = new Map<string, StoredDocumentRecord>();
let memoryUpdates = new Map<string, StoredUpdateRecord[]>();

export async function loadBrowserCollabDocument(
  docId: string,
): Promise<BrowserCollabDocumentState> {
  let db = await openBrowserCollabDatabase();
  if (!db) return loadFallbackDocument(docId);

  try {
    let transaction = db.transaction([documentStoreName, updateStoreName], "readonly");
    let documentStore = transaction.objectStore(documentStoreName);
    let updateStore = transaction.objectStore(updateStoreName);
    let updateIndex = updateStore.index(updateDocIdIndexName);
    let done = transactionComplete(transaction);
    let [record, updates] = await Promise.all([
      requestResult<StoredDocumentRecord | undefined>(documentStore.get(docId)),
      requestResult<StoredUpdateRecord[]>(updateIndex.getAll(docId)),
      done,
    ]);

    let metadata = record ? metadataFromRecord(record) : null;
    if (!metadata) return emptyBrowserCollabDocumentState();

    return {
      metadata,
      snapshot: record?.snapshot ? toUint8Array(record.snapshot) : null,
      updates: updates
        .sort((left, right) => left.sequence - right.sequence)
        .map((update) => toUint8Array(update.update)),
    };
  } finally {
    db.close();
  }
}

export async function writeBrowserCollabSnapshot(
  metadata: BrowserCollabDocumentMetadata,
  snapshot: Uint8Array,
) {
  let record: StoredDocumentRecord = {
    ...metadata,
    snapshot: new Uint8Array(snapshot),
  };
  let db = await openBrowserCollabDatabase();
  if (!db) {
    writeFallbackDocument(metadata.docId, record);
    return;
  }

  try {
    let transaction = db.transaction(documentStoreName, "readwrite");
    let done = transactionComplete(transaction);
    await Promise.all([
      requestResult(transaction.objectStore(documentStoreName).put(record, metadata.docId)),
      done,
    ]);
  } finally {
    db.close();
  }
}

export async function appendBrowserCollabUpdates(docId: string, updates: Uint8Array[]) {
  if (!updates.length) return browserCollabUpdateLogByteLength(docId);

  let db = await openBrowserCollabDatabase();
  if (!db) {
    let records = loadFallbackUpdates(docId);
    let sequence = records.reduce((max, record) => Math.max(max, record.sequence), 0);
    for (let update of updates) {
      sequence += 1;
      records.push({
        docId,
        key: updateKey(docId, sequence),
        sequence,
        update: new Uint8Array(update),
      });
    }
    writeFallbackUpdates(docId, records);
    return records.reduce((total, record) => total + record.update.byteLength, 0);
  }

  try {
    let transaction = db.transaction(updateStoreName, "readwrite");
    let updateStore = transaction.objectStore(updateStoreName);
    let updateIndex = updateStore.index(updateDocIdIndexName);
    let done = transactionComplete(transaction);
    let existing = await requestResult<StoredUpdateRecord[]>(updateIndex.getAll(docId));
    let sequence = existing.reduce((max, record) => Math.max(max, record.sequence), 0);
    await Promise.all(
      updates.map((update) => {
        sequence += 1;
        let record: StoredUpdateRecord = {
          docId,
          key: updateKey(docId, sequence),
          sequence,
          update: new Uint8Array(update),
        };
        return requestResult(updateStore.put(record));
      }),
    );
    await done;
    return (
      existing.reduce((total, record) => total + record.update.byteLength, 0) +
      updates.reduce((total, update) => total + update.byteLength, 0)
    );
  } finally {
    db.close();
  }
}

export async function clearBrowserCollabUpdates(docId: string) {
  let db = await openBrowserCollabDatabase();
  if (!db) {
    clearFallbackUpdates(docId);
    return;
  }

  try {
    let transaction = db.transaction(updateStoreName, "readwrite");
    let updateStore = transaction.objectStore(updateStoreName);
    let updateIndex = updateStore.index(updateDocIdIndexName);
    let done = transactionComplete(transaction);
    let records = await requestResult<StoredUpdateRecord[]>(updateIndex.getAll(docId));
    await Promise.all(records.map((record) => requestResult(updateStore.delete(record.key))));
    await done;
  } finally {
    db.close();
  }
}

export async function browserCollabUpdateLogByteLength(docId: string) {
  let state = await loadBrowserCollabDocument(docId);
  return state.updates.reduce((total, update) => total + update.byteLength, 0);
}

export function resetBrowserCollabMemoryStoreForTests() {
  memoryDocuments = new Map();
  memoryUpdates = new Map();
}

function openBrowserCollabDatabase() {
  if (typeof window == "undefined" || !window.indexedDB) return Promise.resolve(null);

  return new Promise<IDBDatabase | null>((resolve, reject) => {
    let request = window.indexedDB.open(dbName, dbVersion);

    request.onupgradeneeded = () => {
      let db = request.result;
      if (!db.objectStoreNames.contains(documentStoreName)) {
        db.createObjectStore(documentStoreName);
      }
      if (!db.objectStoreNames.contains(updateStoreName)) {
        let updates = db.createObjectStore(updateStoreName, { keyPath: "key" });
        updates.createIndex(updateDocIdIndexName, "docId", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked."));
  }).catch(() => null);
}

function metadataFromRecord(record: StoredDocumentRecord): BrowserCollabDocumentMetadata | null {
  if (
    typeof record.docId != "string" ||
    typeof record.materializedAt != "number" ||
    !isSerializedFrontiers(record.materializedFrontiers) ||
    typeof record.materializedHash != "string" ||
    typeof record.materializedValue != "string" ||
    !isSerializedVersionVector(record.materializedVersionVector) ||
    typeof record.path != "string" ||
    typeof record.workspaceId != "string"
  ) {
    return null;
  }

  return {
    docId: record.docId,
    materializedAt: record.materializedAt,
    materializedFrontiers: record.materializedFrontiers,
    materializedHash: record.materializedHash,
    materializedValue: record.materializedValue,
    materializedVersionVector: record.materializedVersionVector,
    path: record.path,
    sourceContentHash:
      typeof record.sourceContentHash == "string" ? record.sourceContentHash : undefined,
    sourceRevision: isSourceRevision(record.sourceRevision) ? record.sourceRevision : undefined,
    workspaceId: record.workspaceId,
  };
}

function isSourceRevision(value: unknown): value is SourceRevision {
  if (!value || typeof value != "object") return false;
  let revision = value as Partial<SourceRevision>;
  return (
    typeof revision.value == "string" &&
    ((revision.kind == "etag" || revision.kind == "version") && revision.validation == "atomic"
      ? true
      : revision.kind == "fingerprint" && revision.validation == "observed")
  );
}

function isSerializedFrontiers(value: unknown): value is SerializedCollabFrontier[] {
  return (
    Array.isArray(value) &&
    value.every(
      (frontier) =>
        frontier &&
        typeof frontier == "object" &&
        typeof (frontier as Partial<SerializedCollabFrontier>).peer == "string" &&
        /^\d+$/.test((frontier as Partial<SerializedCollabFrontier>).peer ?? "") &&
        typeof (frontier as Partial<SerializedCollabFrontier>).counter == "number" &&
        Number.isSafeInteger((frontier as Partial<SerializedCollabFrontier>).counter) &&
        (frontier as Partial<SerializedCollabFrontier>).counter! >= 0,
    )
  );
}

function isSerializedVersionVector(value: unknown): value is SerializedCollabVersionVector {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length == 2 &&
        typeof entry[0] == "string" &&
        /^\d+$/.test(entry[0]) &&
        typeof entry[1] == "number" &&
        Number.isSafeInteger(entry[1]) &&
        entry[1] >= 0,
    )
  );
}

function loadMemoryDocument(docId: string): BrowserCollabDocumentState {
  let record = memoryDocuments.get(docId) ?? null;
  let metadata = record ? metadataFromRecord(record) : null;
  if (!metadata) return emptyBrowserCollabDocumentState();

  let updates = memoryUpdates.get(docId) ?? [];
  return {
    metadata,
    snapshot: record?.snapshot ? new Uint8Array(record.snapshot) : null,
    updates: updates
      .sort((left, right) => left.sequence - right.sequence)
      .map((update) => new Uint8Array(update.update)),
  };
}

function loadFallbackDocument(docId: string) {
  return loadLocalStorageDocument(docId) ?? loadMemoryDocument(docId);
}

function writeFallbackDocument(docId: string, record: StoredDocumentRecord) {
  if (writeLocalStorageDocument(docId, record)) return;
  memoryDocuments.set(docId, record);
}

function loadFallbackUpdates(docId: string) {
  return loadLocalStorageUpdates(docId) ?? [...(memoryUpdates.get(docId) ?? [])];
}

function writeFallbackUpdates(docId: string, records: StoredUpdateRecord[]) {
  if (writeLocalStorageUpdates(docId, records)) return;
  memoryUpdates.set(docId, records);
}

function clearFallbackUpdates(docId: string) {
  if (clearLocalStorageUpdates(docId)) return;
  memoryUpdates.delete(docId);
}

function loadLocalStorageDocument(docId: string): BrowserCollabDocumentState | null {
  let storage = browserLocalStorage();
  if (!storage) return null;

  try {
    let rawRecord = storage.getItem(localDocumentStorageKey(docId));
    if (!rawRecord) return emptyBrowserCollabDocumentState();

    let record = deserializeDocumentRecord(JSON.parse(rawRecord));
    let metadata = metadataFromRecord(record);
    if (!metadata) return emptyBrowserCollabDocumentState();

    let updates = loadLocalStorageUpdates(docId) ?? [];
    return {
      metadata,
      snapshot: record.snapshot ? new Uint8Array(record.snapshot) : null,
      updates: updates
        .sort((left, right) => left.sequence - right.sequence)
        .map((update) => new Uint8Array(update.update)),
    };
  } catch {
    return null;
  }
}

function writeLocalStorageDocument(docId: string, record: StoredDocumentRecord) {
  let storage = browserLocalStorage();
  if (!storage) return false;

  try {
    storage.setItem(
      localDocumentStorageKey(docId),
      JSON.stringify(serializeDocumentRecord(record)),
    );
    return true;
  } catch {
    return false;
  }
}

function loadLocalStorageUpdates(docId: string) {
  let storage = browserLocalStorage();
  if (!storage) return null;

  try {
    let raw = storage.getItem(localUpdatesStorageKey(docId));
    if (!raw) return [];
    let value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): StoredUpdateRecord[] => {
      let record = item as Partial<SerializedUpdateRecord>;
      if (
        typeof record.docId != "string" ||
        typeof record.key != "string" ||
        typeof record.sequence != "number" ||
        !Number.isSafeInteger(record.sequence) ||
        record.sequence < 0 ||
        typeof record.update != "string"
      ) {
        return [];
      }
      return [
        {
          docId: record.docId,
          key: record.key,
          sequence: record.sequence,
          update: bytesFromBase64(record.update),
        },
      ];
    });
  } catch {
    return null;
  }
}

function writeLocalStorageUpdates(docId: string, records: StoredUpdateRecord[]) {
  let storage = browserLocalStorage();
  if (!storage) return false;

  try {
    storage.setItem(
      localUpdatesStorageKey(docId),
      JSON.stringify(records.map(serializeUpdateRecord)),
    );
    return true;
  } catch {
    return false;
  }
}

function clearLocalStorageUpdates(docId: string) {
  let storage = browserLocalStorage();
  if (!storage) return false;

  try {
    storage.removeItem(localUpdatesStorageKey(docId));
    return true;
  } catch {
    return false;
  }
}

function serializeDocumentRecord(record: StoredDocumentRecord): SerializedDocumentRecord {
  let { snapshot, ...metadata } = record;
  return {
    ...metadata,
    ...(snapshot ? { snapshot: base64FromBytes(toUint8Array(snapshot)) } : {}),
  };
}

function deserializeDocumentRecord(value: unknown): StoredDocumentRecord {
  let record = value && typeof value == "object" ? (value as SerializedDocumentRecord) : {};
  let { snapshot, ...metadata } = record;
  return {
    ...metadata,
    ...(typeof snapshot == "string" ? { snapshot: bytesFromBase64(snapshot) } : {}),
  };
}

function serializeUpdateRecord(record: StoredUpdateRecord): SerializedUpdateRecord {
  return {
    docId: record.docId,
    key: record.key,
    sequence: record.sequence,
    update: base64FromBytes(record.update),
  };
}

function emptyBrowserCollabDocumentState(): BrowserCollabDocumentState {
  return {
    metadata: null,
    snapshot: null,
    updates: [],
  };
}

function updateKey(docId: string, sequence: number) {
  return `${docId}:${String(sequence).padStart(12, "0")}`;
}

function localDocumentStorageKey(docId: string) {
  return `${localDocumentStoragePrefix}${docId}`;
}

function localUpdatesStorageKey(docId: string) {
  return `${localUpdatesStoragePrefix}${docId}`;
}

function toUint8Array(value: Uint8Array | ArrayBuffer) {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

function browserLocalStorage() {
  try {
    return typeof window != "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function base64FromBytes(bytes: Uint8Array) {
  let binary = "";
  for (let byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesFromBase64(value: string) {
  let binary = atob(value);
  let bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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
