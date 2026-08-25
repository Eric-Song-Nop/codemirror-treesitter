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
  ingestExternalMarkdownObservation,
  materializeCollabDocument,
  openMarkdownCollabDocument,
  resolveCollabRecoveryUseExternal,
  saveCollabDocumentSnapshot,
  savePendingCollabDocumentUpdates,
  scheduleCollabDocumentSnapshotFlush,
} from "./markdown-document.ts";
import {
  createMemoryWorkspaceRuntime,
  type MemoryWorkspaceRuntime,
} from "@/test/memory-workspace-runtime";
import type { WorkspaceIdentity } from "@/lib/workspace/runtime/types";

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
  it("releases owned Loro resources exactly once when disposed", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let freeDocument = vi.spyOn(document.doc, "free");
    let freeUndoManager = vi.spyOn(document.undoManager, "free");

    await document.dispose();
    await document.dispose();

    expect(freeUndoManager).toHaveBeenCalledOnce();
    expect(freeDocument).toHaveBeenCalledOnce();
  });

  it("releases temporary fork documents after importing external edits", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let text = document.doc.getText("markdown");
    text.insert(text.toString().length, "Shared paragraph.\n");
    document.doc.commit();
    text.free();
    backend.files.set("note.md", "# First\n\nExternal paragraph.\n");
    let freeDocument = vi.spyOn(LoroDoc.prototype, "free");

    await ingestExternalMarkdownEdit(backend, document);

    expect(freeDocument).toHaveBeenCalledOnce();
    await document.dispose();
  });

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

  it("imports an already observed source snapshot without reading storage again", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);
    let document = await openMarkdownCollabDocument(backend, "note.md");
    let observe = vi.spyOn(backend.documentSource, "observe");

    let result = await ingestExternalMarkdownObservation(document, {
      state: "present",
      value: {
        bytes: new TextEncoder().encode("# External\n"),
        capture: "bound",
        contentHash: "sha256:external",
        metadata: { etag: "etag-2" },
        revision: { kind: "etag", validation: "atomic", value: "etag-2" },
        value: "# External\n",
      },
    });

    expect(observe).not.toHaveBeenCalled();
    expect(result?.value).toBe("# External\n");
    expect(document.source).toEqual({
      baseline: {
        contentHash: "sha256:external",
        revision: { kind: "etag", validation: "atomic", value: "etag-2" },
      },
      kind: "present",
    });
    await document.dispose();
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

  it("preserves dirty Loro content until external recovery is explicitly confirmed", async () => {
    let { document, reopened } = await openRecoveryRequiredDocument();

    expect(reopened.value).toBe("# Local recovery content\n");
    expect(reopened.sourceState).toEqual({ kind: "blocked" });
    expect(reopened.source).toMatchObject({
      incoming: { value: "# External recovery content\n" },
      kind: "recovery-required",
    });

    if (reopened.source.kind != "recovery-required") throw new Error("Expected recovery state.");
    let result = await resolveCollabRecoveryUseExternal(
      reopened,
      reopened.source.incoming,
      reopened.source.incoming.revision,
    );

    expect(result.status).toBe("applied");
    expect(getCollabDocumentValue(reopened)).toBe("# External recovery content\n");
    expect(reopened.cleanValue).toBe("# External recovery content\n");
    expect(reopened.source.kind).toBe("present");
    expect(reopened.sourceState).toEqual({ kind: "synced" });
    await document.dispose();
    await reopened.dispose();
  });

  it("requires recovery confirmation again when the incoming revision changed", async () => {
    let { document, reopened } = await openRecoveryRequiredDocument();
    if (reopened.source.kind != "recovery-required") throw new Error("Expected recovery state.");
    let confirmedRevision = reopened.source.incoming.revision;

    let result = await resolveCollabRecoveryUseExternal(
      reopened,
      {
        ...reopened.source.incoming,
        contentHash: "sha256:changed-again",
        revision: {
          kind: "etag",
          validation: "atomic",
          value: "changed-again",
        },
        value: "# Changed again\n",
      },
      confirmedRevision,
    );

    expect(result.status).toBe("incoming-changed");
    expect(getCollabDocumentValue(reopened)).toBe("# Local recovery content\n");
    expect(reopened.source.kind).toBe("recovery-required");
    await document.dispose();
    await reopened.dispose();
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

async function openRecoveryRequiredDocument() {
  let backend = createMemoryBackend([["note.md", "# First\n"]]);
  let document = await openMarkdownCollabDocument(backend, "note.md");
  let text = document.doc.getText("markdown");
  text.update("# Local recovery content\n");
  document.doc.commit();
  text.free();
  await writeBrowserCollabSnapshot(
    {
      ...document.metadata,
      materializedFrontiers: [{ counter: 999, peer: "999" }],
      materializedVersionVector: [["999", 999]],
    },
    document.doc.export({ mode: "snapshot" }),
  );
  backend.files.set("note.md", "# External recovery content\n");
  return {
    document,
    reopened: await openMarkdownCollabDocument(backend, "note.md"),
  };
}

type MemoryBackend = MemoryWorkspaceRuntime;

function createMemoryBackend(
  entries: Array<[string, string]> | Map<string, string>,
  id = "memory:test",
  sourceAliases: WorkspaceIdentity["sourceAliases"] = [],
): MemoryBackend {
  return createMemoryWorkspaceRuntime(entries, { id, sourceAliases });
}

function hasLiveMdFiles(backend: MemoryBackend) {
  return [...backend.files.keys()].some((path) => path == ".livemd" || path.startsWith(".livemd/"));
}

function expectMergedParagraphs(value: string) {
  expect(value.startsWith("# First\n\n")).toBe(true);
  expect(value).toContain("External paragraph.\n");
  expect(value).toContain("Shared paragraph.\n");
}
