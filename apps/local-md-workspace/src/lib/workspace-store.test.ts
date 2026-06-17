import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AccessDirectoryHandle } from "./file-system.ts";
import {
  clearStoredWorkspaceSelectedPath,
  loadStoredDropboxWorkspaceConfig,
  loadStoredGoogleDriveWorkspaceConfig,
  loadStoredLocalWorkspaceRecord,
  loadStoredOneDriveWorkspaceConfig,
  loadStoredWorkspaceSelectedPath,
  loadStoredWorkspaceKind,
  rememberStoredLocalWorkspace,
  saveStoredDropboxWorkspaceConfig,
  saveStoredGoogleDriveWorkspaceConfig,
  saveStoredOneDriveWorkspaceConfig,
  saveStoredWorkspaceSelectedPath,
  saveStoredWorkspaceKind,
} from "./workspace-store.ts";

const DB_NAME = "local-md-workspace";
const STORE_NAME = "workspace";
const HANDLE_KEY = "directory-handle";
const DROPBOX_CONFIG_KEY = "local-md-workspace:dropbox-config";
const GOOGLE_DRIVE_CONFIG_KEY = "local-md-workspace:google-drive-config";
const ONEDRIVE_CONFIG_KEY = "local-md-workspace:onedrive-config";
const WORKSPACE_KIND_KEY = "local-md-workspace:workspace-kind";
const SELECTED_PATH_KEY_PREFIX = "local-md-workspace:selected-path";

describe("Dropbox workspace config storage", () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
        removeItem: vi.fn((key: string) => values.delete(key)),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves and restores normalized non-secret Dropbox config", () => {
    saveStoredDropboxWorkspaceConfig({
      appKey: " test-app-key ",
      root: " \\notes\\daily/ ",
    });

    expect(values.get(DROPBOX_CONFIG_KEY)).toBe(
      JSON.stringify({
        appKey: "test-app-key",
        root: "notes/daily",
      }),
    );
    expect(loadStoredDropboxWorkspaceConfig()).toEqual({
      appKey: "test-app-key",
      root: "notes/daily",
    });
  });

  it("ignores malformed or empty stored Dropbox config", () => {
    values.set(DROPBOX_CONFIG_KEY, JSON.stringify({ appKey: " " }));
    expect(loadStoredDropboxWorkspaceConfig()).toBeNull();

    values.set(DROPBOX_CONFIG_KEY, "{");
    expect(loadStoredDropboxWorkspaceConfig()).toBeNull();
  });

  it("does not persist invalid Dropbox app keys", () => {
    saveStoredDropboxWorkspaceConfig({ appKey: " " });

    expect(values.has(DROPBOX_CONFIG_KEY)).toBe(false);
  });

  it("saves Google Drive config without a root and drops legacy roots", () => {
    saveStoredGoogleDriveWorkspaceConfig({
      clientId: " test-client-id ",
    });

    expect(values.get(GOOGLE_DRIVE_CONFIG_KEY)).toBe(
      JSON.stringify({
        clientId: "test-client-id",
      }),
    );
    expect(loadStoredGoogleDriveWorkspaceConfig()).toEqual({
      clientId: "test-client-id",
    });

    values.set(
      GOOGLE_DRIVE_CONFIG_KEY,
      JSON.stringify({
        clientId: " legacy-client-id ",
        root: "legacy/root",
      }),
    );
    expect(loadStoredGoogleDriveWorkspaceConfig()).toEqual({
      clientId: "legacy-client-id",
    });
  });

  it("ignores malformed or empty stored Google Drive config", () => {
    values.set(GOOGLE_DRIVE_CONFIG_KEY, JSON.stringify({ clientId: " " }));
    expect(loadStoredGoogleDriveWorkspaceConfig()).toBeNull();

    values.set(GOOGLE_DRIVE_CONFIG_KEY, "{");
    expect(loadStoredGoogleDriveWorkspaceConfig()).toBeNull();
  });

  it("does not persist invalid Google Drive client IDs", () => {
    saveStoredGoogleDriveWorkspaceConfig({ clientId: " " });

    expect(values.has(GOOGLE_DRIVE_CONFIG_KEY)).toBe(false);
  });

  it("saves and restores normalized non-secret OneDrive config", () => {
    saveStoredOneDriveWorkspaceConfig({
      clientId: " test-client-id ",
      root: " \\notes\\daily/ ",
    });

    expect(values.get(ONEDRIVE_CONFIG_KEY)).toBe(
      JSON.stringify({
        clientId: "test-client-id",
        root: "notes/daily",
      }),
    );
    expect(loadStoredOneDriveWorkspaceConfig()).toEqual({
      clientId: "test-client-id",
      root: "notes/daily",
    });
  });

  it("ignores malformed or empty stored OneDrive config", () => {
    values.set(ONEDRIVE_CONFIG_KEY, JSON.stringify({ clientId: " " }));
    expect(loadStoredOneDriveWorkspaceConfig()).toBeNull();

    values.set(ONEDRIVE_CONFIG_KEY, "{");
    expect(loadStoredOneDriveWorkspaceConfig()).toBeNull();
  });

  it("does not persist invalid OneDrive client IDs", () => {
    saveStoredOneDriveWorkspaceConfig({ clientId: " " });

    expect(values.has(ONEDRIVE_CONFIG_KEY)).toBe(false);
  });

  it("saves and restores the last workspace kind", () => {
    saveStoredWorkspaceKind("dropbox");
    expect(values.get(WORKSPACE_KIND_KEY)).toBe("dropbox");
    expect(loadStoredWorkspaceKind()).toBe("dropbox");

    saveStoredWorkspaceKind("local");
    expect(values.get(WORKSPACE_KIND_KEY)).toBe("local");
    expect(loadStoredWorkspaceKind()).toBe("local");

    saveStoredWorkspaceKind("gdrive");
    expect(values.get(WORKSPACE_KIND_KEY)).toBe("gdrive");
    expect(loadStoredWorkspaceKind()).toBe("gdrive");

    saveStoredWorkspaceKind("onedrive");
    expect(values.get(WORKSPACE_KIND_KEY)).toBe("onedrive");
    expect(loadStoredWorkspaceKind()).toBe("onedrive");
  });

  it("ignores unknown stored workspace kinds", () => {
    values.set(WORKSPACE_KIND_KEY, "other");

    expect(loadStoredWorkspaceKind()).toBeNull();
  });
});

