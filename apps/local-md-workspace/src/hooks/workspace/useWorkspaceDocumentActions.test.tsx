// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWorkspaceApplication } from "@/app/workspace-application";
import {
  createWorkspaceAppSetters,
  type WorkspaceAppState,
  type WorkspaceAppStore,
} from "@/app/workspace-store";
import { resetBrowserCollabMemoryStoreForTests } from "@/lib/collaboration/collab-browser-store";
import { resetOwnerShareRecordStoreForTests } from "@/lib/collaboration/share-storage";
import type { AccessFileHandle } from "@/lib/workspace/file-system";
import { workspaceDocumentPersistenceCoordinator } from "@/lib/workspace/runtime/document-persistence-coordinator";
import { createLocalFileSource } from "@/lib/workspace/single-file";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import { createMemoryWorkspaceRuntime } from "@/test/memory-workspace-runtime";
import { useWorkspaceDocumentActions } from "./useWorkspaceDocumentActions";

type DocumentActions = ReturnType<typeof useWorkspaceDocumentActions>;
type DocumentActionOptions = Parameters<typeof useWorkspaceDocumentActions>[0];
type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let container: HTMLDivElement | null = null;
let fixture: ReturnType<typeof createDocumentActionsFixture> | null = null;
let indexedDbDescriptor: PropertyDescriptor | undefined;
let root: Root | null = null;
let runtime: ReturnType<typeof createMemoryWorkspaceRuntime> | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  indexedDbDescriptor = Object.getOwnPropertyDescriptor(window, "indexedDB");
  Object.defineProperty(window, "indexedDB", {
    configurable: true,
    value: undefined,
  });
  resetBrowserCollabMemoryStoreForTests();
  resetOwnerShareRecordStoreForTests();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(async () => {
  if (fixture?.api && fixture.options.collabDocumentRef.current) {
    await act(async () => {
      await fixture?.api?.closeActiveDocumentSession();
    });
  }
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
  if (indexedDbDescriptor) {
    Object.defineProperty(window, "indexedDB", indexedDbDescriptor);
  } else {
    Reflect.deleteProperty(window, "indexedDB");
  }
  vi.restoreAllMocks();
});

