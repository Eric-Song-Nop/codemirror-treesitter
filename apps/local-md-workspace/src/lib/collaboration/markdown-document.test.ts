// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { resetBrowserCollabMemoryStoreForTests } from "./collab-browser-store.ts";
import {
  getCollabDocumentValue,
  hashMarkdownText,
  ingestExternalMarkdownEdit,
  materializeCollabDocument,
  openMarkdownCollabDocument,
  reloadCollabDocumentFromSource,
  saveCollabDocumentSnapshot,
  savePendingCollabDocumentUpdates,
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
  resetBrowserCollabMemoryStoreForTests();
  if (indexedDbDescriptor) {
    Object.defineProperty(window, "indexedDB", indexedDbDescriptor);
  } else {
    Reflect.deleteProperty(window, "indexedDB");
  }
});

describe("Markdown collaboration documents", () => {
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

  it("imports external Markdown edits when Loro has no unmaterialized changes", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let first = await openMarkdownCollabDocument(backend, "note.md");

    backend.files.set("note.md", "# External edit\n");
    let reopened = await openMarkdownCollabDocument(backend, "note.md");

    expect(reopened.docId).toBe(first.docId);
    expect(reopened.value).toBe("# External edit\n");
    expect(reopened.externalEdit).toEqual({ kind: "imported", path: "note.md" });
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
    expect(backend.files.get("note.md")).toBe("# First\n\nExternal paragraph.\n");
    expect([...backend.files.keys()]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/external-conflict-\d{14}\.md$/)]),
    );
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
    expect([...backend.files.keys()]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/external-conflict-\d{14}\.md$/)]),
    );
  });

  it("can keep the external source without writing shared edits to a conflict copy", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");

    backend.files.set("note.md", "# External edit\n");
    text.delete(0, text.toString().length);
    text.insert(0, "# Shared edit\n");
    document.doc.commit();

    let result = await reloadCollabDocumentFromSource(backend, document);

    expect(result.sourceValue).toBe("# External edit\n");
    expect(backend.files.get("note.md")).toBe("# External edit\n");
    expect([...backend.files.keys()]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/shared-conflict-\d{14}\.md$/)]),
    );
    expect(getCollabDocumentValue(document)).toBe("# External edit\n");
    expect(document.metadata.materializedHash).toBe(hashMarkdownText("# External edit\n"));
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
