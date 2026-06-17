// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LoroDoc } from "loro-crdt";
import {
  browserCollabUpdateLogByteLength,
  resetBrowserCollabMemoryStoreForTests,
  writeBrowserCollabSnapshot,
} from "./collab-browser-store.ts";
import {
  getCollabDocumentValue,
  ingestExternalMarkdownEdit,
  materializeCollabDocument,
  openMarkdownCollabDocument,
  saveCollabDocumentSnapshot,
  savePendingCollabDocumentUpdates,
  scheduleCollabDocumentSnapshotFlush,
} from "./markdown-document.ts";
import type { MarkdownDirectoryNode, WorkspaceBackend } from "@/lib/workspace-backend";

let indexedDbDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  indexedDbDescriptor = Object.getOwnPropertyDescriptor(window, "indexedDB");
  Object.defineProperty(window, "indexedDB", {
    configurable: true,
    value: undefined,
  });
  resetBrowserCollabMemoryStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetBrowserCollabMemoryStoreForTests();
  if (indexedDbDescriptor) {
    Object.defineProperty(window, "indexedDB", indexedDbDescriptor);
  } else {
    Reflect.deleteProperty(window, "indexedDB");
  }
});

describe("Markdown collaboration documents", () => {
  it("debounces local Loro update-log persistence", async () => {
    vi.useFakeTimers();
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.insert(text.toString().length, "\nShared edit.\n");
    document.doc.commit();

    await vi.advanceTimersByTimeAsync(299);
    let earlyReopen = await openMarkdownCollabDocument(backend, "note.md");
    expect(earlyReopen.value).toBe("# First\n");
    await earlyReopen.dispose();

    await vi.advanceTimersByTimeAsync(1);
    let reopened = await openMarkdownCollabDocument(backend, "note.md");
    expect(reopened.value).toBe("# First\n\nShared edit.\n");

    await document.dispose();
    await reopened.dispose();
  });

  it("flushes pending local Loro updates before disposal", async () => {
    vi.useFakeTimers();
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.insert(text.toString().length, "\nShared edit.\n");
    document.doc.commit();

    await vi.advanceTimersByTimeAsync(299);
    await document.dispose();

    let reopened = await openMarkdownCollabDocument(backend, "note.md");
    expect(reopened.value).toBe("# First\n\nShared edit.\n");

    await reopened.dispose();
  });

  it("flushes scheduled snapshots before disposal", async () => {
    vi.useFakeTimers();
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let remoteDoc = new LoroDoc();
    let remoteUpdateStart = document.doc.oplogVersion();

    remoteDoc.import(document.doc.export({ mode: "snapshot" }));
    let remoteText = remoteDoc.getText("markdown");
    remoteText.insert(remoteText.toString().length, "\nRemote edit.\n");
    remoteDoc.commit();
    document.doc.import(remoteDoc.export({ mode: "update", from: remoteUpdateStart }));
    scheduleCollabDocumentSnapshotFlush(document);

    await vi.advanceTimersByTimeAsync(299);
    await document.dispose();

    let reopened = await openMarkdownCollabDocument(backend, "note.md");
    expect(reopened.value).toBe("# First\n\nRemote edit.\n");

    await reopened.dispose();
  });

  it("keeps Loro snapshots and updates out of the workspace backend", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.insert(text.toString().length, "\nShared edit.\n");
    document.doc.commit();
    await savePendingCollabDocumentUpdates(backend, document);

    expect(backend.files.get("note.md")).toBe("# First\n");
    expect(hasLiveMdFiles(backend)).toBe(false);

    let reopened = await openMarkdownCollabDocument(backend, "note.md");
    expect(reopened.docId).toBe(document.docId);
    expect(reopened.value).toBe("# First\n\nShared edit.\n");
    expect(hasLiveMdFiles(backend)).toBe(false);
  });

  it("lets snapshot persistence replace a pending update-log flush", async () => {
    vi.useFakeTimers();
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.insert(text.toString().length, "\nShared edit.\n");
    document.doc.commit();
    scheduleCollabDocumentSnapshotFlush(document);
    await vi.advanceTimersByTimeAsync(300);

    expect(await browserCollabUpdateLogByteLength(document.docId)).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await browserCollabUpdateLogByteLength(document.docId)).toBe(0);

    let reopened = await openMarkdownCollabDocument(backend, "note.md");
    expect(reopened.value).toBe("# First\n\nShared edit.\n");

    await document.dispose();
    await reopened.dispose();
  });

  it("imports external Markdown edits when Loro has no unmaterialized changes", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let first = await openMarkdownCollabDocument(backend, "note.md");

    backend.files.set("note.md", "# External edit\n");
    let reopened = await openMarkdownCollabDocument(backend, "note.md");

    expect(reopened.docId).toBe(first.docId);
    expect(reopened.value).toBe("# External edit\n");
    expect(reopened.externalEdit).toEqual({ kind: "imported", path: "note.md" });
    expect(reopened.sourceState).toEqual({ kind: "synced" });
    expect(hasLiveMdFiles(backend)).toBe(false);
  });

  it("imports source edits into the same Loro document when shared text also changed", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.insert(text.toString().length, "Shared paragraph.\n");
    document.doc.commit();
    backend.files.set("note.md", "# First\n\nExternal paragraph.\n");

    let result = await ingestExternalMarkdownEdit(backend, document);

    expect(result?.externalEdit).toEqual({ kind: "imported", path: "note.md" });
    expect(result?.update?.byteLength).toBeGreaterThan(0);
    expectMergedParagraphs(getCollabDocumentValue(document));
    expect(document.sourceState).toEqual({ kind: "needs-write" });
    expect(backend.files.get("note.md")).toBe("# First\n\nExternal paragraph.\n");
    expect([...backend.files.keys()]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/external-conflict-\d{14}\.md$/)]),
    );
  });

  it("reopens source edits through Loro when shared text also has unmaterialized changes", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.insert(text.toString().length, "Shared paragraph.\n");
    document.doc.commit();
    await saveCollabDocumentSnapshot(backend, document);
    backend.files.set("note.md", "# First\n\nExternal paragraph.\n");

    let reopened = await openMarkdownCollabDocument(backend, "note.md");

    expectMergedParagraphs(reopened.value);
    expect(reopened.externalEdit).toEqual({ kind: "imported", path: "note.md" });
    expect(reopened.sourceState).toEqual({ kind: "needs-write" });
    expect(backend.files.get("note.md")).toBe("# First\n\nExternal paragraph.\n");
    expect([...backend.files.keys()]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/external-conflict-\d{14}\.md$/)]),
    );

    let secondImport = await ingestExternalMarkdownEdit(backend, reopened);

    expect(secondImport).toBeNull();
    expect(reopened.sourceState).toEqual({ kind: "needs-write" });
  });

  it("materializes shared text to the Markdown source and updates browser metadata", async () => {
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
    expect(document.metadata.materializedHash).toBe("997e77f1");
    expect(document.metadata.materializedValue).toBe("# Updated\n");
    expect(document.sourceState).toEqual({ kind: "synced" });
    expect(hasLiveMdFiles(backend)).toBe(false);
  });

  it("materializes the merged Loro result when the source file changed", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    text.insert(text.toString().length, "Shared paragraph.\n");
    document.doc.commit();
    backend.files.set("note.md", "# First\n\nExternal paragraph.\n");

    let result = await materializeCollabDocument(backend, document);
    let mergedValue = getCollabDocumentValue(document);

    expect(result.externalEdit).toEqual({ kind: "imported", path: "note.md" });
    expectMergedParagraphs(mergedValue);
    expect(backend.files.get("note.md")).toBe(mergedValue);
    expect(document.metadata.materializedValue).toBe(mergedValue);
    expect(document.sourceState).toEqual({ kind: "synced" });
    expect([...backend.files.keys()]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/external-conflict-\d{14}\.md$/)]),
    );
  });

  it("ignores incomplete browser snapshots and rebuilds from the source file", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let incompleteMetadata = {
      docId: document.metadata.docId,
      materializedAt: document.metadata.materializedAt,
      materializedHash: document.metadata.materializedHash,
      path: document.metadata.path,
      workspaceId: document.metadata.workspaceId,
    };
    let text = document.doc.getText("markdown");

    text.delete(0, text.toString().length);
    text.insert(0, "# Shared edit\n");
    document.doc.commit();
    await writeBrowserCollabSnapshot(
      incompleteMetadata as Parameters<typeof writeBrowserCollabSnapshot>[0],
      document.doc.export({ mode: "snapshot" }),
    );
    backend.files.set("note.md", "# External edit\n");

    let reopened = await openMarkdownCollabDocument(backend, "note.md");

    expect(reopened.value).toBe("# External edit\n");
    expect(reopened.externalEdit).toBeUndefined();
    expect(reopened.sourceState).toEqual({ kind: "synced" });
    expect(backend.files.get("note.md")).toBe("# External edit\n");

    let openedAgain = await openMarkdownCollabDocument(backend, "note.md");

    expect(openedAgain.docId).toBe(document.docId);
    expect(openedAgain.value).toBe("# External edit\n");
    expect(openedAgain.metadata.materializedValue).toBe("# External edit\n");
    expect([...backend.files.keys()]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/external-conflict-\d{14}\.md$/)]),
    );
  });

  it("opens legacy local CRDT documents through explicit source aliases", async () => {
    let files = new Map([["note.md", "# First\n"]]);
    let legacyBackend = createMemoryBackend(files, "local:Notes");
    let legacyDocument = await openMarkdownCollabDocument(legacyBackend, "note.md");
    let text = legacyDocument.doc.getText("markdown");
    text.insert(text.toString().length, "\nShared edit.\n");
    legacyDocument.doc.commit();
    await saveCollabDocumentSnapshot(legacyBackend, legacyDocument);

    let migratedBackend = createMemoryBackend(files, "local:workspace-2", [
      {
        kind: "local",
        namespace: "local:local:Notes",
        workspaceId: "local:Notes",
      },
    ]);
    let migratedDocument = await openMarkdownCollabDocument(migratedBackend, "note.md");

    expect(migratedDocument.docId).not.toBe(legacyDocument.docId);
    expect(migratedDocument.metadata.workspaceId).toBe("local:local:workspace-2");
    expect(migratedDocument.value).toBe("# First\n\nShared edit.\n");
    expect(migratedDocument.sourceState).toEqual({ kind: "needs-write" });

    let reopened = await openMarkdownCollabDocument(migratedBackend, "note.md");
    expect(reopened.docId).toBe(migratedDocument.docId);
    expect(reopened.value).toBe("# First\n\nShared edit.\n");
  });
});

type MemoryBackend = WorkspaceBackend & {
  files: Map<string, string>;
};

function createMemoryBackend(
  entries: Array<[string, string]> | Map<string, string>,
  id = "memory:test",
  sourceAliases: WorkspaceBackend["sourceAliases"] = [],
): MemoryBackend {
  let files = entries instanceof Map ? entries : new Map(entries);
  return {
    files,
    id,
    kind: "local",
    name: "Memory",
    sourceAliases,
    async createFile(path) {
      files.set(path, "");
      return path;
    },
    async deleteFile(path) {
      files.delete(path);
    },
    async readFile(path) {
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
    async stat(path) {
      return {
        exists: files.has(path),
        isDirectory: false,
        isFile: files.has(path),
        path,
      };
    },
    async writeFile(path, value) {
      files.set(path, value);
    },
  };
}

function hasLiveMdFiles(backend: MemoryBackend) {
  return [...backend.files.keys()].some((path) => path == ".livemd" || path.startsWith(".livemd/"));
}

function expectMergedParagraphs(value: string) {
  expect(value.startsWith("# First\n\n")).toBe(true);
  expect(value).toContain("External paragraph.\n");
  expect(value).toContain("Shared paragraph.\n");
}
