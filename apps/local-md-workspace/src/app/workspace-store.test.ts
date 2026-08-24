import { describe, expect, it } from "vite-plus/test";
import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import {
  beginWorkspaceDocumentTransition,
  clearWorkspaceDocumentView,
  createWorkspaceAppSetters,
  createWorkspaceAppStore,
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

  it("publishes one coherent workspace document snapshot", () => {
    let store = createWorkspaceAppStore();
    let file = createFile("notes/next.md");
    let document = createDocument(file.path, "# Next");
    let snapshots = recordSnapshots(store);

    publishWorkspaceDocumentView(store, {
      document,
      file,
      saveState: "pending",
      value: document.value,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.collabDocument).toBe(document);
    expect(snapshots[0]?.selectedFile).toBe(file);
    expect(snapshots[0]).toMatchObject({
      collabDocument: document,
      editorDocument: {
        path: file.path,
        value: document.value,
        version: 1,
      },
      saveState: "pending",
      selectedFile: file,
      singleFileSource: null,
      treeSelection: {
        kind: "file",
        name: file.name,
        path: file.path,
      },
    });
  });

  it("begins a document transition with one atomic publication", () => {
    let store = createWorkspaceAppStore();
    let currentFile = createFile("notes/current.md");
    let currentDocument = createDocument(currentFile.path, "# Current");
    publishWorkspaceDocumentView(store, {
      document: currentDocument,
      file: currentFile,
      saveState: "saved",
      value: currentDocument.value,
    });
    let snapshots = recordSnapshots(store);

    beginWorkspaceDocumentTransition(store, "notes/next.md");

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      collabDocument: null,
      editorDocument: {
        path: "notes/next.md",
        value: "",
        version: 2,
      },
      saveState: "saved",
      selectedFile: null,
      treeSelection: {
        kind: "file",
        name: currentFile.name,
        path: currentFile.path,
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
