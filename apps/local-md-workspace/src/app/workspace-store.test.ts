import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceCollaborativeDocument } from "@/lib/workspace/documents";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import {
  clearWorkspaceDocumentOpening,
  clearWorkspaceDocumentView,
  createWorkspaceAppSetters,
  createWorkspaceAppStore,
  publishEditorDocumentValue,
  publishWorkspaceDocumentOpening,
  publishWorkspaceDocumentView,
  publishWorkspaceRuntime,
  workspaceLiveObjects,
  type WorkspaceAppState,
  type WorkspaceAppStore,
} from "./workspace-store.ts";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

describe("workspace app store", () => {
  it("supports values and updater functions through its field setters", () => {
    let store = createWorkspaceAppStore();
    let { setErrorMessage } = createWorkspaceAppSetters(store);

    setErrorMessage("First error");
    setErrorMessage((current) => current + "; second error");

    expect(store.getState().errorMessage).toBe("First error; second error");
  });

  it("keeps the selected document while its replacement is loading", () => {
    let store = createWorkspaceAppStore();
    let selected = publishDocument(store, "a.md", "# A");

    publishWorkspaceDocumentOpening(store, { path: "b.md" }, "# A edited");
    publishWorkspaceDocumentOpening(store, { path: "c.md" });

    expect(store.getState()).toMatchObject({
      documentView: { docId: selected.document.docId, path: selected.file.path },
      editorDocument: { path: selected.file.path },
      openingDocument: { path: "c.md" },
      selectedFile: selected.file,
    });
    expect(workspaceLiveObjects(store)).toMatchObject({
      collabDocument: selected.document,
      editorValue: "# A edited",
    });

    clearWorkspaceDocumentOpening(store);
    expect(store.getState().openingDocument).toBeNull();
  });

  it("installs a document and clears its opening in one publication", () => {
    let store = createWorkspaceAppStore();
    publishWorkspaceDocumentOpening(store, { path: "b.md" });
    let snapshots = recordSnapshots(store);
    let next = publishDocument(store, "b.md", "# B");

    expect(snapshots).toHaveLength(1);
    expect(workspaceLiveObjects(store)).toMatchObject({
      collabDocument: next.document,
      editorValue: next.value,
    });
    expect(snapshots[0]).toMatchObject({
      documentView: { docId: next.document.docId, path: next.file.path },
      editorDocument: { path: next.file.path },
      openingDocument: null,
      saveState: "saved",
      selectedFile: next.file,
      singleFileSource: null,
      treeSelection: next.file,
    });
  });

  it("clears the selected view in one publication", () => {
    let store = createWorkspaceAppStore();
    publishDocument(store, "a.md", "# A");
    publishWorkspaceDocumentOpening(store, { path: "b.md" });
    let snapshots = recordSnapshots(store);

    clearWorkspaceDocumentView(store);

    expect(snapshots).toHaveLength(1);
    expect(workspaceLiveObjects(store)).toMatchObject({ collabDocument: null, editorValue: "" });
    expect(store.getState()).toMatchObject({
      documentView: null,
      editorDocument: { path: "" },
      openingDocument: null,
      saveState: "idle",
      selectedFile: null,
      singleFileSource: null,
      treeSelection: null,
    });
  });

  it("keeps live runtime objects and document text out of Zustand state", () => {
    let store = createWorkspaceAppStore();
    let runtime = {
      dispose: async () => {},
      host: {},
      identity: { id: "memory:test", kind: "local", name: "Test" },
    } as unknown as WorkspaceRuntime;
    publishWorkspaceRuntime(store, runtime);
    let selected = publishDocument(store, "a.md", "# Secret text");

    let state = store.getState();
    expect(state.workspace).toEqual({ generation: expect.any(Number), identity: runtime.identity });
    expect(workspaceLiveObjects(store).workspaceRuntime).toBe(runtime);
    for (let value of Object.values(state)) {
      expect(value).not.toBe(runtime);
      expect(value).not.toBe(selected.document);
    }
    expect(JSON.stringify(state)).not.toContain("# Secret text");
    expect(state).not.toHaveProperty("workspaceRuntime");
    expect(state).not.toHaveProperty("collabDocument");
  });

  it("bumps the editor version only when the published text changes", () => {
    let store = createWorkspaceAppStore();
    publishEditorDocumentValue(store, { path: "a.md", value: "# A" });
    let version = store.getState().editorDocument.version;

    publishEditorDocumentValue(store, { path: "a.md", value: "# A" });
    expect(store.getState().editorDocument.version).toBe(version);

    publishEditorDocumentValue(store, { path: "a.md", value: "# A2" });
    expect(store.getState().editorDocument).toEqual({ path: "a.md", version: version + 1 });
    expect(workspaceLiveObjects(store).editorValue).toBe("# A2");
  });
});

function publishDocument(store: WorkspaceAppStore, path: string, value: string) {
  let file = { kind: "file" as const, name: path, path } satisfies MarkdownFileNode;
  let document = { docId: "test:" + path, path } as WorkspaceCollaborativeDocument;
  publishWorkspaceDocumentView(store, { document, file, saveState: "saved", value });
  return { document, file, value };
}

function recordSnapshots(store: WorkspaceAppStore) {
  let snapshots: WorkspaceAppState[] = [];
  store.subscribe((snapshot) => snapshots.push(snapshot));
  return snapshots;
}
