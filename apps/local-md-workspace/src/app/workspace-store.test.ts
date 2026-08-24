import { describe, expect, it } from "vite-plus/test";
import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import {
  clearWorkspaceDocumentOpening,
  clearWorkspaceDocumentView,
  createWorkspaceAppSetters,
  createWorkspaceAppStore,
  publishWorkspaceDocumentOpening,
  publishWorkspaceDocumentView,
  type WorkspaceAppState,
  type WorkspaceAppStore,
} from "./workspace-store.ts";

describe("workspace app store", () => {
  it("supports values and updater functions through its field setters", () => {
    let store = createWorkspaceAppStore();
    let { setErrorMessage } = createWorkspaceAppSetters(store);

    setErrorMessage("First error");
    setErrorMessage((current) => current + "; second error");

    expect(store.getState().errorMessage).toBe("First error; second error");
  });

  it("keeps the active document while only the latest opening can finish", () => {
    let store = createWorkspaceAppStore();
    let active = publishDocument(store, "a.md", "# A");

    publishWorkspaceDocumentOpening(store, { intentId: 2, path: "b.md" }, "# A edited");
    publishWorkspaceDocumentOpening(store, { intentId: 3, path: "c.md" });
    clearWorkspaceDocumentOpening(store, 2);

    expect(store.getState()).toMatchObject({
      collabDocument: active.document,
      editorDocument: { path: active.file.path, value: "# A edited" },
      openingDocument: { intentId: 3, path: "c.md" },
      selectedFile: active.file,
    });

    clearWorkspaceDocumentOpening(store, 3);
    expect(store.getState().openingDocument).toBeNull();
  });

  it("installs a document and clears its opening in one publication", () => {
    let store = createWorkspaceAppStore();
    publishWorkspaceDocumentOpening(store, { intentId: 1, path: "b.md" });
    let snapshots = recordSnapshots(store);
    let next = publishDocument(store, "b.md", "# B");

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      collabDocument: next.document,
      editorDocument: { path: next.file.path, value: next.document.value },
      openingDocument: null,
      saveState: "saved",
      selectedFile: next.file,
      singleFileSource: null,
      treeSelection: next.file,
    });
  });

  it("clears the active view in one publication", () => {
    let store = createWorkspaceAppStore();
    publishDocument(store, "a.md", "# A");
    publishWorkspaceDocumentOpening(store, { intentId: 2, path: "b.md" });
    let snapshots = recordSnapshots(store);

    clearWorkspaceDocumentView(store);

    expect(snapshots).toHaveLength(1);
    expect(store.getState()).toMatchObject({
      collabDocument: null,
      editorDocument: { path: "", value: "" },
      openingDocument: null,
      saveState: "idle",
      selectedFile: null,
      singleFileSource: null,
      treeSelection: null,
    });
  });
});

function publishDocument(store: WorkspaceAppStore, path: string, value: string) {
  let file = { kind: "file" as const, name: path, path } satisfies MarkdownFileNode;
  let document = { docId: "test:" + path, path, value } as CollabDocumentState;
  publishWorkspaceDocumentView(store, { document, file, saveState: "saved", value });
  return { document, file };
}

function recordSnapshots(store: WorkspaceAppStore) {
  let snapshots: WorkspaceAppState[] = [];
  store.subscribe((snapshot) => snapshots.push(snapshot));
  return snapshots;
}
