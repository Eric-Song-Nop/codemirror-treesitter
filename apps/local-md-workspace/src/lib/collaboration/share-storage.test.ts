// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { resetBrowserCollabMemoryStoreForTests } from "./collab-browser-store.ts";
import { openMarkdownCollabDocument } from "./markdown-document.ts";
import {
  createOwnerShare,
  hostSecretStorageKey,
  ownerShareRecordPath,
  readOwnerShareRecord,
  resetOwnerShareRecordStoreForTests,
  restoreOwnerShareRecordForPath,
  revokeOwnerShare,
  rotateOwnerShare,
} from "./share-storage.ts";
import { parseShareLink } from "./share-identity.ts";
import type {
  MarkdownDirectoryNode,
  WorkspaceBackend,
  WorkspaceEntry,
} from "@/lib/workspace-backend";

let indexedDbDescriptor: PropertyDescriptor | undefined;
let localStorageDescriptor: PropertyDescriptor | undefined;
let localStorageValues: Map<string, string>;

beforeEach(() => {
  indexedDbDescriptor = Object.getOwnPropertyDescriptor(window, "indexedDB");
  localStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  localStorageValues = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return localStorageValues.size;
      },
      clear() {
        localStorageValues.clear();
      },
      getItem(key: string) {
        return localStorageValues.get(key) ?? null;
      },
      key(index: number) {
        return [...localStorageValues.keys()][index] ?? null;
      },
      removeItem(key: string) {
        localStorageValues.delete(key);
      },
      setItem(key: string, value: string) {
        localStorageValues.set(key, value);
      },
    },
  });
  Object.defineProperty(window, "indexedDB", {
    configurable: true,
    value: undefined,
  });
  window.localStorage.clear();
  resetBrowserCollabMemoryStoreForTests();
  resetOwnerShareRecordStoreForTests();
});

afterEach(() => {
  window.localStorage.clear();
  resetBrowserCollabMemoryStoreForTests();
  resetOwnerShareRecordStoreForTests();
  if (indexedDbDescriptor) {
    Object.defineProperty(window, "indexedDB", indexedDbDescriptor);
  } else {
    Reflect.deleteProperty(window, "indexedDB");
  }
  if (localStorageDescriptor) {
    Object.defineProperty(window, "localStorage", localStorageDescriptor);
  } else {
    Reflect.deleteProperty(window, "localStorage");
  }
});

