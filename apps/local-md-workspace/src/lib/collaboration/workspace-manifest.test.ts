// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import {
  ensureManifestFile,
  loadWorkspaceManifest,
  mergeWorkspaceManifestSnapshot,
  readWorkspaceManifestSnapshotBytes,
  repairWorkspaceCollaborationMetadata,
  tombstoneManifestFile,
} from "./workspace-manifest.ts";
import type { MarkdownDirectoryNode, WorkspaceBackend } from "@/lib/workspace-backend";

describe("workspace collaboration manifest", () => {
  it("merges concurrent manifest snapshots instead of replacing local records", async () => {
    let first = createMemoryBackend();
    let second = createMemoryBackend();

    await ensureManifestFile(first, "first.md");
    await ensureManifestFile(second, "second.md");

    let secondSnapshot = await readWorkspaceManifestSnapshotBytes(second);
    expect(secondSnapshot).toBeInstanceOf(Uint8Array);

    await mergeWorkspaceManifestSnapshot(first, secondSnapshot!);

    await expect(loadWorkspaceManifest(first)).resolves.toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({ path: "first.md" }),
        expect.objectContaining({ path: "second.md" }),
      ]),
    });
  });

  it("assigns a conflict path when merged live records target the same path", async () => {
    let first = createMemoryBackend();
    let second = createMemoryBackend();

    let firstRecord = await ensureManifestFile(first, "note.md");
    let secondRecord = await ensureManifestFile(second, "note.md");
    let secondSnapshot = await readWorkspaceManifestSnapshotBytes(second);

    await mergeWorkspaceManifestSnapshot(first, secondSnapshot!);

    let manifest = await loadWorkspaceManifest(first);
    expect(manifest.records.map((record) => record.docId).sort()).toEqual(
      [firstRecord.record.docId, secondRecord.record.docId].sort(),
    );
    expect(manifest.records.map((record) => record.path).sort()).toEqual(
      expect.arrayContaining(["note.md", expect.stringMatching(/^note\.path-conflict-.+\.md$/)]),
    );
  });

  it("repairs orphan tmp metadata without removing recent tombstones", async () => {
    let backend = createMemoryBackend();
    let { record } = await ensureManifestFile(backend, "note.md");

    backend.files.set(".livemd/tmp/tx/doc.snapshot.b64", "AQID");
    await tombstoneManifestFile(backend, "note.md");

    await expect(repairWorkspaceCollaborationMetadata(backend)).resolves.toEqual({
      removedTmp: true,
      removedTombstones: 0,
    });

    expect(backend.files.has(".livemd/tmp/tx/doc.snapshot.b64")).toBe(false);
    await expect(loadWorkspaceManifest(backend)).resolves.toMatchObject({
      records: [expect.objectContaining({ deletedAt: expect.any(Number), docId: record.docId })],
    });
  });
});

type MemoryBackend = WorkspaceBackend & {
  files: Map<string, string>;
};

function createMemoryBackend(): MemoryBackend {
  let files = new Map<string, string>();

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
    async deleteEntry(path, options) {
      if (options?.recursive) {
        for (let filePath of files.keys()) {
          if (filePath == path || filePath.startsWith(`${path}/`)) files.delete(filePath);
        }
        return;
      }
      files.delete(path);
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
