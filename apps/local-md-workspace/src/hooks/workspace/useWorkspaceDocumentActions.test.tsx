// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWorkspaceApplication } from "@/app/workspace-application";
import { createWorkspaceAppSetters } from "@/app/workspace-store";
import { resetBrowserCollabMemoryStoreForTests } from "@/lib/collaboration/collab-browser-store";
import { resetOwnerShareRecordStoreForTests } from "@/lib/collaboration/share-storage";
import type { AccessFileHandle } from "@/lib/workspace/file-system";
import { createLocalFileSource } from "@/lib/workspace/single-file";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import { createMemoryWorkspaceRuntime } from "@/test/memory-workspace-runtime";
import { useWorkspaceDocumentActions } from "./useWorkspaceDocumentActions";

type DocumentActions = ReturnType<typeof useWorkspaceDocumentActions>;
type DocumentActionOptions = Parameters<typeof useWorkspaceDocumentActions>[0];
type ReactActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

let container: HTMLDivElement | null = null;
let fixture: ReturnType<typeof createDocumentActionsFixture> | null = null;
let root: Root | null = null;
let runtime: ReturnType<typeof createMemoryWorkspaceRuntime> | null = null;
let testGates = new Set<{ open(): void }>();

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubGlobal("indexedDB", undefined);
  resetBrowserCollabMemoryStoreForTests();
  resetOwnerShareRecordStoreForTests();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(async () => {
  for (let gate of testGates) gate.open();
  testGates.clear();
  fixture?.options.autoSaveTaskRef.current?.task.dispose();
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  await fixture?.application.dispose();
  await runtime?.dispose();
  runtime = null;
  container?.remove();
  container = null;
  fixture = null;
  resetBrowserCollabMemoryStoreForTests();
  resetOwnerShareRecordStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useWorkspaceDocumentActions", () => {
  it("reuses the same collaborative document across A, B, then A selection", async () => {
    let fileA = markdownFile("a.md");
    let fileB = markdownFile("b.md");
    runtime = createMemoryWorkspaceRuntime(
      [
        [fileA.path, "# A\\n"],
        [fileB.path, "# B\\n"],
      ],
      { id: "memory:document-actions-a-b-a" },
    );
    fixture = createDocumentActionsFixture();
    await renderFixture(fixture);
    await act(async () => {
      await fixture?.api?.loadFile(runtime!, fileA, { saveCurrent: false });
      expect(await fixture?.api?.saveCurrentFile()).toBe(true);
    });

    let firstA = fixture.application.documents.current()!.collabDocument;
    let freeA = vi.spyOn(firstA.loroDoc, "free");
    let originalValue = firstA.read();
    firstA.edit([
      {
        expectedText: "",
        from: originalValue.length,
        insert: "Edited before switching.\n",
        to: originalValue.length,
      },
    ]);

    await act(async () => {
      expect(await fixture!.api!.loadFile(runtime!, fileB, { saveCurrent: false })).toBe(true);
      expect(await fixture!.api!.loadFile(runtime!, fileA, { saveCurrent: false })).toBe(true);
    });

    let reopenedA = fixture.application.documents.current()!;
    expect(reopenedA.collabDocument).toBe(firstA);
    expect(reopenedA.collabDocument.read()).toBe("# A\\nEdited before switching.\n");
    expect(freeA).not.toHaveBeenCalled();
  });

  it("selects B without waiting for A's in-flight materialization", async () => {
    let fileA = markdownFile("a.md");
    let fileB = markdownFile("b.md");
    runtime = createMemoryWorkspaceRuntime(
      [
        [fileA.path, "# A\\n"],
        [fileB.path, "# B\\n"],
      ],
      { id: "memory:document-actions-immutable-save" },
    );
    fixture = createDocumentActionsFixture();
    await renderFixture(fixture);
    await act(async () => {
      await fixture?.api?.loadFile(runtime!, fileA, { saveCurrent: false });
    });

    let documentA = fixture.application.documents.current()!.collabDocument;
    let valueA = documentA.read();
    documentA.edit([
      {
        expectedText: "",
        from: valueA.length,
        insert: "Saved while switching.\\n",
        to: valueA.length,
      },
    ]);
    let editedA = documentA.read();

    let saveStarted = createTestGate();
    let releaseSave = createTestGate();
    let originalObserve = runtime.documentSource.observe.bind(runtime.documentSource);
    vi.spyOn(runtime.documentSource, "observe").mockImplementationOnce(async (path) => {
      saveStarted.open();
      await releaseSave.promise;
      return originalObserve(path);
    });

    let saveRequest = documentA.flush();
    await saveStarted.promise;
    await act(async () => {
      expect(await fixture!.api!.loadFile(runtime!, fileB, { saveCurrent: false })).toBe(true);
    });
    expect(fixture.application.documents.current()?.file.path).toBe(fileB.path);

    releaseSave.open();
    await act(async () => {
      await saveRequest;
    });

    expect(runtime.files.get(fileA.path)).toBe(editedA);
    expect(runtime.files.get(fileB.path)).toBe("# B\\n");
    expect(fixture.options.editorValueRef.current).toBe("# B\\n");
  });

  it("keeps remote and external changes active for an unselected document", async () => {
    let fileA = markdownFile("a.md");
    let fileB = markdownFile("b.md");
    runtime = createMemoryWorkspaceRuntime(
      [
        [fileA.path, "# A\n"],
        [fileB.path, "# B\n"],
      ],
      { id: "memory:document-actions-inactive-updates" },
    );
    fixture = createDocumentActionsFixture();
    await renderFixture(fixture);
    await act(async () => {
      await fixture!.api!.loadFile(runtime!, fileA, { saveCurrent: false });
    });
    let documentA = fixture.application.documents.current()!.collabDocument;
    await act(async () => {
      await fixture!.api!.loadFile(runtime!, fileB, { saveCurrent: false });
    });

    let remote = new LoroDoc();
    let from = documentA.loroDoc.oplogVersion();
    remote.import(documentA.loroDoc.export({ mode: "snapshot" }));
    let remoteText = remote.getText("markdown");
    remoteText.insert(remoteText.toString().length, "Remote.\n");
    remote.commit();
    documentA.applyRemoteUpdate(remote.export({ from, mode: "update" }));
    remoteText.free();
    from.free();
    remote.free();
    await documentA.flush();

    expect(fixture.application.documents.current()?.file.path).toBe(fileB.path);
    expect(runtime.files.get(fileA.path)).toBe("# A\nRemote.\n");

    runtime.files.set(fileA.path, "# External\n");
    await documentA.importExternalChange();

    expect(fixture.application.documents.current()?.file.path).toBe(fileB.path);
    expect(documentA.read()).toBe("# External\n");
    await act(async () => {
      await fixture!.api!.loadFile(runtime!, fileA, { saveCurrent: false });
    });
    expect(fixture.application.documents.current()!.collabDocument).toBe(documentA);
    expect(fixture.options.editorValueRef.current).toBe("# External\n");
  });

  it("preserves a dirty local file and its handle when opening a workspace file aborts", async () => {
    let write = vi.fn(async () => {
      throw new Error("local file save failed");
    });
    let handle = createAccessFileHandle("Draft.md", write);
    let standaloneFile = markdownFile(handle.name);
    let standaloneSource = createLocalFileSource(handle);
    runtime = createMemoryWorkspaceRuntime([["workspace.md", "# Workspace\\n"]], {
      id: "memory:document-actions-dirty-standalone",
    });
    fixture = createDocumentActionsFixture();
    await renderFixture(fixture);
    let intent = fixture.application.documents.begin(standaloneFile.path);
    await act(async () => {
      await fixture!.api!.activateSingleFileDocument(
        { kind: "local-file", name: standaloneFile.name },
        standaloneSource,
        standaloneFile,
        "# Initial\\n",
        { intent, localFileHandle: handle },
      );
    });

    let dirtyValue = "# Unsaved standalone edit\\n";
    act(() => fixture!.api!.handleEditorInput(dirtyValue));
    let loaded = true;
    await act(async () => {
      loaded = await fixture!.api!.loadFile(runtime!, markdownFile("workspace.md"));
    });

    expect(loaded).toBe(false);
    expect(write).toHaveBeenCalledWith(dirtyValue);
    expect(fixture.options.editorValueRef.current).toBe(dirtyValue);
    expect(fixture.options.localFileHandleRef.current).toBe(handle);
    expect(fixture.options.selectedFileSourceRef.current).toBe(standaloneSource);
    expect(fixture.options.singleFileSourceRef.current).toMatchObject({ kind: "local-file" });
    expect(fixture.store.getState()).toMatchObject({
      editorDocument: { path: standaloneFile.path, value: dirtyValue },
      selectedFile: standaloneFile,
    });
  });
});

