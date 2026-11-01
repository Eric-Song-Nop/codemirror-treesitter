// @vitest-environment happy-dom

import { act } from "react";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWorkspaceApplication } from "@/app/workspace-application";
import { workspaceLiveObjects } from "@/app/workspace-store";
import { resetBrowserCollabMemoryStoreForTests } from "@/lib/collaboration/collab-browser-store";
import { resetOwnerShareRecordStoreForTests } from "@/lib/collaboration/share-storage";
import type { AccessFileHandle } from "@/lib/workspace/file-system";
import { createLocalFileSource } from "@/lib/workspace/single-file";
import { WorkspaceStorageError } from "@/lib/workspace/storage/types";
import type { WorkspaceHostPermission } from "@/lib/workspace/runtime/types";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import { createMemoryWorkspaceRuntime } from "@/test/memory-workspace-runtime";
import { WorkspaceEditorSession } from "./workspace-editor-session";

type ReactActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

let fixture: ReturnType<typeof createDocumentActionsFixture> | null = null;
let runtime: ReturnType<typeof createMemoryWorkspaceRuntime> | null = null;
let testGates = new Set<{ open(): void }>();

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubGlobal("indexedDB", undefined);
  resetBrowserCollabMemoryStoreForTests();
  resetOwnerShareRecordStoreForTests();
});

afterEach(async () => {
  for (let gate of testGates) gate.open();
  testGates.clear();
  fixture?.options.autoSaveTaskRef.current?.task.dispose();
  await fixture?.application.dispose();
  await runtime?.dispose();
  runtime = null;
  fixture = null;
  resetBrowserCollabMemoryStoreForTests();
  resetOwnerShareRecordStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkspaceEditorSession document actions", () => {
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
    await act(async () => {
      await fixture?.api?.loadFile(runtime!, fileA, { saveCurrent: false });
      expect(await fixture?.api?.saveCurrentFile()).toBe(true);
    });

    let firstA = fixture.application.documentViews.current()!.collabDocument;
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

    let reopenedA = fixture.application.documentViews.current()!;
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
    await act(async () => {
      await fixture?.api?.loadFile(runtime!, fileA, { saveCurrent: false });
    });

    let documentA = fixture.application.documentViews.current()!.collabDocument;
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
    expect(fixture.application.documentViews.current()?.file.path).toBe(fileB.path);

    releaseSave.open();
    await act(async () => {
      await saveRequest;
    });

    expect(runtime.files.get(fileA.path)).toBe(editedA);
    expect(runtime.files.get(fileB.path)).toBe("# B\\n");
    expect(fixture.options.editorValueRef.current).toBe("# B\\n");
  });

  it("keeps remote and external changes flowing for an unselected document", async () => {
    let fileA = markdownFile("a.md");
    let fileB = markdownFile("b.md");
    runtime = createMemoryWorkspaceRuntime(
      [
        [fileA.path, "# A\n"],
        [fileB.path, "# B\n"],
      ],
      { id: "memory:document-actions-unselected-updates" },
    );
    fixture = createDocumentActionsFixture();
    await act(async () => {
      await fixture!.api!.loadFile(runtime!, fileA, { saveCurrent: false });
    });
    let documentA = fixture.application.documentViews.current()!.collabDocument;
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

    expect(fixture.application.documentViews.current()?.file.path).toBe(fileB.path);
    expect(runtime.files.get(fileA.path)).toBe("# A\nRemote.\n");

    runtime.files.set(fileA.path, "# External\n");
    await documentA.importExternalChange();

    expect(fixture.application.documentViews.current()?.file.path).toBe(fileB.path);
    expect(documentA.read()).toBe("# External\n");
    await act(async () => {
      await fixture!.api!.loadFile(runtime!, fileA, { saveCurrent: false });
    });
    expect(fixture.application.documentViews.current()!.collabDocument).toBe(documentA);
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
    let signal = fixture.application.documentViews.begin(standaloneFile.path);
    await act(async () => {
      await fixture!.api!.activateSingleFileDocument(
        { kind: "local-file", name: standaloneFile.name },
        standaloneSource,
        standaloneFile,
        "# Initial\\n",
        { signal, localFileHandle: handle },
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
      editorDocument: { path: standaloneFile.path },
      selectedFile: standaloneFile,
    });
    expect(workspaceLiveObjects(fixture.store).editorValue).toBe(dirtyValue);
  });

  it("re-grants folder access and resumes the selected document's failed save", async () => {
    let file = markdownFile("note.md");
    runtime = createMemoryWorkspaceRuntime([[file.path, "# Note\n"]], {
      id: "memory:session-regrant",
    });
    let permissionState: PermissionState = "granted";
    let listeners = new Set<(state: PermissionState) => void>();
    let setPermission = (state: PermissionState) => {
      permissionState = state;
      for (let listener of listeners) listener(state);
    };
    let request = vi.fn(async () => {
      setPermission("granted");
      return permissionState;
    });
    let permission: WorkspaceHostPermission = {
      get state() {
        return permissionState;
      },
      check: vi.fn(async () => permissionState),
      request,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    runtime.host.permission = permission;
    fixture = createDocumentActionsFixture();
    await act(async () => {
      await fixture!.session.replaceWorkspaceRuntime(runtime!);
      await fixture!.api!.loadFile(runtime!, file, { saveCurrent: false });
    });

    let document = fixture.application.documentViews.current()!.collabDocument;
    vi.spyOn(runtime.documentSource, "commit").mockRejectedValueOnce(
      new WorkspaceStorageError({ code: "permission-denied", message: "Access revoked." }),
    );
    document.edit([{ expectedText: "", from: 7, insert: "Edited.\n", to: 7 }]);
    await act(async () => {
      await document.flush().catch(() => {});
      setPermission("denied");
    });
    expect(fixture.store.getState()).toMatchObject({
      saveState: "error",
      workspacePermission: "denied",
    });

    let resume = vi.spyOn(document, "importExternalChange");
    let resumed = false;
    await act(async () => {
      resumed = await fixture!.session.regrantWorkspaceAccess();
    });

    expect(resumed).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(runtime.files.get(file.path)).toBe("# Note\nEdited.\n");
    expect(fixture.store.getState()).toMatchObject({
      errorMessage: "",
      saveState: "saved",
      workspacePermission: "granted",
    });
  });
});

function createDocumentActionsFixture() {
  let application = createWorkspaceApplication();
  let store = application.store;
  let session = new WorkspaceEditorSession({
    documentViews: application.documentViews,
    effectRuntime: application.runtime,
    store,
  });
  session.connectShareHost({
    setActiveShareRecord: vi.fn(),
    setCreatedShare: vi.fn(),
    startOwnerShareHost: vi.fn(async () => {}),
  });
  return {
    api: session as WorkspaceEditorSession | null,
    application,
    options: session.refs,
    session,
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
