// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import {
  detectCollabMaterializationConflict,
  getCollabDocumentValue,
  hashMarkdownText,
  keepSourceAndWriteSharedConflictCopy,
  materializeCollabDocument,
  openMarkdownCollabDocument,
  saveCollabDocumentSnapshot,
  savePendingCollabDocumentUpdates,
} from "./markdown-document.ts";
import {
  gcWorkspaceTombstones,
  loadWorkspaceManifest,
  renameManifestFilePath,
  tombstoneManifestFile,
} from "./workspace-manifest.ts";
import type {
  MarkdownDirectoryNode,
  WorkspaceBackend,
  WorkspaceEntry,
} from "@/lib/workspace-backend";

describe("Markdown collaboration documents", () => {
  it("imports external Markdown edits when Loro has no unmaterialized changes", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);

    let first = await openMarkdownCollabDocument(backend, "note.md");
    expect(first.value).toBe("# First\n");
    let firstManifest = await loadWorkspaceManifest(backend);
    expect(firstManifest.records).toMatchObject([{ docId: first.docId, path: "note.md" }]);
    expect(backend.files.has(".livemd/workspace.snapshot.b64")).toBe(true);
    expect([...backend.files.keys()].some((path) => path.startsWith(".livemd/docs/"))).toBe(true);

    backend.files.set("note.md", "# External edit\n");
    let second = await openMarkdownCollabDocument(backend, "note.md");

    expect(second.docId).toBe(first.docId);
    expect(second.value).toBe("# External edit\n");
    expect(second.externalEdit).toEqual({ kind: "imported", path: "note.md" });
  });

  it("can defer external Markdown reconciliation for shared host reconnects", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let first = await openMarkdownCollabDocument(backend, "note.md");

    backend.files.set("note.md", "# External edit\n");
    let reopened = await openMarkdownCollabDocument(backend, "note.md", {
      reconcileExternalEdits: false,
    });

    expect(reopened.docId).toBe(first.docId);
    expect(reopened.value).toBe("# First\n");
    expect(reopened.externalEdit).toBeUndefined();

    let text = reopened.doc.getText("markdown");
    text.delete(0, text.toString().length);
    text.insert(0, "# Shared edit\n");
    reopened.doc.commit();

    let conflict = await detectCollabMaterializationConflict(backend, reopened);

    expect(conflict).toMatchObject({
      kind: "external-source-conflict",
      path: "note.md",
    });
    expect(conflict?.externalHash).toBe(hashMarkdownText("# External edit\n"));
    expect(conflict?.sharedHash).toBe(hashMarkdownText("# Shared edit\n"));
    expect(backend.files.get("note.md")).toBe("# External edit\n");
  });

  it("materializes Loro text after saving the sidecar snapshot", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.delete(0, text.toString().length);
    text.insert(0, "# Updated\n");
    document.doc.commit();

    await materializeCollabDocument(backend, document);

    expect(getCollabDocumentValue(document)).toBe("# Updated\n");
    expect(backend.files.get("note.md")).toBe("# Updated\n");
    expect(document.cleanValue).toBe("# Updated\n");

    let manifest = await loadWorkspaceManifest(backend);
    expect(manifest.records[0]).toMatchObject({
      docId: document.docId,
      materializedHash: "997e77f1",
      path: "note.md",
    });
    expect(manifest.records[0]?.materializedAt).toEqual(expect.any(Number));
  });

  it("restores from a snapshot plus incremental update log", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.insert(text.toString().length, "\nUpdate log edit.\n");
    document.doc.commit();
    await savePendingCollabDocumentUpdates(backend, document);

    expect(backend.files.has(updateSegmentPath(document.docId, 1))).toBe(true);

    let reopened = await openMarkdownCollabDocument(backend, "note.md");

    expect(reopened.value).toBe("# First\n\nUpdate log edit.\n");
    expect(reopened.docId).toBe(document.docId);
  });

  it("does not reseed when an existing manifest record is missing its sidecar", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");

    backend.files.delete(`.livemd/docs/${document.docId}.snapshot.b64`);

    await expect(openMarkdownCollabDocument(backend, "note.md")).rejects.toThrow(
      "Collaboration state for note.md is not available yet",
    );
  });

  it("serializes concurrent update-log saves for the same document", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");
    let originalWriteBytes = backend.writeBytes.bind(backend);
    let firstUpdateWriteStarted = deferred<void>();
    let releaseFirstUpdateWrite = deferred<void>();
    let updateWrites = 0;

    backend.writeBytes = async (path, bytes) => {
      if (path.endsWith(".update.b64")) {
        updateWrites += 1;
        if (updateWrites == 1) {
          firstUpdateWriteStarted.resolve();
          await releaseFirstUpdateWrite.promise;
        }
      }
      await originalWriteBytes(path, bytes);
    };

    text.insert(text.toString().length, "\nFirst pending edit.\n");
    document.doc.commit();
    let firstSave = savePendingCollabDocumentUpdates(backend, document);
    await firstUpdateWriteStarted.promise;

    text.insert(text.toString().length, "\nSecond pending edit.\n");
    document.doc.commit();
    let secondSave = savePendingCollabDocumentUpdates(backend, document);

    releaseFirstUpdateWrite.resolve();
    await Promise.all([firstSave, secondSave]);

    let reopened = await openMarkdownCollabDocument(backend, "note.md");
    expect(reopened.value).toBe("# First\n\nFirst pending edit.\n\nSecond pending edit.\n");
  });

  it("compacts pending updates into the snapshot during materialization", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.insert(text.toString().length, "\nPending edit.\n");
    document.doc.commit();
    await savePendingCollabDocumentUpdates(backend, document);
    expect(backend.files.has(updateSegmentPath(document.docId, 1))).toBe(true);

    await materializeCollabDocument(backend, document);

    expect(hasUpdateSegments(backend, document.docId)).toBe(false);
    expect(backend.files.get("note.md")).toBe("# First\n\nPending edit.\n");
  });

  it("compacts large update logs after update persistence", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");
    let largeEdit = `\n${"x".repeat(70 * 1024)}\n`;

    text.insert(text.toString().length, largeEdit);
    document.doc.commit();
    await savePendingCollabDocumentUpdates(backend, document);

    expect(hasUpdateSegments(backend, document.docId)).toBe(false);
    let reopened = await openMarkdownCollabDocument(backend, "note.md");
    expect(reopened.value).toBe(`# First\n${largeEdit}`);
  });

  it("migrates legacy monolithic update logs into a compacted snapshot", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.insert(text.toString().length, "\nLegacy edit.\n");
    document.doc.commit();
    backend.files.set(
      legacyUpdateLogPath(document.docId),
      encodeBase64(encodeUpdateLogForTest(document.pendingUpdates.splice(0))),
    );

    let reopened = await openMarkdownCollabDocument(backend, "note.md");

    expect(reopened.value).toBe("# First\n\nLegacy edit.\n");
    expect(backend.files.has(legacyUpdateLogPath(document.docId))).toBe(false);
    expect(hasUpdateSegments(backend, document.docId)).toBe(false);
  });

  it("keeps pending updates when writing the update log fails", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");
    let originalWriteBytes = backend.writeBytes;

    text.insert(text.toString().length, "\nPending edit.\n");
    document.doc.commit();
    backend.writeBytes = async () => {
      throw new Error("write failed");
    };

    await expect(savePendingCollabDocumentUpdates(backend, document)).rejects.toThrow(
      "write failed",
    );

    backend.writeBytes = originalWriteBytes;
    await expect(savePendingCollabDocumentUpdates(backend, document)).resolves.toBeUndefined();

    let reopened = await openMarkdownCollabDocument(backend, "note.md");
    expect(reopened.value).toBe("# First\n\nPending edit.\n");
  });

  it("copies external Markdown edits aside when Loro also has unmaterialized changes", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.delete(0, text.toString().length);
    text.insert(0, "# Local edit\n");
    document.doc.commit();
    await saveCollabDocumentSnapshot(backend, document);
    backend.files.set("note.md", "# External edit\n");

    let reopened = await openMarkdownCollabDocument(backend, "note.md");

    expect(reopened.value).toBe("# Local edit\n");
    expect(reopened.externalEdit).toMatchObject({
      kind: "conflict-copy",
      sourcePath: "note.md",
    });
    expect(reopened.externalEdit?.path).toMatch(/^note\.external-conflict-\d{14}\.md$/);
    expect(backend.files.get(reopened.externalEdit!.path)).toBe("# External edit\n");
    expect(backend.files.get("note.md")).toBe("# External edit\n");
  });

  it("preserves external Markdown edits before materializing local Loro changes", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    backend.files.set("note.md", "# External edit\n");
    text.delete(0, text.toString().length);
    text.insert(0, "# Local edit\n");
    document.doc.commit();

    let result = await materializeCollabDocument(backend, document);

    expect(result.externalEdit).toMatchObject({
      kind: "conflict-copy",
      sourcePath: "note.md",
    });
    expect(backend.files.get(result.externalEdit!.path)).toBe("# External edit\n");
    expect(backend.files.get("note.md")).toBe("# Local edit\n");
  });

  it("detects materialization conflicts without writing either version", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    backend.files.set("note.md", "# External edit\n");
    text.delete(0, text.toString().length);
    text.insert(0, "# Shared edit\n");
    document.doc.commit();

    let conflict = await detectCollabMaterializationConflict(backend, document);

    expect(conflict).toMatchObject({
      kind: "external-source-conflict",
      path: "note.md",
    });
    expect(conflict?.externalHash).toBe(hashMarkdownText("# External edit\n"));
    expect(conflict?.sharedHash).toBe(hashMarkdownText("# Shared edit\n"));
    expect(backend.files.get("note.md")).toBe("# External edit\n");
    expect([...backend.files.keys()]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/conflict-\d{14}\.md$/)]),
    );
  });

  it("can keep the external source and write shared edits to a conflict copy", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    backend.files.set("note.md", "# External edit\n");
    text.delete(0, text.toString().length);
    text.insert(0, "# Shared edit\n");
    document.doc.commit();

    let result = await keepSourceAndWriteSharedConflictCopy(backend, document);

    expect(result.externalEdit).toMatchObject({
      kind: "shared-conflict-copy",
      sourcePath: "note.md",
    });
    expect(result.externalEdit.path).toMatch(/^note\.shared-conflict-\d{14}\.md$/);
    expect(result.sourceValue).toBe("# External edit\n");
    expect(backend.files.get("note.md")).toBe("# External edit\n");
    expect(backend.files.get(result.externalEdit.path)).toBe("# Shared edit\n");
    expect(getCollabDocumentValue(document)).toBe("# External edit\n");

    let manifest = await loadWorkspaceManifest(backend);
    expect(manifest.records[0]?.materializedHash).toBe(hashMarkdownText("# External edit\n"));
  });

  it("can accept shared edits and overwrite an externally changed source", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    backend.files.set("note.md", "# External edit\n");
    text.delete(0, text.toString().length);
    text.insert(0, "# Shared edit\n");
    document.doc.commit();

    let result = await materializeCollabDocument(backend, document, {
      conflictStrategy: "overwrite-source",
    });

    expect(result.externalEdit).toBeUndefined();
    expect(backend.files.get("note.md")).toBe("# Shared edit\n");
    expect([...backend.files.keys()]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/external-conflict-\d{14}\.md$/)]),
    );
  });

  it("keeps document identity stable across manifest renames and tombstones", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");

    await renameManifestFilePath(backend, "note.md", "renamed.md");
    let renamed = await loadWorkspaceManifest(backend);

    expect(renamed.records).toMatchObject([{ docId: document.docId, path: "renamed.md" }]);

    await tombstoneManifestFile(backend, "renamed.md");
    let deleted = await loadWorkspaceManifest(backend);

    expect(deleted.records).toMatchObject([
      {
        deletedAt: expect.any(Number),
        docId: document.docId,
        path: "renamed.md",
      },
    ]);
  });

  it("keeps recent tombstones and sidecars during garbage collection", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");

    await tombstoneManifestFile(backend, "note.md");
    let result = await gcWorkspaceTombstones(backend, {
      now: Date.now(),
      retentionMs: 60_000,
    });
    let manifest = await loadWorkspaceManifest(backend);

    expect(result).toEqual({ removed: 0 });
    expect(manifest.records).toMatchObject([
      {
        deletedAt: expect.any(Number),
        docId: document.docId,
        path: "note.md",
      },
    ]);
    expect(backend.files.has(`.livemd/docs/${document.docId}.snapshot.b64`)).toBe(true);
  });

  it("garbage collects expired tombstones and document sidecars", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.insert(text.toString().length, "\nPending edit.\n");
    document.doc.commit();
    await savePendingCollabDocumentUpdates(backend, document);
    await tombstoneManifestFile(backend, "note.md");

    let result = await gcWorkspaceTombstones(backend, {
      now: Date.now() + 1,
      retentionMs: 0,
    });
    let manifest = await loadWorkspaceManifest(backend);

    expect(result).toEqual({ removed: 1 });
    expect(manifest.records).toEqual([]);
    expect(backend.files.has(`.livemd/docs/${document.docId}.snapshot.b64`)).toBe(false);
    expect(hasUpdateSegments(backend, document.docId)).toBe(false);
  });

  it("migrates legacy JSON manifests into the Loro workspace manifest", async () => {
    let backend = createMemoryBackend([
      [
        ".livemd/manifest.json",
        JSON.stringify({
          files: [{ docId: "legacy-doc", path: "note.md" }],
          schemaVersion: 1,
        }),
      ],
      ["note.md", "# First\n"],
    ]);

    let manifest = await loadWorkspaceManifest(backend);

    expect(manifest.records).toMatchObject([{ docId: "legacy-doc", path: "note.md" }]);
    expect(backend.files.has(".livemd/workspace.snapshot.b64")).toBe(true);
  });
});

