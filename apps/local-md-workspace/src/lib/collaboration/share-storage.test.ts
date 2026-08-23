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
import type { WorkspaceStorageKind } from "@/lib/workspace/storage/types";
import type { WorkspaceIdentity } from "@/lib/workspace/runtime/types";
import {
  createMemoryWorkspaceRuntime,
  type MemoryWorkspaceRuntime,
} from "@/test/memory-workspace-runtime";

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
      identity: backend.identity,
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
    await expect(readOwnerShareRecord(backend.identity, share.record.shareId)).resolves.toEqual(
      share.record,
    );
  });

  it("retains owner management credentials when the relay creation outcome is unknown", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let hostSecrets = new Map<string, string>();

    await expect(
      createOwnerShare({
        identity: backend.identity,
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
    expect(hostSecrets.size).toBe(1);
    let [hostSecretKey] = hostSecrets.keys();
    let shareId = hostSecretKey!.slice(hostSecretStorageKey("").length);
    await expect(readOwnerShareRecord(backend.identity, shareId)).resolves.toMatchObject({
      hostSecretRef: hostSecretKey,
      shareId,
    });
  });

  it("persists owner management credentials before creating the remote share", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let relayCalled = false;

    await expect(
      createOwnerShare({
        identity: backend.identity,
        baseUrl: "https://example.test/workspace",
        createRelayShare: async () => {
          relayCalled = true;
        },
        document,
        expiration: "7d",
        file: { kind: "file", name: "note.md", path: "note.md" },
        hostSecretStore: {
          setItem() {
            throw new Error("quota exceeded");
          },
        },
        now: Date.UTC(2026, 5, 6),
        relayOrigin: "https://relay.example",
      }),
    ).rejects.toThrow("Browser storage is required to host a shared file.");

    expect(relayCalled).toBe(false);
  });

  it("creates owner-host shares for writable remote sources", async () => {
    let backend = createMemoryBackend(
      [["note.md", "# First\n"]],
      "opendal-gdrive",
      "gdrive:workspace-1",
    );
    let document = await openMarkdownCollabDocument(backend, "note.md");

    let share = await createOwnerShare({
      identity: backend.identity,
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
    await expect(restoreOwnerShareRecordForPath(backend.identity, "note.md")).resolves.toEqual(
      share.record,
    );
  });

  it("rejects owner-host shares for sources without the share capability", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]], "opendal-s3", "s3:workspace-1");
    let document = await openMarkdownCollabDocument(backend, "note.md");

    await expect(
      createOwnerShare({
        identity: backend.identity,
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
      identity: backend.identity,
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
      identity: backend.identity,
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
    await expect(readOwnerShareRecord(backend.identity, share.record.shareId)).resolves.toEqual(
      rotated.record,
    );
  });

  it("marks owner share metadata revoked after stopping sharing", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let share = await createOwnerShare({
      identity: backend.identity,
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
      identity: backend.identity,
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
    await expect(readOwnerShareRecord(backend.identity, share.record.shareId)).resolves.toEqual(
      revoked,
    );
  });

  it("discovers the latest active owner share for a file", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let first = await createOwnerShare({
      identity: backend.identity,
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
      identity: backend.identity,
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
      identity: backend.identity,
      hostSecret: "host-secret",
      record: first.record,
      relayOrigin: "https://relay.example",
      revokeRelayShare: async (_origin, shareId) => ({
        revokedAt: Date.UTC(2026, 5, 8),
        shareId,
      }),
    });
    window.localStorage.setItem("local-md-workspace:share-record:corrupt", "{");

    await expect(restoreOwnerShareRecordForPath(backend.identity, "note.md")).resolves.toEqual(
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

    await expect(
      readOwnerShareRecord(backend.identity, legacyRecord.shareId),
    ).resolves.toMatchObject({
      ...legacyRecord,
      sourceRef: {
        backendKind: "opendal-dropbox",
        path: "note.md",
        workspaceId: "dropbox:/workspace",
        workspaceNamespace: "opendal-dropbox:dropbox:/workspace",
      },
    });
    await expect(
      restoreOwnerShareRecordForPath(backend.identity, "note.md"),
    ).resolves.toMatchObject({
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

    let restored = await restoreOwnerShareRecordForPath(backend.identity, "note.md");

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
    await expect(
      readOwnerShareRecord(backend.identity, legacyRecord.shareId),
    ).resolves.toMatchObject({
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

    let restored = await restoreOwnerShareRecordForPath(backend.identity, "note.md");

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

type MemoryBackend = MemoryWorkspaceRuntime;

function createMemoryBackend(
  entries: Array<[string, string]>,
  kind: WorkspaceStorageKind = "local",
  id = "memory:test",
  sourceAliases: WorkspaceIdentity["sourceAliases"] = [],
): MemoryBackend {
  return createMemoryWorkspaceRuntime(entries, { id, kind, sourceAliases });
}

function hasLiveMdFiles(backend: MemoryBackend) {
  return [...backend.files.keys()].some((path) => path == ".livemd" || path.startsWith(".livemd/"));
}
