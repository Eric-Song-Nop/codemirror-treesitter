import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceCollaborativeDocument } from "@/lib/workspace/documents";
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

  it("keeps the selected document while its replacement is loading", () => {
    let store = createWorkspaceAppStore();
    let selected = publishDocument(store, "a.md", "# A");

    publishWorkspaceDocumentOpening(store, { path: "b.md" }, "# A edited");
    publishWorkspaceDocumentOpening(store, { path: "c.md" });

    expect(store.getState()).toMatchObject({
      collabDocument: selected.document,
      editorDocument: { path: selected.file.path, value: "# A edited" },
      openingDocument: { path: "c.md" },
      selectedFile: selected.file,
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
    expect(snapshots[0]).toMatchObject({
      collabDocument: next.document,
      editorDocument: { path: next.file.path, value: next.value },
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
  let document = { docId: "test:" + path, path } as WorkspaceCollaborativeDocument;
  publishWorkspaceDocumentView(store, { document, file, saveState: "saved", value });
  return { document, file, value };
}

function recordSnapshots(store: WorkspaceAppStore) {
  let snapshots: WorkspaceAppState[] = [];
  store.subscribe((snapshot) => snapshots.push(snapshot));
  return snapshots;
}
