// @vitest-environment happy-dom

import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  loadBrowserCollabDocument,
  resetBrowserCollabMemoryStoreForTests,
} from "@/lib/collaboration/collab-browser-store";
import { createMemoryWorkspaceRuntime } from "@/test/memory-workspace-runtime";

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
  if (indexedDbDescriptor) Object.defineProperty(window, "indexedDB", indexedDbDescriptor);
  else Reflect.deleteProperty(window, "indexedDB");
});

describe("workspace collaborative documents", () => {
  it("shares one in-flight document for a normalized path", async () => {
    let { documents, runtime } = fixture([["notes/a.md", "A"]]);

    let first = documents.document("/notes\\a.md/");
    let second = documents.document("notes/a.md");

    expect(second).toBe(first);
    expect((await first).read()).toBe("A");
    await documents.close();
    await runtime.dispose();
  });

  it("removes a rejected open so the path can be retried", async () => {
    let { documents, runtime } = fixture();
    let failed = documents.document("created-later.md");

    await expect(failed).rejects.toThrow("does not exist");
    runtime.files.set("created-later.md", "ready");

    let retried = documents.document("created-later.md");
    expect(retried).not.toBe(failed);
    expect((await retried).read()).toBe("ready");
    await documents.close();
    await runtime.dispose();
  });

  it("applies exact edits atomically and reports stale or overlapping ranges", async () => {
    let { documents, runtime } = fixture([["note.md", "abcdef"]]);
    let document = await documents.document("note.md");

    expect(document.edit([{ expectedText: "bc", from: 1, insert: "BC", to: 3 }])).toMatchObject({
      appliedEdits: 1,
      status: "applied",
      value: "aBCdef",
    });
    expect(document.edit([{ expectedText: "bc", from: 1, insert: "x", to: 3 }])).toMatchObject({
      editIndex: 0,
      reason: "expected-text-mismatch",
      status: "conflict",
    });
    expect(
      document.edit([
        { expectedText: "BCd", from: 1, insert: "x", to: 4 },
        { expectedText: "de", from: 3, insert: "y", to: 5 },
      ]),
    ).toMatchObject({ editIndex: 1, reason: "overlapping-edits", status: "conflict" });
    expect(document.read()).toBe("aBCdef");

    await document.flush();
    await documents.close();
    await runtime.dispose();
  });

  it("lets a flush finish at its generation while a newer edit remains queued", async () => {
    vi.useFakeTimers();
    let { documents, runtime } = fixture([["note.md", "start"]]);
    let document = await documents.document("note.md");
    let firstCommitStarted = deferred();
    let releaseFirstCommit = deferred();
    let originalCommit = runtime.documentSource.commit.bind(runtime.documentSource);
    let commit = vi.spyOn(runtime.documentSource, "commit").mockImplementation(async (input) => {
      if (commit.mock.calls.length == 1) {
        firstCommitStarted.resolve();
        await releaseFirstCommit.promise;
      }
      return originalCommit(input);
    });

    document.edit([{ expectedText: "", from: 5, insert: " one", to: 5 }]);
    let firstFlush = document.flush();
    await firstCommitStarted.promise;
    document.edit([{ expectedText: "", from: 9, insert: " two", to: 9 }]);
    releaseFirstCommit.resolve();

    await firstFlush;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(runtime.files.get("note.md")).toBe("start one");

    await document.flush();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(runtime.files.get("note.md")).toBe("start one two");
    await documents.close();
    await runtime.dispose();
  });

  it("keeps an accepted edit in browser recovery when source projection fails", async () => {
    let { documents, runtime } = fixture([["note.md", "start"]]);
    let document = await documents.document("note.md");
    vi.spyOn(runtime.documentSource, "commit").mockRejectedValue(new Error("source offline"));

    document.edit([{ expectedText: "", from: 5, insert: " durable", to: 5 }]);
    await expect(document.flush()).rejects.toThrow("source offline");

    let stored = await loadBrowserCollabDocument(document.docId);
    let recovered = new LoroDoc();
    recovered.import(stored.snapshot!);
    if (stored.updates.length) recovered.importBatch(stored.updates);
    let text = recovered.getText("markdown");
    expect(text.toString()).toBe("start durable");
    text.free();
    recovered.free();
    await runtime.dispose().catch(() => {});
  });

  it("keeps every opened document alive until registry close", async () => {
    let { documents, runtime } = fixture([
      ["a.md", "A"],
      ["b.md", "B"],
    ]);
    let first = await documents.document("a.md");
    let second = await documents.document("b.md");
    let freeFirst = vi.spyOn(first.loroDoc, "free");
    let freeSecond = vi.spyOn(second.loroDoc, "free");

    expect(await documents.document("a.md")).toBe(first);
    expect(freeFirst).not.toHaveBeenCalled();
    await documents.close();

    expect(freeFirst).toHaveBeenCalledOnce();
    expect(freeSecond).toHaveBeenCalledOnce();
    await expect(documents.document("a.md")).rejects.toThrow("closed");
    await runtime.dispose();
  });
});

function fixture(entries: Array<[string, string]> = []) {
  let runtime = createMemoryWorkspaceRuntime(entries);
  return {
    documents: runtime.documents,
    runtime,
  };
}

function deferred() {
  let resolve!: () => void;
  let promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
