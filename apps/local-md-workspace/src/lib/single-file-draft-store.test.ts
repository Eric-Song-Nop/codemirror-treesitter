import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clearLastSingleFileDraft,
  createSingleFileDraft,
  deleteSingleFileDraft,
  loadLastSingleFileDraft,
  loadSingleFileDraft,
  rememberLastSingleFileDraft,
  saveSingleFileDraft,
} from "./single-file-draft-store.ts";

let indexedDB: MemoryIndexedDB;

beforeEach(() => {
  indexedDB = new MemoryIndexedDB();
  vi.stubGlobal("window", { indexedDB });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("single file draft store", () => {
  it("creates, stores, and remembers a new draft", async () => {
    let draft = await createSingleFileDraft({ now: 100 });

    expect(draft).toEqual({
      createdAt: 100,
      id: expect.any(String),
      name: "Untitled.md",
      updatedAt: 100,
      value: "",
    });
    await expect(loadSingleFileDraft(draft.id)).resolves.toEqual(draft);
    await expect(loadLastSingleFileDraft()).resolves.toEqual(draft);
  });

  it("honors provided draft fields and saves updates", async () => {
    let draft = await createSingleFileDraft({
      name: " Notes.md ",
      now: 200,
      value: "# Notes\n",
    });

    expect(draft.name).toBe("Notes.md");
    let updated = { ...draft, updatedAt: 250, value: "# Updated\n" };
    await saveSingleFileDraft(updated);

    await expect(loadSingleFileDraft(draft.id)).resolves.toEqual(updated);
    await expect(loadLastSingleFileDraft()).resolves.toEqual(updated);
  });

  it("remembers and clears the last draft conditionally", async () => {
    let first = await createSingleFileDraft({ name: "first.md", now: 1 });
    let second = await createSingleFileDraft({ name: "second.md", now: 2 });

    await clearLastSingleFileDraft(first.id);
    await expect(loadLastSingleFileDraft()).resolves.toEqual(second);

    await clearLastSingleFileDraft(second.id);
    await expect(loadLastSingleFileDraft()).resolves.toBeNull();

    await rememberLastSingleFileDraft(first.id);
    await expect(loadLastSingleFileDraft()).resolves.toEqual(first);

    await clearLastSingleFileDraft();
    await expect(loadLastSingleFileDraft()).resolves.toBeNull();
  });

  it("deletes drafts and clears matching last-draft state", async () => {
    let first = await createSingleFileDraft({ name: "first.md", now: 1 });
    let second = await createSingleFileDraft({ name: "second.md", now: 2 });

    await rememberLastSingleFileDraft(first.id);
    await deleteSingleFileDraft(second.id);

    await expect(loadSingleFileDraft(second.id)).resolves.toBeNull();
    await expect(loadLastSingleFileDraft()).resolves.toEqual(first);

    await deleteSingleFileDraft(first.id);

    await expect(loadSingleFileDraft(first.id)).resolves.toBeNull();
    await expect(loadLastSingleFileDraft()).resolves.toBeNull();
  });

  it("fails draft writes when IndexedDB is unavailable", async () => {
    vi.stubGlobal("window", {});

    let draft = {
      createdAt: 300,
      id: "offline",
      name: "offline.md",
      updatedAt: 300,
      value: "offline",
    };

    await expect(
      createSingleFileDraft({ name: "offline.md", now: 300, value: "offline" }),
    ).rejects.toThrow("Browser draft storage is unavailable");
    await expect(saveSingleFileDraft(draft)).rejects.toThrow(
      "Browser draft storage is unavailable",
    );
    await expect(loadSingleFileDraft(draft.id)).resolves.toBeNull();
    await expect(loadLastSingleFileDraft()).resolves.toBeNull();
    await expect(rememberLastSingleFileDraft(draft.id)).resolves.toBeUndefined();
    await expect(clearLastSingleFileDraft()).resolves.toBeUndefined();
    await expect(deleteSingleFileDraft(draft.id)).resolves.toBeUndefined();
  });
});

type MemoryDatabaseRecord = {
  stores: Map<string, Map<IDBValidKey, unknown>>;
  version: number;
};

type RequestHandler<T> = (this: IDBRequest<T>, event: Event) => unknown;
type TransactionHandler = (this: IDBTransaction, event: Event) => unknown;

class MemoryIndexedDB {
  private databases = new Map<string, MemoryDatabaseRecord>();

  open(name: string, version = 1) {
    let request = new MemoryOpenRequest();

    queueMicrotask(() => {
      let record = this.databases.get(name);
      if (record && version < record.version) {
        request.fail(new DOMException("Requested version is lower.", "VersionError"));
        return;
      }

      let needsUpgrade = !record || version > record.version;
      if (!record) {
        record = { stores: new Map(), version };
        this.databases.set(name, record);
      } else if (needsUpgrade) {
        record.version = version;
      }

      request.result = new MemoryDatabase(record) as unknown as IDBDatabase;
      if (needsUpgrade)
        request.onupgradeneeded?.call(
          request.asOpenRequest(),
          new Event("upgradeneeded") as IDBVersionChangeEvent,
        );
      request.succeed();
    });

    return request.asOpenRequest();
  }
}

class MemoryOpenRequest {
  error: DOMException | null = null;
  onblocked: RequestHandler<IDBDatabase> | null = null;
  onerror: RequestHandler<IDBDatabase> | null = null;
  onsuccess: RequestHandler<IDBDatabase> | null = null;
  onupgradeneeded: ((this: IDBOpenDBRequest, event: IDBVersionChangeEvent) => unknown) | null =
    null;
  result!: IDBDatabase;

  asOpenRequest() {
    return this as unknown as IDBOpenDBRequest;
  }

  fail(error: DOMException) {
    this.error = error;
    this.onerror?.call(this.asOpenRequest(), new Event("error"));
  }

  succeed() {
    this.onsuccess?.call(this.asOpenRequest(), new Event("success"));
  }
}

class MemoryRequest<T> {
  error: DOMException | null = null;
  onerror: RequestHandler<T> | null = null;
  onsuccess: RequestHandler<T> | null = null;
  result!: T;

  asRequest() {
    return this as unknown as IDBRequest<T>;
  }

  fail(error: DOMException) {
    this.error = error;
    this.onerror?.call(this.asRequest(), new Event("error"));
  }

  succeed(result: T) {
    this.result = result;
    this.onsuccess?.call(this.asRequest(), new Event("success"));
  }
}

class MemoryDatabase {
  objectStoreNames: Pick<DOMStringList, "contains">;

  constructor(private record: MemoryDatabaseRecord) {
    this.objectStoreNames = {
      contains: (name: string) => this.record.stores.has(name),
    };
  }

  close() {}

  createObjectStore(name: string) {
    if (!this.record.stores.has(name)) this.record.stores.set(name, new Map());
    return new MemoryObjectStore(this.record.stores.get(name)!, new MemoryTransaction());
  }

  transaction(storeName: string) {
    let store = this.record.stores.get(storeName);
    if (!store) throw new DOMException("Object store not found.", "NotFoundError");
    return new MemoryTransaction(store) as unknown as IDBTransaction;
  }
}

class MemoryTransaction {
  error: DOMException | null = null;
  onabort: TransactionHandler | null = null;
  oncomplete: TransactionHandler | null = null;
  onerror: TransactionHandler | null = null;
  private completed = false;
  private pending = 0;

  constructor(private store = new Map<IDBValidKey, unknown>()) {}

  objectStore() {
    return new MemoryObjectStore(this.store, this) as unknown as IDBObjectStore;
  }

  beginRequest() {
    this.pending += 1;
  }

  finishRequest() {
    this.pending -= 1;
    if (this.pending == 0 && !this.completed) {
      this.completed = true;
      queueMicrotask(() => {
        this.oncomplete?.call(this as unknown as IDBTransaction, new Event("complete"));
      });
    }
  }
}

class MemoryObjectStore {
  constructor(
    private store: Map<IDBValidKey, unknown>,
    private transaction: MemoryTransaction,
  ) {}

  delete(key: IDBValidKey) {
    return this.queueRequest<void>(() => {
      this.store.delete(key);
    });
  }

  get(key: IDBValidKey) {
    return this.queueRequest(() => cloneValue(this.store.get(key)));
  }

  put(value: unknown, key: IDBValidKey) {
    return this.queueRequest(() => {
      this.store.set(key, cloneValue(value));
      return key;
    });
  }

  private queueRequest<T>(operation: () => T) {
    let request = new MemoryRequest<T>();
    this.transaction.beginRequest();
    queueMicrotask(() => {
      try {
        request.succeed(operation());
      } catch (error) {
        request.fail(
          error instanceof DOMException
            ? error
            : new DOMException("IndexedDB request failed.", "UnknownError"),
        );
      } finally {
        this.transaction.finishRequest();
      }
    });
    return request.asRequest();
  }
}

function cloneValue<T>(value: T): T {
  return value == null ? value : structuredClone(value);
}