describe("workspace selected path storage", () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
        removeItem: vi.fn((key: string) => values.delete(key)),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("isolates selected paths between local and cloud workspace contexts", () => {
    let localContext = { kind: "local" as const, workspaceId: "/Users/test/notes" };
    let dropboxContext = { kind: "dropbox" as const, workspaceId: "/Users/test/notes" };
    let googleDriveContext = { kind: "gdrive" as const, workspaceId: "/Users/test/notes" };
    let oneDriveContext = { kind: "onedrive" as const, workspaceId: "/Users/test/notes" };

    saveStoredWorkspaceSelectedPath(localContext, "local.md");
    saveStoredWorkspaceSelectedPath(dropboxContext, "dropbox.md");
    saveStoredWorkspaceSelectedPath(googleDriveContext, "google-drive.md");
    saveStoredWorkspaceSelectedPath(oneDriveContext, "onedrive.md");

    expect(loadStoredWorkspaceSelectedPath(localContext)).toBe("local.md");
    expect(loadStoredWorkspaceSelectedPath(dropboxContext)).toBe("dropbox.md");
    expect(loadStoredWorkspaceSelectedPath(googleDriveContext)).toBe("google-drive.md");
    expect(loadStoredWorkspaceSelectedPath(oneDriveContext)).toBe("onedrive.md");
  });

  it("isolates selected paths between workspace ids within the same kind", () => {
    let firstContext = { kind: "dropbox" as const, workspaceId: "team-a" };
    let secondContext = { kind: "dropbox" as const, workspaceId: "team-b" };

    saveStoredWorkspaceSelectedPath(firstContext, "daily.md");
    saveStoredWorkspaceSelectedPath(secondContext, "weekly.md");

    expect(loadStoredWorkspaceSelectedPath(firstContext)).toBe("daily.md");
    expect(loadStoredWorkspaceSelectedPath(secondContext)).toBe("weekly.md");
  });

  it("normalizes selected paths before saving and loading", () => {
    let context = { kind: "local" as const, workspaceId: "notes" };

    saveStoredWorkspaceSelectedPath(context, " \\daily\\today.md ");

    expect(loadStoredWorkspaceSelectedPath(context)).toBe("daily/today.md");

    saveStoredWorkspaceSelectedPath(context, " /nested\\note.txt ");

    expect(loadStoredWorkspaceSelectedPath(context)).toBe("nested/note.txt");
  });

  it("does not save empty selected paths", () => {
    let context = { kind: "local" as const, workspaceId: "notes" };

    saveStoredWorkspaceSelectedPath(context, " / ");

    expect(values.size).toBe(0);
    expect(loadStoredWorkspaceSelectedPath(context)).toBeNull();
  });

  it("returns null for invalid stored selected paths", () => {
    let context = { kind: "dropbox" as const, workspaceId: "team" };

    saveStoredWorkspaceSelectedPath(context, "readme.md");
    let [key] = values.keys();
    values.set(key, " / ");

    expect(loadStoredWorkspaceSelectedPath(context)).toBeNull();
  });

  it("ignores localStorage failures for selected paths", () => {
    let context = { kind: "local" as const, workspaceId: "notes" };
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error("unavailable");
        }),
        setItem: vi.fn(() => {
          throw new Error("full");
        }),
        removeItem: vi.fn(() => {
          throw new Error("unavailable");
        }),
      },
    });

    expect(loadStoredWorkspaceSelectedPath(context)).toBeNull();
    expect(() => saveStoredWorkspaceSelectedPath(context, "readme.md")).not.toThrow();
    expect(() => clearStoredWorkspaceSelectedPath(context)).not.toThrow();
  });

  it("clears stored selected paths", () => {
    let context = { kind: "local" as const, workspaceId: "notes" };

    saveStoredWorkspaceSelectedPath(context, "readme.md");
    clearStoredWorkspaceSelectedPath(context);

    expect(loadStoredWorkspaceSelectedPath(context)).toBeNull();
  });
});