type MemoryBackend = WorkspaceBackend & {
  files: Map<string, string>;
  writeBytes: NonNullable<WorkspaceBackend["writeBytes"]>;
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
    async deleteEntry(path, options) {
      files.delete(path);
      if (options?.recursive) {
        let prefix = `${path}/`;
        let pathsToDelete: string[] = [];
        for (let filePath of files.keys())
          if (filePath.startsWith(prefix)) pathsToDelete.push(filePath);
        for (let filePath of pathsToDelete) files.delete(filePath);
      }
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

function encodeUpdateLogForTest(updates: Uint8Array[]) {
  let byteLength = updates.reduce((total, update) => total + 4 + update.byteLength, 0);
  let bytes = new Uint8Array(byteLength);
  let view = new DataView(bytes.buffer);
  let offset = 0;

  for (let update of updates) {
    view.setUint32(offset, update.byteLength);
    offset += 4;
    bytes.set(update, offset);
    offset += update.byteLength;
  }

  return bytes;
}

function hasUpdateSegments(backend: MemoryBackend, docId: string) {
  let prefix = `${updateLogDirectoryPath(docId)}/`;
  return [...backend.files.keys()].some((path) => path.startsWith(prefix));
}

function legacyUpdateLogPath(docId: string) {
  return `.livemd/docs/${docId}.updates.b64`;
}

function updateLogDirectoryPath(docId: string) {
  return `.livemd/docs/${docId}.updates`;
}

function updateSegmentPath(docId: string, sequence: number) {
  return `${updateLogDirectoryPath(docId)}/${String(sequence).padStart(6, "0")}.update.b64`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, reject, resolve };
}
