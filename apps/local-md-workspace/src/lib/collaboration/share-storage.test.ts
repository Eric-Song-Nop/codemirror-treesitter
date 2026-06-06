// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import { openMarkdownCollabDocument } from "./markdown-document.ts";
import {
  createOwnerShare,
  findOwnerShareRecordForPath,
  hostSecretStorageKey,
  ownerShareRecordPath,
  readOwnerShareRecord,
  revokeOwnerShare,
  rotateOwnerShare,
} from "./share-storage.ts";
import { parseShareLink } from "./share-identity.ts";
import type {
  MarkdownDirectoryNode,
  WorkspaceBackend,
  WorkspaceEntry,
} from "@/lib/workspace-backend";

describe("owner shared file metadata", () => {
  it("creates a link and stores only hashed capabilities in workspace sidecar", async () => {
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
      schemaVersion: 1,
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

    let stored = backend.files.get(ownerShareRecordPath(share.record.shareId));
    let hostSecret = hostSecrets.get(hostSecretStorageKey(share.record.shareId));
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(linkParts!.guestSecret);
    expect(stored).not.toContain(hostSecret!);
    expect(hostSecret).toEqual(expect.any(String));
    await expect(readOwnerShareRecord(backend, share.record.shareId)).resolves.toEqual(
      share.record,
    );
  });

  it("does not write owner sidecar metadata when relay creation fails", async () => {
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

    expect([...backend.files.keys()].some((path) => path.startsWith(".livemd/shares/"))).toBe(
      false,
    );
    expect(hostSecrets.size).toBe(0);
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

    let stored = backend.files.get(ownerShareRecordPath(share.record.shareId));
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
    backend.files.set(".livemd/shares/corrupt.json", "{");

    await expect(findOwnerShareRecordForPath(backend, "note.md")).resolves.toEqual(second.record);
  });
});

type MemoryBackend = WorkspaceBackend & {
  files: Map<string, string>;
};

function createMemoryBackend(entries: Array<[string, string]>): MemoryBackend {
  let files = new Map(entries);

  return {
    files,
    id: "memory:test",
    kind: "local",
    name: "Memory",
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