describe("local workspace record storage", () => {
  let indexedDB: MemoryIndexedDB;
  let values: Map<string, string>;
  let uuidIndex: number;

  beforeEach(() => {
    indexedDB = new MemoryIndexedDB();
    values = new Map();
    uuidIndex = 0;
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => `workspace-${++uuidIndex}`),
    });
    vi.stubGlobal("window", {
      indexedDB,
      localStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
        removeItem: vi.fn((key: string) => values.delete(key)),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores stable local workspace ids without using the folder name as namespace", async () => {
    let first = new MemoryDirectoryHandle("Notes");
    let second = new MemoryDirectoryHandle("Notes");

    let firstRecord = await rememberStoredLocalWorkspace(first, { now: 100 });
    let secondRecord = await rememberStoredLocalWorkspace(second, { now: 200 });

    expect(firstRecord).toMatchObject({
      id: "local:workspace-1",
      name: "Notes",
    });
    expect(secondRecord).toMatchObject({
      id: "local:workspace-2",
      name: "Notes",
    });
    expect(firstRecord?.id).not.toBe("local:Notes");
    expect(secondRecord?.id).not.toBe(firstRecord?.id);
    await expect(loadStoredLocalWorkspaceRecord()).resolves.toMatchObject({
      id: "local:workspace-2",
    });

    let reopenedFirstRecord = await rememberStoredLocalWorkspace(first, { now: 300 });

    expect(reopenedFirstRecord?.id).toBe(firstRecord?.id);
    await expect(loadStoredLocalWorkspaceRecord()).resolves.toMatchObject({
      id: "local:workspace-1",
      lastOpenedAt: 300,
    });
  });

  it("migrates the legacy stored directory handle and selected path to a generated id", async () => {
    let legacyHandle = new MemoryDirectoryHandle("Notes");
    indexedDB.seed(DB_NAME, STORE_NAME, HANDLE_KEY, legacyHandle);
    values.set(selectedPathKey("local", "local:Notes"), "today.md");

    let record = await loadStoredLocalWorkspaceRecord();

    expect(record).toMatchObject({
      id: "local:workspace-1",
      name: "Notes",
    });
    expect(record?.id).not.toBe("local:Notes");
    expect(
      loadStoredWorkspaceSelectedPath({
        kind: "local",
        workspaceId: record!.id,
      }),
    ).toBe("today.md");
  });
});