describe("owner shared file metadata", () => {
  it("creates a link and stores only hashed capabilities in browser metadata", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let hostSecrets = new Map<string, string>();
    let relayRequests: unknown[] = [];

    let share = await createOwnerShare({
      backend,
      baseUrl: "https://example.test/workspace",
      createRelayShare: async (_origin, request) => {
        relayRequests.push(request);
      },
      document,
      expiration: "7d",
      file: { kind: "file", name: "note.md", path: "note.md" },
      hostSecretStore: {
        setItem(key, value) {
          hostSecrets.set(key, value);
        },
      },
      now: Date.UTC(2026, 5, 6),
      relayOrigin: "https://relay.example",
    });

    let linkParts = parseShareLink(share.link);
    expect(linkParts).toEqual({
      guestSecret: expect.any(String),
      shareId: share.record.shareId,
    });
    expect(share.record).toMatchObject({
      backendKind: "local",
      displayName: "note.md",
      expiresAt: Date.UTC(2026, 5, 13),
      localFileId: document.docId,
      materializedHash: "420eb45a",
      path: "note.md",
      schemaVersion: 2,
      sourceRef: {
        backendKind: "local",
        path: "note.md",
        workspaceId: "memory:test",
        workspaceNamespace: "local:memory:test",
      },
      workspaceId: "local:memory:test",
    });
    expect(relayRequests).toEqual([
      {
        displayName: "note.md",
        expiresAt: Date.UTC(2026, 5, 13),
        guestSecretHash: share.record.guestSecretHash,
        hostSecretHash: share.record.hostSecretHash,
        shareId: share.record.shareId,
        snapshot: document.doc.export({ mode: "snapshot" }),
      },
    ]);

    let stored = window.localStorage.getItem(ownerShareRecordPath(share.record.shareId));
    let hostSecret = hostSecrets.get(hostSecretStorageKey(share.record.shareId));
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(linkParts!.guestSecret);
    expect(stored).not.toContain(hostSecret!);
    expect(hostSecret).toEqual(expect.any(String));
    await expect(readOwnerShareRecord(backend, share.record.shareId)).resolves.toEqual(
      share.record,
    );
  });

  it("does not write owner browser metadata when relay creation fails", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let hostSecrets = new Map<string, string>();

    await expect(
      createOwnerShare({
        backend,
        baseUrl: "https://example.test/workspace",
        createRelayShare: async () => {
          throw new Error("relay unavailable");
        },
        document,
        expiration: "7d",
        file: { kind: "file", name: "note.md", path: "note.md" },
        hostSecretStore: {
          setItem(key, value) {
            hostSecrets.set(key, value);
          },
        },
        now: Date.UTC(2026, 5, 6),
        relayOrigin: "https://relay.example",
      }),
    ).rejects.toThrow("relay unavailable");

    expect(hasLiveMdFiles(backend)).toBe(false);
    expect(window.localStorage.getItem(ownerShareRecordPath("missing-share-id"))).toBeNull();
    expect(hostSecrets.size).toBe(0);
  });

  it("creates owner-host shares for writable remote sources", async () => {
    let backend = createMemoryBackend(
      [["note.md", "# First\n"]],
      "opendal-gdrive",
      "gdrive:workspace-1",
    );
    let document = await openMarkdownCollabDocument(backend, "note.md");

    let share = await createOwnerShare({
      backend,
      baseUrl: "https://example.test/workspace",
      createRelayShare: async () => {},
      document,
      expiration: "7d",
      file: { kind: "file", name: "note.md", path: "note.md" },
      hostSecretStore: { setItem() {} },
      now: Date.UTC(2026, 5, 6),
      relayOrigin: "https://relay.example",
    });

    expect(share.record).toMatchObject({
      backendKind: "opendal-gdrive",
      path: "note.md",
      sourceRef: {
        backendKind: "opendal-gdrive",
        path: "note.md",
        workspaceId: "gdrive:workspace-1",
        workspaceNamespace: "opendal-gdrive:gdrive:workspace-1",
      },
      workspaceId: "opendal-gdrive:gdrive:workspace-1",
    });
    await expect(restoreOwnerShareRecordForPath(backend, "note.md")).resolves.toEqual(share.record);
  });

  it("rejects owner-host shares for sources without the share capability", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]], "opendal-s3", "s3:workspace-1");
    let document = await openMarkdownCollabDocument(backend, "note.md");

    await expect(
      createOwnerShare({
        backend,
        baseUrl: "https://example.test/workspace",
        createRelayShare: async () => {},
        document,
        expiration: "7d",
        file: { kind: "file", name: "note.md", path: "note.md" },
        hostSecretStore: { setItem() {} },
        now: Date.UTC(2026, 5, 6),
        relayOrigin: "https://relay.example",
      }),
    ).rejects.toThrow("This workspace cannot host shared files.");
  });

  it("rotates the guest capability while keeping the same share id", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let hostSecrets = new Map<string, string>();
    let share = await createOwnerShare({
      backend,
      baseUrl: "https://example.test/workspace",
      createRelayShare: async () => {},
      document,
      expiration: "7d",
      file: { kind: "file", name: "note.md", path: "note.md" },
      hostSecretStore: {
        setItem(key, value) {
          hostSecrets.set(key, value);
        },
      },
      now: Date.UTC(2026, 5, 6),
      relayOrigin: "https://relay.example",
    });
    let originalLink = parseShareLink(share.link)!;
    let hostSecret = hostSecrets.get(hostSecretStorageKey(share.record.shareId))!;
    let rotateRequests: unknown[] = [];

    let rotated = await rotateOwnerShare({
      backend,
      baseUrl: "https://example.test/workspace",
      expiration: "24h",
      hostSecret,
      now: Date.UTC(2026, 5, 7),
      record: share.record,
      relayOrigin: "https://relay.example",
      rotateRelayShare: async (_origin, shareId, request) => {
        rotateRequests.push({ request, shareId });
        return { expiresAt: request.expiresAt, shareId };
      },
    });

    let rotatedLink = parseShareLink(rotated.link)!;
    expect(rotatedLink.shareId).toBe(originalLink.shareId);
    expect(rotatedLink.guestSecret).not.toBe(originalLink.guestSecret);
    expect(rotated.record.shareId).toBe(share.record.shareId);
    expect(rotated.record.guestSecretHash).not.toBe(share.record.guestSecretHash);
    expect(rotated.record.expiresAt).toBe(Date.UTC(2026, 5, 8));
    expect(rotateRequests).toEqual([
      {
        request: {
          expiresAt: Date.UTC(2026, 5, 8),
          hostSecret,
          nextGuestSecretHash: rotated.record.guestSecretHash,
        },
        shareId: share.record.shareId,
      },
    ]);

    let stored = window.localStorage.getItem(ownerShareRecordPath(share.record.shareId));
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(rotatedLink.guestSecret);
    await expect(readOwnerShareRecord(backend, share.record.shareId)).resolves.toEqual(
      rotated.record,
    );
  });

  it("marks owner share metadata revoked after stopping sharing", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let share = await createOwnerShare({
      backend,
      baseUrl: "https://example.test/workspace",
      createRelayShare: async () => {},
      document,
      expiration: "7d",
      file: { kind: "file", name: "note.md", path: "note.md" },
      hostSecretStore: { setItem() {} },
      now: Date.UTC(2026, 5, 6),
      relayOrigin: "https://relay.example",
    });

    let revoked = await revokeOwnerShare({
      backend,
      hostSecret: "host-secret",
      record: share.record,
      relayOrigin: "https://relay.example",
      revokeRelayShare: async (_origin, shareId, hostSecret) => {
        expect(hostSecret).toBe("host-secret");
        return { revokedAt: Date.UTC(2026, 5, 7), shareId };
      },
    });

    expect(revoked).toEqual({
      ...share.record,
      revokedAt: Date.UTC(2026, 5, 7),
    });
    await expect(readOwnerShareRecord(backend, share.record.shareId)).resolves.toEqual(revoked);
  });

  it("discovers the latest active owner share for a file", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let first = await createOwnerShare({
      backend,
      baseUrl: "https://example.test/workspace",
      createRelayShare: async () => {},
      document,
      expiration: "7d",
      file: { kind: "file", name: "note.md", path: "note.md" },
      hostSecretStore: { setItem() {} },
      now: Date.UTC(2026, 5, 6),
      relayOrigin: "https://relay.example",
    });
    let second = await createOwnerShare({
      backend,
      baseUrl: "https://example.test/workspace",
      createRelayShare: async () => {},
      document,
      expiration: "7d",
      file: { kind: "file", name: "note.md", path: "note.md" },
      hostSecretStore: { setItem() {} },
      now: Date.UTC(2026, 5, 7),
      relayOrigin: "https://relay.example",
    });
    await revokeOwnerShare({
      backend,
      hostSecret: "host-secret",
      record: first.record,
      relayOrigin: "https://relay.example",
      revokeRelayShare: async (_origin, shareId) => ({
        revokedAt: Date.UTC(2026, 5, 8),
        shareId,
      }),
    });
    window.localStorage.setItem("local-md-workspace:share-record:corrupt", "{");

    await expect(restoreOwnerShareRecordForPath(backend, "note.md")).resolves.toEqual(
      second.record,
    );
  });

  it("normalizes legacy owner share metadata without source refs", async () => {
    let backend = createMemoryBackend(
      [["note.md", "# First\n"]],
      "opendal-dropbox",
      "dropbox:/workspace",
    );
    let legacyRecord = {
      backendKind: "opendal-dropbox",
      createdAt: Date.UTC(2026, 5, 6),
      displayName: "note.md",
      expiresAt: Date.UTC(2026, 5, 13),
      guestSecretHash: "guest-hash",
      hostSecretHash: "host-hash",
      hostSecretRef: hostSecretStorageKey("legacy-share-id"),
      localFileId: "doc-legacy",
      materializedHash: "420eb45a",
      path: "note.md",
      schemaVersion: 2,
      shareId: "legacy-share-id",
      workspaceId: "opendal-dropbox:dropbox:/workspace",
    };
    window.localStorage.setItem(
      ownerShareRecordPath(legacyRecord.shareId),
      JSON.stringify(legacyRecord),
    );

    await expect(readOwnerShareRecord(backend, legacyRecord.shareId)).resolves.toMatchObject({
      ...legacyRecord,
      sourceRef: {
        backendKind: "opendal-dropbox",
        path: "note.md",
        workspaceId: "dropbox:/workspace",
        workspaceNamespace: "opendal-dropbox:dropbox:/workspace",
      },
    });
    await expect(restoreOwnerShareRecordForPath(backend, "note.md")).resolves.toMatchObject({
      shareId: legacyRecord.shareId,
      sourceRef: {
        workspaceNamespace: "opendal-dropbox:dropbox:/workspace",
      },
    });
  });

  it("migrates owner share metadata from explicit local source aliases", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]], "local", "local:workspace-2", [
      {
        kind: "local",
        namespace: "local:local:Notes",
        workspaceId: "local:Notes",
      },
    ]);
    let legacyRecord = {
      backendKind: "local",
      createdAt: Date.UTC(2026, 5, 6),
      displayName: "note.md",
      expiresAt: Date.UTC(2026, 5, 13),
      guestSecretHash: "guest-hash",
      hostSecretHash: "host-hash",
      hostSecretRef: hostSecretStorageKey("legacy-local-share-id"),
      localFileId: "doc-legacy",
      materializedHash: "420eb45a",
      path: "note.md",
      schemaVersion: 2,
      shareId: "legacy-local-share-id",
      sourceRef: {
        backendKind: "local",
        path: "note.md",
        workspaceId: "local:Notes",
        workspaceNamespace: "local:local:Notes",
      },
      workspaceId: "local:local:Notes",
    };
    window.localStorage.setItem(
      ownerShareRecordPath(legacyRecord.shareId),
      JSON.stringify(legacyRecord),
    );

    let restored = await restoreOwnerShareRecordForPath(backend, "note.md");

    expect(restored).toMatchObject({
      backendKind: "local",
      path: "note.md",
      shareId: legacyRecord.shareId,
      sourceRef: {
        backendKind: "local",
        path: "note.md",
        workspaceId: "local:workspace-2",
        workspaceNamespace: "local:local:workspace-2",
      },
      workspaceId: "local:local:workspace-2",
    });
    await expect(readOwnerShareRecord(backend, legacyRecord.shareId)).resolves.toMatchObject({
      sourceRef: {
        workspaceId: "local:workspace-2",
        workspaceNamespace: "local:local:workspace-2",
      },
      workspaceId: "local:local:workspace-2",
    });
  });

  it("migrates legacy local owner share metadata without source refs through aliases", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]], "local", "local:workspace-2", [
      {
        kind: "local",
        namespace: "local:local:Notes",
        workspaceId: "local:Notes",
      },
    ]);
    let legacyRecord = {
      backendKind: "local",
      createdAt: Date.UTC(2026, 5, 6),
      displayName: "note.md",
      expiresAt: Date.UTC(2026, 5, 13),
      guestSecretHash: "guest-hash",
      hostSecretHash: "host-hash",
      hostSecretRef: hostSecretStorageKey("legacy-local-share-id"),
      localFileId: "doc-legacy",
      materializedHash: "420eb45a",
      path: "note.md",
      schemaVersion: 2,
      shareId: "legacy-local-share-id",
      workspaceId: "local:local:Notes",
    };
    window.localStorage.setItem(
      ownerShareRecordPath(legacyRecord.shareId),
      JSON.stringify(legacyRecord),
    );

    let restored = await restoreOwnerShareRecordForPath(backend, "note.md");

    expect(restored).toMatchObject({
      shareId: legacyRecord.shareId,
      sourceRef: {
        workspaceId: "local:workspace-2",
        workspaceNamespace: "local:local:workspace-2",
      },
      workspaceId: "local:local:workspace-2",
    });
  });
});

