// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createWorkspaceAppSetters,
  createWorkspaceAppStore,
  type WorkspaceAppState,
} from "@/app/workspace-store";
import { resetBrowserCollabMemoryStoreForTests } from "@/lib/collaboration/collab-browser-store";
import { resetOwnerShareRecordStoreForTests } from "@/lib/collaboration/share-storage";
import { workspaceDocumentPersistenceCoordinator } from "@/lib/workspace/runtime/document-persistence-coordinator";
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
      editorDocument: { path: "", value: "", version: 3 },
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
  let store = createWorkspaceAppStore();
  let setters = createWorkspaceAppSetters(store);
  let errorMessages: string[] = [];
  let saveStateRef: DocumentActionOptions["saveStateRef"] = { current: "idle" };
  let options: DocumentActionOptions = {
    activeDocumentGenerationRef: { current: 0 },
    autoSaveTaskRef: { current: null },
    cleanValueRef: { current: "" },
    collabDocumentRef: { current: null },
    collabSyncCleanupRef: { current: () => {} },
    documentTargetGenerationRef: { current: 0 },
    dirtyRef: { current: false },
    editVersionRef: { current: 0 },
    editorValueRef: { current: "" },
    isOwnerShareHostPath: () => false,
    loadFileRequestRef: { current: 0 },
    localFileHandleRef: { current: null },
    saveOperationRef: { current: 0 },
    saveStateRef,
    scheduleAutoSaveRef: { current: () => {} },
    selectedFileSourceRef: { current: null },
    selectedFileRef: { current: null },
    sendHostDocumentUpdate: vi.fn(),
    sendHostSaveAck: vi.fn(),
    setActiveShareRecord: vi.fn(),
    setBusy: setters.setBusy,
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
    api: null as DocumentActions | null,
    errorMessages,
    options,
    store,
  };
}

function markdownFile(path: string): MarkdownFileNode {
  return { kind: "file", name: path, path };
}