function selectedPathKey(kind: "local" | "dropbox" | "gdrive" | "onedrive", workspaceId: string) {
  return `${SELECTED_PATH_KEY_PREFIX}:${kind}:${encodeURIComponent(workspaceId)}`;
}

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

  seed(dbName: string, storeName: string, key: IDBValidKey, value: unknown) {
    let database = this.databases.get(dbName);
    if (!database) {
      database = { stores: new Map(), version: 1 };
      this.databases.set(dbName, database);
    }
    let store = database.stores.get(storeName);
    if (!store) {
      store = new Map();
      database.stores.set(storeName, store);
    }
    store.set(key, value);
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

class MemoryDatabase {
  objectStoreNames: DOMStringList;

  constructor(private record: MemoryDatabaseRecord) {
    this.objectStoreNames = {
      contains: (name: string) => this.record.stores.has(name),
    } as DOMStringList;
  }

  close() {}

  createObjectStore(name: string) {
    let store = new Map<IDBValidKey, unknown>();
    this.record.stores.set(name, store);
    return new MemoryObjectStore(store, null) as unknown as IDBObjectStore;
  }

  transaction(name: string) {
    let store = this.record.stores.get(name);
    if (!store) throw new DOMException("Object store not found.", "NotFoundError");
    return new MemoryTransaction(store) as unknown as IDBTransaction;
  }
}

class MemoryTransaction {
  error: DOMException | null = null;
  onabort: TransactionHandler | null = null;
  oncomplete: TransactionHandler | null = null;
  onerror: TransactionHandler | null = null;

  constructor(private store = new Map<IDBValidKey, unknown>()) {}

  objectStore() {
    return new MemoryObjectStore(this.store, this) as unknown as IDBObjectStore;
  }

  complete() {
    queueMicrotask(() => {
      this.oncomplete?.call(this as unknown as IDBTransaction, new Event("complete"));
    });
  }
}

class MemoryObjectStore {
  constructor(
    private store: Map<IDBValidKey, unknown>,
    private transaction: MemoryTransaction | null,
  ) {}

  get(key: IDBValidKey) {
    let request = new MemoryRequest<unknown>();
    queueMicrotask(() => {
      request.result = this.store.get(key);
      request.succeed();
      this.transaction?.complete();
    });
    return request.asRequest();
  }

  put(value: unknown, key: IDBValidKey) {
    let request = new MemoryRequest<IDBValidKey>();
    queueMicrotask(() => {
      this.store.set(key, value);
      request.result = key;
      request.succeed();
      this.transaction?.complete();
    });
    return request.asRequest();
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

  succeed() {
    this.onsuccess?.call(this.asRequest(), new Event("success"));
  }
}

class MemoryDirectoryHandle implements AccessDirectoryHandle {
  kind = "directory" as const;
  private identity = Symbol("directory");

  constructor(public name: string) {}

  async getDirectoryHandle(name: string) {
    return new MemoryDirectoryHandle(name);
  }

  async getFileHandle(): Promise<never> {
    throw new DOMException("File not found.", "NotFoundError");
  }

  async isSameEntry(other: unknown) {
    return other instanceof MemoryDirectoryHandle && other.identity == this.identity;
  }

  async removeEntry() {}

  async *values() {}
}