describe("useWorkspaceDocumentActions", () => {
  it("releases A before returning from B to save a replacement A session", async () => {
    let fileA = markdownFile("a.md");
    let fileB = markdownFile("b.md");
    runtime = createMemoryWorkspaceRuntime(
      [
        [fileA.path, "# A\n"],
        [fileB.path, "# B\n"],
      ],
      { id: "memory:document-actions-a-b-a" },
    );
    fixture = createDocumentActionsFixture();
    await renderFixture(fixture);

    await act(async () => {
      await fixture?.api?.loadFile(runtime!, fileA, { saveCurrent: false });
    });
    let firstDocumentA = fixture.options.collabDocumentRef.current;
    expect(firstDocumentA?.path).toBe(fileA.path);
    expect(fixture.store.getState()).toMatchObject({
      collabDocument: firstDocumentA,
      editorDocument: { path: fileA.path, value: "# A\n" },
      selectedFile: fileA,
    });
    let disposeFirstDocumentA = vi.spyOn(firstDocumentA!, "dispose");

    let firstSaveSucceeded = false;
    await act(async () => {
      firstSaveSucceeded = (await fixture?.api?.saveCurrentFile()) ?? false;
    });
    expect(firstSaveSucceeded).toBe(true);
    expect(
      workspaceDocumentPersistenceCoordinator.busy({
        path: fileA.path,
        workspaceId: runtime.identity.id,
      }),
    ).toBe(true);

    await act(async () => {
      await fixture?.api?.loadFile(runtime!, fileB);
    });
    expect(disposeFirstDocumentA).toHaveBeenCalledOnce();
    expect(
      workspaceDocumentPersistenceCoordinator.busy({
        path: fileA.path,
        workspaceId: runtime.identity.id,
      }),
    ).toBe(false);
    expect(fixture.store.getState()).toMatchObject({
      editorDocument: { path: fileB.path, value: "# B\n" },
      selectedFile: fileB,
    });

    await act(async () => {
      await fixture?.api?.loadFile(runtime!, fileA);
    });
    let replacementDocumentA = fixture.options.collabDocumentRef.current;
    expect(replacementDocumentA).not.toBe(firstDocumentA);
    expect(fixture.store.getState()).toMatchObject({
      collabDocument: replacementDocumentA,
      editorDocument: { path: fileA.path, value: "# A\n" },
      selectedFile: fileA,
    });

    let replacementSaveSucceeded = false;
    await act(async () => {
      replacementSaveSucceeded = (await fixture?.api?.saveCurrentFile()) ?? false;
    });
    expect(replacementSaveSucceeded).toBe(true);
    expect(fixture.store.getState()).toMatchObject({
      errorMessage: "",
      saveState: "saved",
    });
    expect(fixture.errorMessages).not.toContainEqual(
      expect.stringMatching(/another document session is still writing/i),
    );
  });

  it("keeps active A visible while a stale A candidate is superseded by B then replacement A", async () => {
    let fileA = markdownFile("a.md");
    let fileB = markdownFile("b.md");
    runtime = createMemoryWorkspaceRuntime(
      [
        [fileA.path, "# A\n"],
        [fileB.path, "# B\n"],
      ],
      { id: "memory:document-actions-concurrent-a-b-a" },
    );
    fixture = createDocumentActionsFixture();
    await renderFixture(fixture);
    await act(async () => {
      await fixture?.api?.loadFile(runtime!, fileA, { saveCurrent: false });
    });

    let firstSessionA = fixture.application.documents.current();
    expect(firstSessionA?.file.path).toBe(fileA.path);

    let slowAObserveStarted = createTestGate();
    let releaseSlowAObserve = createTestGate();
    let originalObserve = runtime.documents.observe.bind(runtime.documents);
    let blockNextAObserve = true;
    vi.spyOn(runtime.documents, "observe").mockImplementation(async (path) => {
      if (path == fileA.path && blockNextAObserve) {
        blockNextAObserve = false;
        slowAObserveStarted.open();
        await releaseSlowAObserve.promise;
      }
      return originalObserve(path);
    });

    let staleARequest: Promise<boolean> = Promise.resolve(false);
    try {
      act(() => {
        staleARequest = fixture!.api!.loadFile(runtime!, fileA, { saveCurrent: false });
      });
      await slowAObserveStarted.promise;

      expect(fixture.application.documents.current()).toBe(firstSessionA);
      expect(fixture.store.getState()).toMatchObject({
        collabDocument: firstSessionA?.collabDocument,
        editorDocument: { path: fileA.path, value: "# A\n" },
        openingDocument: { path: fileA.path },
        selectedFile: fileA,
      });

      let loadedB = false;
      await act(async () => {
        loadedB = await fixture!.api!.loadFile(runtime!, fileB, { saveCurrent: false });
      });
      expect(loadedB).toBe(true);
      let sessionB = fixture.application.documents.current();
      expect(sessionB?.file.path).toBe(fileB.path);

      let loadedReplacementA = false;
      await act(async () => {
        loadedReplacementA = await fixture!.api!.loadFile(runtime!, fileA, {
          saveCurrent: false,
        });
      });
      expect(loadedReplacementA).toBe(true);
      let replacementSessionA = fixture.application.documents.current();
      expect(replacementSessionA?.file.path).toBe(fileA.path);
      expect(replacementSessionA).not.toBe(firstSessionA);
      expect(replacementSessionA).not.toBe(sessionB);

      let staleFinishSnapshots: WorkspaceAppState[] = [];
      let unsubscribe = fixture.store.subscribe((snapshot) => staleFinishSnapshots.push(snapshot));
      let staleAResult = true;
      await act(async () => {
        releaseSlowAObserve.open();
        staleAResult = await staleARequest!;
      });
      unsubscribe();

      expect(staleAResult).toBe(false);
      expect(staleFinishSnapshots).toHaveLength(0);
      expect(fixture.application.documents.current()).toBe(replacementSessionA);
      expect(fixture.store.getState()).toMatchObject({
        collabDocument: replacementSessionA?.collabDocument,
        editorDocument: { path: fileA.path, value: "# A\n" },
        openingDocument: null,
        selectedFile: fileA,
      });
    } finally {
      releaseSlowAObserve.open();
      await Promise.allSettled([staleARequest]);
    }
  });

  it("finishes a gated save against immutable A while B retires the active session", async () => {
    let fileA = markdownFile("a.md");
    let fileB = markdownFile("b.md");
    runtime = createMemoryWorkspaceRuntime(
      [
        [fileA.path, "# A\n"],
        [fileB.path, "# B\n"],
      ],
      { id: "memory:document-actions-immutable-save" },
    );
    fixture = createDocumentActionsFixture();
    await renderFixture(fixture);
    await act(async () => {
      await fixture?.api?.loadFile(runtime!, fileA, { saveCurrent: false });
    });

    let sessionA = fixture.application.documents.current();
    expect(sessionA?.file.path).toBe(fileA.path);
    let text = sessionA!.collabDocument.doc.getText("markdown");
    text.insert(text.toString().length, "Saved while switching.\n");
    sessionA!.collabDocument.doc.commit();
    let editedA = text.toString();
    text.free();
    act(() => fixture!.api!.handleEditorInput(editedA));
    fixture.options.autoSaveTaskRef.current?.task.cancel();

    let saveObserveStarted = createTestGate();
    let releaseSaveObserve = createTestGate();
    let originalObserve = runtime.documents.observe.bind(runtime.documents);
    let blockNextAObserve = true;
    vi.spyOn(runtime.documents, "observe").mockImplementation(async (path) => {
      if (path == fileA.path && blockNextAObserve) {
        blockNextAObserve = false;
        saveObserveStarted.open();
        await releaseSaveObserve.promise;
      }
      return originalObserve(path);
    });

    let documentDisposeStarted = createTestGate();
    let releaseDocumentDispose = createTestGate();
    let originalDispose = sessionA!.collabDocument.dispose.bind(sessionA!.collabDocument);
    vi.spyOn(sessionA!.collabDocument, "dispose").mockImplementation(async () => {
      await originalDispose();
      documentDisposeStarted.open();
      await releaseDocumentDispose.promise;
    });
    let schedulePersistence = vi.spyOn(workspaceDocumentPersistenceCoordinator, "schedule");

    let saveRequest: Promise<boolean> = Promise.resolve(false);
    let loadBRequest: Promise<boolean> = Promise.resolve(false);
    try {
      act(() => {
        saveRequest = fixture!.api!.saveCurrentFile();
      });
      await saveObserveStarted.promise;
      expect(schedulePersistence).toHaveBeenCalledWith(
        expect.objectContaining({
          epoch: sessionA!.epoch,
          path: fileA.path,
          sessionId: sessionA!.collabDocument.docId,
          workspaceId: runtime.identity.id,
        }),
      );

      let activeARetired = waitForStoreState(
        fixture.store,
        (state) => state.collabDocument == null && state.openingDocument?.path == fileB.path,
      );
      act(() => {
        loadBRequest = fixture!.api!.loadFile(runtime!, fileB, { saveCurrent: false });
      });
      await activeARetired;

      expect(fixture.application.documents.current()).toBeNull();
      expect(fixture.options.collabDocumentRef.current).toBeNull();
      expect(fixture.options.selectedFileRef.current).toBeNull();
      expect(fixture.options.selectedFileSourceRef.current).toBeNull();
      expect(fixture.options.editorValueRef.current).toBe("");
      expect(fixture.options.cleanValueRef.current).toBe("");
      expect(fixture.options.saveStateRef.current).toBe("idle");

      let saveSucceeded = false;
      await act(async () => {
        releaseSaveObserve.open();
        saveSucceeded = await saveRequest!;
        await documentDisposeStarted.promise;
      });

      expect(saveSucceeded).toBe(true);
      expect(runtime.files.get(fileA.path)).toBe(editedA);
      expect(runtime.files.get(fileB.path)).toBe("# B\n");
      expect(fixture.options.sendHostSaveAck).toHaveBeenCalledWith(
        runtime,
        fileA.path,
        editedA,
        expect.anything(),
      );
      expect(fixture.options.editorValueRef.current).toBe("");
      expect(fixture.options.cleanValueRef.current).toBe("");
      expect(fixture.options.dirtyRef.current).toBe(false);
      expect(fixture.options.saveStateRef.current).toBe("idle");
      expect(fixture.store.getState()).toMatchObject({
        collabDocument: null,
        editorDocument: { path: "", value: "" },
        openingDocument: { path: fileB.path },
        saveState: "idle",
        selectedFile: null,
      });

      let loadedB = false;
      await act(async () => {
        releaseDocumentDispose.open();
        loadedB = await loadBRequest!;
      });

      expect(loadedB).toBe(true);
      expect(fixture.application.documents.current()?.file.path).toBe(fileB.path);
      expect(fixture.store.getState()).toMatchObject({
        editorDocument: { path: fileB.path, value: "# B\n" },
        openingDocument: null,
        saveState: "saved",
        selectedFile: fileB,
      });
    } finally {
      releaseSaveObserve.open();
      releaseDocumentDispose.open();
      await Promise.allSettled([saveRequest, loadBRequest]);
    }
  });

  it("preserves a dirty standalone editor snapshot when opening a workspace file aborts", async () => {
    let standaloneFile = markdownFile("Draft.md");
    let standaloneSource = {
      id: "standalone:dirty-abort",
      kind: "standalone" as const,
      readFile: vi.fn(async () => "# Initial\n"),
      writeFile: vi.fn(async () => {
        throw new Error("standalone save failed");
      }),
    };
    runtime = createMemoryWorkspaceRuntime([["workspace.md", "# Workspace\n"]], {
      id: "memory:document-actions-dirty-standalone",
    });
    fixture = createDocumentActionsFixture();
    await renderFixture(fixture);
    let standaloneIntent = fixture.application.documents.begin(standaloneFile.path, {
      activeValue: fixture.options.editorValueRef.current,
    });
    let activatedStandalone = false;
    await act(async () => {
      activatedStandalone = await fixture!.api!.activateSingleFileDocument(
        { draftId: "dirty-abort", kind: "draft", name: standaloneFile.name },
        standaloneSource,
        standaloneFile,
        "# Initial\n",
        { intent: standaloneIntent },
      );
    });
    expect(activatedStandalone).toBe(true);

    let dirtyValue = "# Unsaved standalone edit\n";
    act(() => fixture!.api!.handleEditorInput(dirtyValue));
    let workspaceFile = markdownFile("workspace.md");
    let loadedWorkspace = true;
    await act(async () => {
      loadedWorkspace = await fixture!.api!.loadFile(runtime!, workspaceFile);
    });

    expect(loadedWorkspace).toBe(false);
    expect(standaloneSource.writeFile).toHaveBeenCalledWith(dirtyValue);
    expect(fixture.options.editorValueRef.current).toBe(dirtyValue);
    expect(fixture.store.getState()).toMatchObject({
      collabDocument: null,
      editorDocument: { path: standaloneFile.path, value: dirtyValue },
      openingDocument: null,
      selectedFile: standaloneFile,
      singleFileSource: { draftId: "dirty-abort", kind: "draft" },
    });
  });

  it("retains the exact local file handle passed through standalone activation", async () => {
    fixture = createDocumentActionsFixture();
    await renderFixture(fixture);
    let previousHandle = createAccessFileHandle("previous.md");
    let localHandle = createAccessFileHandle("local.md");
    fixture.options.localFileHandleRef.current = previousHandle;
    let source = createLocalFileSource(localHandle);
    let file = markdownFile(localHandle.name);
    let localFileIntent = fixture.application.documents.begin(file.path, {
      activeValue: fixture.options.editorValueRef.current,
    });

    let activated = false;
    await act(async () => {
      activated = await fixture!.api!.activateSingleFileDocument(
        { kind: "local-file", name: localHandle.name },
        source,
        file,
        "# Local\n",
        { intent: localFileIntent, localFileHandle: localHandle },
      );
    });

    expect(activated).toBe(true);
    expect(fixture.options.localFileHandleRef.current).toBe(localHandle);
    expect(fixture.options.localFileHandleRef.current).not.toBe(previousHandle);
    expect(fixture.options.selectedFileSourceRef.current).toBe(source);
    expect(fixture.store.getState()).toMatchObject({
      editorDocument: { path: file.path, value: "# Local\n" },
      selectedFile: file,
      singleFileSource: { kind: "local-file", name: localHandle.name },
    });
  });

  it("publishes a complete document clear as one Zustand snapshot", async () => {
    let file = markdownFile("clear.md");
    runtime = createMemoryWorkspaceRuntime([[file.path, "# Clear\n"]], {
      id: "memory:document-actions-clear",
    });
    fixture = createDocumentActionsFixture();
    await renderFixture(fixture);
    await act(async () => {
      await fixture?.api?.loadFile(runtime!, file, { saveCurrent: false });
    });

    let snapshots: WorkspaceAppState[] = [];
    let unsubscribe = fixture.store.subscribe((snapshot) => snapshots.push(snapshot));
    await act(async () => {
      await fixture?.api?.clearActiveDocument();
    });
    unsubscribe();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      collabDocument: null,
      editorDocument: { path: "", value: "", version: 2 },
      saveState: "idle",
      selectedFile: null,
      singleFileSource: null,
      treeSelection: null,
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
  let errorMessages: string[] = [];
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
    sendHostDocumentUpdate: vi.fn(),
    sendHostSaveAck: vi.fn(),
    setActiveShareRecord: vi.fn(),
    setCreatedShare: vi.fn(),
    setEditorDocument: setters.setEditorDocument,
    setErrorMessage(message) {
      errorMessages.push(message);
      setters.setErrorMessage(message);
    },
    setRetryLoadPath: setters.setRetryLoadPath,
    setSaveStateSynced(nextState) {
      saveStateRef.current = nextState;
      setters.setSaveState(nextState);
    },
    singleFileSourceRef: { current: null },
    startOwnerShareHost: vi.fn(async () => {}),
    stopOwnerShareHost: vi.fn(),
    workspaceAppStore: store,
  };

  return {
    application,
    api: null as DocumentActions | null,
    errorMessages,
    options,
    store,
  };
}

function markdownFile(path: string): MarkdownFileNode {
  return { kind: "file", name: path, path };
}

type TestGate = {
  open(): void;
  promise: Promise<void>;
};

function createTestGate(): TestGate {
  let open!: () => void;
  let opened = false;
  let promise = new Promise<void>((resolve) => {
    open = () => {
      if (opened) return;
      opened = true;
      resolve();
    };
  });
  return { open, promise };
}

function waitForStoreState(
  store: WorkspaceAppStore,
  predicate: (state: WorkspaceAppState) => boolean,
) {
  let current = store.getState();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise<WorkspaceAppState>((resolve) => {
    let unsubscribe = store.subscribe((state) => {
      if (!predicate(state)) return;
      unsubscribe();
      resolve(state);
    });
  });
}

function createAccessFileHandle(name: string): AccessFileHandle {
  return {
    async createWritable() {
      return {
        close: vi.fn(async () => {}),
        write: vi.fn(async () => {}),
      };
    },
    async getFile() {
      return new File([], name, { type: "text/markdown" });
    },
    kind: "file",
    name,
  };
}