type MemoryBackend = WorkspaceBackend & {
  files: Map<string, string>;
};

function createMemoryBackend(
  entries: Array<[string, string]>,
  kind: WorkspaceBackend["kind"] = "local",
  id = "memory:test",
  sourceAliases: WorkspaceBackend["sourceAliases"] = [],
): MemoryBackend {
  let files = new Map(entries);

  return {
    files,
    id,
    kind,
    name: "Memory",
    sourceAliases,
    async createDirectory() {},
    async createFile(path) {
      files.set(path, "");
      return path;
    },
    async deleteFile(path) {
      files.delete(path);
    },
    async deleteEntry(path) {
      files.delete(path);
    },
    async listEntries(path) {
      let prefix = path ? `${path}/` : "";
      let entries: WorkspaceEntry[] = [];
      for (let filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        entries.push({ isDirectory: false, isFile: true, path: filePath });
      }
      return entries;
    },
    async readBytes(path) {
      let value = files.get(path);
      if (value == null) throw new DOMException("File not found.", "NotFoundError");
      return decodeBase64(value);
    },
    async readFile(path) {
      let value = files.get(path);
      if (value == null) throw new DOMException("File not found.", "NotFoundError");
      return value;
    },
    async readTextFile(path) {
      let value = files.get(path);
      if (value == null) throw new DOMException("File not found.", "NotFoundError");
      return value;
    },
    async readTree(): Promise<MarkdownDirectoryNode> {
      return { children: [], kind: "directory", name: "Memory", path: "" };
    },
    async renameFile(from, to) {
      let value = files.get(from);
      if (value == null) throw new DOMException("File not found.", "NotFoundError");
      files.delete(from);
      files.set(to, value);
      return to;
    },
    async writeBytes(path, bytes) {
      files.set(path, encodeBase64(bytes));
    },
    async writeFile(path, value) {
      files.set(path, value);
    },
    async writeTextFile(path, value) {
      files.set(path, value);
    },
  };
}

function hasLiveMdFiles(backend: MemoryBackend) {
  return [...backend.files.keys()].some((path) => path == ".livemd" || path.startsWith(".livemd/"));
}

function decodeBase64(value: string) {
  let binary = atob(value);
  let bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array) {
  let chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}
