const dbName = "local-md-workspace-collab";
const dbVersion = 1;
const documentStoreName = "documents";
const updateStoreName = "updates";
const updateDocIdIndexName = "docId";

export type BrowserCollabDocumentMetadata = {
  docId: string;
  materializedAt: number;
  materializedFrontiers: SerializedCollabFrontier[];
  materializedHash: string;
  materializedValue: string;
  materializedVersionVector: SerializedCollabVersionVector;
  path: string;
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

let memoryDocuments = new Map<string, StoredDocumentRecord>();
let memoryUpdates = new Map<string, StoredUpdateRecord[]>();

export async function loadBrowserCollabDocument(
  docId: string,
): Promise<BrowserCollabDocumentState> {
  let db = await openBrowserCollabDatabase();
  if (!db) return loadMemoryDocument(docId);

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
    memoryDocuments.set(metadata.docId, record);
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
    let records = memoryUpdates.get(docId) ?? [];
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
    memoryUpdates.set(docId, records);
    return browserCollabUpdateLogByteLength(docId);
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
    memoryUpdates.delete(docId);
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
    workspaceId: record.workspaceId,
  };
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

function toUint8Array(value: Uint8Array | ArrayBuffer) {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
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