async function renderFixture(nextFixture: ReturnType<typeof createDocumentActionsFixture>) {
  await act(async () => {
    root?.render(<DocumentActionsHarness fixture={nextFixture} />);
  });
}

function DocumentActionsHarness({
  fixture: nextFixture,
}: {
  fixture: ReturnType<typeof createDocumentActionsFixture>;
}) {
  nextFixture.api = useWorkspaceDocumentActions(nextFixture.options);
  return null;
}

function createDocumentActionsFixture() {
  let application = createWorkspaceApplication();
  let store = application.store;
  let setters = createWorkspaceAppSetters(store);
  let saveStateRef: DocumentActionOptions["saveStateRef"] = { current: "idle" };
  let options: DocumentActionOptions = {
    activeDocumentGenerationRef: { current: 0 },
    autoSaveTaskRef: { current: null },
    cleanValueRef: { current: "" },
    collabDocumentRef: { current: null },
    documentSessions: application.documents,
    documentTargetGenerationRef: { current: 0 },
    dirtyRef: { current: false },
    editVersionRef: { current: 0 },
    editorValueRef: { current: "" },
    localFileHandleRef: { current: null },
    saveOperationRef: { current: 0 },
    saveStateRef,
    scheduleAutoSaveRef: { current: () => {} },
    selectedFileSourceRef: { current: null },
    selectedFileRef: { current: null },
    setActiveShareRecord: vi.fn(),
    setCreatedShare: vi.fn(),
    setEditorDocument: setters.setEditorDocument,
    setErrorMessage: setters.setErrorMessage,
    setRetryLoadPath: setters.setRetryLoadPath,
    setSaveStateSynced(nextState) {
      saveStateRef.current = nextState;
      setters.setSaveState(nextState);
    },
    singleFileSourceRef: { current: null },
    startOwnerShareHost: vi.fn(async () => {}),
    workspaceAppStore: store,
  };
  return {
    application,
    api: null as DocumentActions | null,
    options,
    store,
  };
}

function markdownFile(path: string): MarkdownFileNode {
  return { kind: "file", name: path, path };
}

function createTestGate() {
  let open!: () => void;
  let promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  let gate = { open, promise };
  testGates.add(gate);
  return gate;
}

function createAccessFileHandle(
  name: string,
  write: Awaited<ReturnType<AccessFileHandle["createWritable"]>>["write"] = vi.fn(async () => {}),
): AccessFileHandle {
  return {
    async createWritable() {
      return {
        close: vi.fn(async () => {}),
        write,
      };
    },
    async getFile() {
      return new File([], name, { type: "text/markdown" });
    },
    kind: "file",
    name,
  };
}
