import { describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceCollaborativeDocument } from "@/lib/workspace/documents";
import type { WorkspaceDocumentContext } from "@/lib/workspace/document-context";
import {
  WorkspaceDocumentViewCoordinator,
  type PreparedWorkspaceDocumentView,
} from "./document-view-coordinator.ts";
import { createWorkspaceAppStore } from "./workspace-store.ts";

describe("WorkspaceDocumentViewCoordinator", () => {
  it("publishes only the latest completed selection", async () => {
    let fixture = createFixture();
    let prepareA = deferred();
    let candidateA = fixture.candidate("A", "a.md");
    let candidateB = fixture.candidate("B", "b.md");

    let signalA = fixture.coordinator.begin(candidateA.file.path);
    let selectionA = fixture.coordinator.select({
      signal: signalA,
      prepare: async () => {
        await prepareA.promise;
        return candidateA.prepared;
      },
    });

    let signalB = fixture.coordinator.begin(candidateB.file.path);
    await expect(
      fixture.coordinator.select({ signal: signalB, prepare: async () => candidateB.prepared }),
    ).resolves.toBe(candidateB.context);
    prepareA.resolve();

    await expect(selectionA).resolves.toBeNull();
    expect(candidateA.activate).not.toHaveBeenCalled();
    expect(fixture.coordinator.current()).toBe(candidateB.context);
    expect(fixture.store.getState().selectedFile).toBe(candidateB.file);
  });

  it("switches only the UI subscription and leaves documents alive", async () => {
    let fixture = createFixture();
    let candidateA = fixture.candidate("A", "a.md");
    let candidateB = fixture.candidate("B", "b.md");

    await fixture.coordinator.select({
      signal: fixture.coordinator.begin(candidateA.file.path),
      prepare: async () => candidateA.prepared,
    });
    await fixture.coordinator.select({
      signal: fixture.coordinator.begin(candidateB.file.path),
      prepare: async () => candidateB.prepared,
    });

    expect(candidateA.release).toHaveBeenCalledOnce();
    expect(candidateA.retire).toHaveBeenCalledOnce();
    expect(candidateA.flush).not.toHaveBeenCalled();
    expect(candidateA.dispose).not.toHaveBeenCalled();
    expect(fixture.coordinator.current()).toBe(candidateB.context);
  });

  it("keeps the next loading indicator visible while clearing the current view", async () => {
    let fixture = createFixture();
    let candidate = fixture.candidate("A", "a.md");
    await fixture.coordinator.select({
      signal: fixture.coordinator.begin(candidate.file.path),
      prepare: async () => candidate.prepared,
    });

    let signal = fixture.coordinator.begin("Draft.md");
    await expect(fixture.coordinator.close(signal)).resolves.toEqual({ hadActiveView: true });
    expect(fixture.store.getState().openingDocument).toEqual({ path: "Draft.md" });
    expect(candidate.flush).not.toHaveBeenCalled();
    expect(candidate.dispose).not.toHaveBeenCalled();

    fixture.coordinator.finish(signal);
    expect(fixture.store.getState().openingDocument).toBeNull();
  });

  it("cancels pending view work during disposal without activating its document", async () => {
    let fixture = createFixture();
    let gate = deferred();
    let candidate = fixture.candidate("A", "a.md");
    let signal = fixture.coordinator.begin(candidate.file.path);
    let selection = fixture.coordinator.select({
      signal,
      prepare: async () => {
        await gate.promise;
        return candidate.prepared;
      },
    });

    fixture.coordinator.dispose();
    gate.resolve();

    await expect(selection).resolves.toBeNull();
    expect(signal.aborted).toBe(true);
    expect(candidate.activate).not.toHaveBeenCalled();
    expect(fixture.store.getState().selectedFile).toBeNull();
  });

  it("stays closed when releasing the active view fails during disposal", async () => {
    let fixture = createFixture();
    let candidate = fixture.candidate("A", "a.md");
    await fixture.coordinator.select({
      signal: fixture.coordinator.begin(candidate.file.path),
      prepare: async () => candidate.prepared,
    });
    candidate.release.mockImplementationOnce(() => {
      throw new Error("release failed");
    });

    expect(() => fixture.coordinator.dispose()).toThrow("release failed");
    expect(candidate.retire).toHaveBeenCalledOnce();
    expect(() => fixture.coordinator.begin("b.md")).toThrow(
      "The workspace document view coordinator is closed.",
    );
  });
});

function createFixture() {
  let store = createWorkspaceAppStore();
  let coordinator = new WorkspaceDocumentViewCoordinator(store);

  function candidate(id: string, path: string) {
    let file = { kind: "file" as const, name: path, path };
    let flush = vi.fn(async () => {});
    let dispose = vi.fn(async () => {});
    let document = {
      dispose,
      docId: `document:${id}`,
      flush,
      path,
    } as unknown as WorkspaceCollaborativeDocument;
    let context = { collabDocument: document, file } as WorkspaceDocumentContext;
    let release = vi.fn();
    let retire = vi.fn();
    let activate = vi.fn(() => ({ context, release, retire }));
    let prepared: PreparedWorkspaceDocumentView = {
      activate,
      view: { document, file, saveState: "saved", value: `# ${id}\n` },
    };
    return { activate, context, dispose, file, flush, prepared, release, retire };
  }

  return { candidate, coordinator, store };
}

function deferred() {
  let resolve!: () => void;
  let promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
