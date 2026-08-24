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
    expect(store.getState().errorMessage).toBe("First error");

    setErrorMessage((current) => `${current}; second error`);
    expect(store.getState().errorMessage).toBe("First error; second error");
  });

  it("keeps A active while B is opening", () => {
    let store = createWorkspaceAppStore();
    let file = createFile("notes/a.md");
    let document = createDocument(file.path, "# A");
    publishWorkspaceDocumentView(store, {
      document,
      file,
      saveState: "saved",
      value: document.value,
    });
    let snapshots = recordSnapshots(store);

    publishWorkspaceDocumentOpening(store, { intentId: 2, path: "notes/b.md" }, "# A edited");

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.collabDocument).toBe(document);
    expect(snapshots[0]?.selectedFile).toBe(file);
    expect(snapshots[0]).toMatchObject({
      collabDocument: document,
      editorDocument: {
        path: file.path,
        value: "# A edited",
        version: 1,
      },
      openingDocument: { intentId: 2, path: "notes/b.md" },
      saveState: "saved",
      selectedFile: file,
      singleFileSource: null,
      treeSelection: {
        kind: "file",
        name: file.name,
        path: file.path,
      },
    });
  });

  it("does not let a stale finish clear a newer opening intent", () => {
    let store = createWorkspaceAppStore();
    publishWorkspaceDocumentOpening(store, { intentId: 2, path: "notes/b.md" });
    publishWorkspaceDocumentOpening(store, { intentId: 3, path: "notes/c.md" });
    let snapshots = recordSnapshots(store);

    clearWorkspaceDocumentOpening(store, 2);

    expect(snapshots).toHaveLength(0);
    expect(store.getState().openingDocument).toEqual({ intentId: 3, path: "notes/c.md" });

    clearWorkspaceDocumentOpening(store, 3);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.openingDocument).toBeNull();
  });

  it("installs B and clears its opening state in one coherent snapshot", () => {
    let store = createWorkspaceAppStore();
    let currentFile = createFile("notes/a.md");
    let currentDocument = createDocument(currentFile.path, "# A");
    publishWorkspaceDocumentView(store, {
      document: currentDocument,
      file: currentFile,
      saveState: "saved",
      value: currentDocument.value,
    });
    let nextFile = createFile("notes/b.md");
    let nextDocument = createDocument(nextFile.path, "# B");
    publishWorkspaceDocumentOpening(store, { intentId: 2, path: nextFile.path });
    let snapshots = recordSnapshots(store);

    publishWorkspaceDocumentView(store, {
      document: nextDocument,
      file: nextFile,
      saveState: "pending",
      value: nextDocument.value,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.collabDocument).toBe(nextDocument);
    expect(snapshots[0]?.selectedFile).toBe(nextFile);
    expect(snapshots[0]).toMatchObject({
      collabDocument: nextDocument,
      editorDocument: {
        path: nextFile.path,
        value: nextDocument.value,
        version: 2,
      },
      openingDocument: null,
      saveState: "pending",
      selectedFile: nextFile,
      treeSelection: {
        kind: "file",
        name: nextFile.name,
        path: nextFile.path,
      },
    });
  });

  it("clears the document view with one atomic publication", () => {
    let store = createWorkspaceAppStore();
    let currentFile = createFile("notes/current.md");
    let currentDocument = createDocument(currentFile.path, "# Current");
    publishWorkspaceDocumentView(store, {
      document: currentDocument,
      file: currentFile,
      saveState: "saved",
      value: currentDocument.value,
    });
    publishWorkspaceDocumentOpening(store, { intentId: 2, path: "notes/next.md" });
    let snapshots = recordSnapshots(store);

    clearWorkspaceDocumentView(store);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      collabDocument: null,
      editorDocument: {
        path: "",
        value: "",
        version: 2,
      },
      openingDocument: null,
      saveState: "idle",
      selectedFile: null,
      singleFileSource: null,
      treeSelection: null,
    });
  });

  it("can clear the active view without clearing a newer opening intent", () => {
    let store = createWorkspaceAppStore();
    let currentFile = createFile("notes/a.md");
    let currentDocument = createDocument(currentFile.path, "# A");
    publishWorkspaceDocumentView(store, {
      document: currentDocument,
      file: currentFile,
      saveState: "saved",
      value: currentDocument.value,
    });
    publishWorkspaceDocumentOpening(store, { intentId: 3, path: "notes/c.md" });
    let snapshots = recordSnapshots(store);

    clearWorkspaceDocumentView(store, { preserveOpening: true });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      collabDocument: null,
      editorDocument: {
        path: "",
        value: "",
        version: 2,
      },
      openingDocument: { intentId: 3, path: "notes/c.md" },
      saveState: "idle",
      selectedFile: null,
      singleFileSource: null,
      treeSelection: null,
    });
  });
});

function recordSnapshots(store: WorkspaceAppStore) {
  let snapshots: WorkspaceAppState[] = [];
  store.subscribe((snapshot) => snapshots.push(snapshot));
  return snapshots;
}

function createFile(path: string): MarkdownFileNode {
  return {
    kind: "file",
    name: path.split("/").at(-1) ?? path,
    path,
  };
}

function createDocument(path: string, value: string): CollabDocumentState {
  return {
    docId: `test:${path}`,
    path,
    value,
  } as CollabDocumentState;
}
