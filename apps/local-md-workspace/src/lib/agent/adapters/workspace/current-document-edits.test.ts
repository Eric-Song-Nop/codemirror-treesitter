// @vitest-environment happy-dom

import { liveMdLoroCollaboration, liveMdLoroUndo } from "@codemirror-treesitter/live-md-loro";
import { EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LoroDoc, UndoManager } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceAgentHost } from "../../application/host-port.ts";
import type { WorkspaceAgentReadRuntime } from "../../application/workspace-search.ts";
import type { WorkspaceAgentActiveDocumentVersion } from "../../domain/active-document.ts";
import type {
  WorkspaceAgentActiveEditor,
  WorkspaceAgentActiveEditorCapability,
} from "./active-editor.ts";
import { createWorkspaceAgentHost } from "./host.ts";

let mountedViews: EditorView[] = [];
let resourceCleanups: Array<() => void> = [];

afterEach(() => {
  for (let view of mountedViews) {
    let parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  }
  mountedViews = [];
  for (let cleanup of resourceCleanups.reverse()) cleanup();
  resourceCleanups = [];
});

describe("current-document Agent edit bridge", () => {
  it("resolves edits against one snapshot and dispatches one input.agent transaction", async () => {
    let editor = activeEditor("# Title\nfirst paragraph\nsecond paragraph");
    let host = createWorkspaceAgentHost({
      activeEditor: editor.capability,
      runtime: fakeRuntime(),
    });
    let version = await readVersion(host);

    let result = host.applyCurrentDocumentEdits({
      edits: [
        { newText: "updated second", oldText: "second paragraph" },
        { newText: "updated first", oldText: "first paragraph" },
      ],
      version,
    });

    expect(result).toEqual({
      appliedEdits: 2,
      outputBytes: 36,
      path: "draft.md",
      status: "applied",
    });
    expect(editor.view.state.doc.toString()).toBe("# Title\nupdated first\nupdated second");
    expect(editor.transactions).toEqual(["input.agent"]);
    expect(editor.state.editVersion).toBe(8);
  });

  it("supports a single exact insertion into an empty document", async () => {
    let editor = activeEditor("");
    let host = createWorkspaceAgentHost({
      activeEditor: editor.capability,
      runtime: fakeRuntime(),
    });
    let version = await readVersion(host);

    expect(
      host.applyCurrentDocumentEdits({
        edits: [{ newText: "# New document\n", oldText: "" }],
        version,
      }),
    ).toMatchObject({ appliedEdits: 1, status: "applied" });
    expect(editor.view.state.doc.toString()).toBe("# New document\n");
    expect(editor.transactions).toEqual(["input.agent"]);
  });

  it("flows through the main Loro peer as one local update and uses ordinary undo", async () => {
    let doc = new LoroDoc();
    let text = doc.getText("markdown");
    text.insert(0, "before");
    doc.commit();
    let undoManager = new UndoManager(doc, {});
    resourceCleanups.push(() => {
      undoManager.free();
      text.free();
      doc.free();
    });

    let localUpdates = 0;
    let unsubscribe = doc.subscribeLocalUpdates(() => localUpdates++);
    resourceCleanups.push(unsubscribe);
    let editor = activeEditor(
      "before",
      liveMdLoroCollaboration({ doc, text: "markdown", undoManager }),
    );
    await flushMicrotasks();
    localUpdates = 0;

    let host = createWorkspaceAgentHost({
      activeEditor: editor.capability,
      runtime: fakeRuntime(),
    });
    let version = await readVersion(host);
    expect(
      host.applyCurrentDocumentEdits({
        edits: [{ newText: "after", oldText: "before" }],
        version,
      }),
    ).toMatchObject({ status: "applied" });

    expect(editor.view.state.doc.toString()).toBe("after");
    expect(text.toString()).toBe("after");
    expect(localUpdates).toBe(1);
    expect(liveMdLoroUndo(editor.view)).toBe(true);
    await flushMicrotasks();
    expect(editor.view.state.doc.toString()).toBe("before");
    expect(text.toString()).toBe("before");
  });

  for (let testCase of [
    {
      edits: [{ newText: "unique", oldText: "same" }],
      reason: "ambiguous-old-text",
      value: "same and same",
    },
    {
      edits: [{ newText: "new", oldText: "missing" }],
      reason: "missing-old-text",
      value: "present",
    },
    {
      edits: [
        { newText: "first", oldText: "abc" },
        { newText: "second", oldText: "bcd" },
      ],
      reason: "overlapping-edits",
      value: "abcdef",
    },
  ] as const) {
    it(`rejects ${testCase.reason} without dispatching`, async () => {
      let editor = activeEditor(testCase.value);
      let host = createWorkspaceAgentHost({
        activeEditor: editor.capability,
        runtime: fakeRuntime(),
      });
      let version = await readVersion(host);

      expect(host.applyCurrentDocumentEdits({ edits: [...testCase.edits], version })).toMatchObject(
        {
          reason: testCase.reason,
          status: "not-applied",
        },
      );
      expect(editor.view.state.doc.toString()).toBe(testCase.value);
      expect(editor.transactions).toEqual([]);
    });
  }

  it("bounds replacement count and output bytes", async () => {
    let editor = activeEditor("old");
    let host = createWorkspaceAgentHost({
      activeEditor: editor.capability,
      limits: { write: { maxOutputBytes: 3, maxReplacements: 2 } },
      runtime: fakeRuntime(),
    });
    let version = await readVersion(host);

    expect(host.applyCurrentDocumentEdits({ edits: [], version })).toMatchObject({
      reason: "invalid-edit-count",
      status: "not-applied",
    });
    expect(
      host.applyCurrentDocumentEdits({
        edits: [{ newText: "four", oldText: "old" }],
        version,
      }),
    ).toMatchObject({ reason: "output-too-large", status: "not-applied" });
    expect(
      host.applyCurrentDocumentEdits({
        edits: [
          { newText: "a", oldText: "o" },
          { newText: "b", oldText: "l" },
          { newText: "c", oldText: "d" },
        ],
        version,
      }),
    ).toMatchObject({ reason: "invalid-edit-count", status: "not-applied" });
    expect(editor.transactions).toEqual([]);
  });

  it("rejects a stale version after an intervening editor change", async () => {
    let editor = activeEditor("old");
    let host = createWorkspaceAgentHost({
      activeEditor: editor.capability,
      runtime: fakeRuntime(),
    });
    let version = await readVersion(host);
    editor.view.dispatch({ changes: { from: 3, insert: "!" }, userEvent: "input.type" });
    editor.transactions.length = 0;

    expect(
      host.applyCurrentDocumentEdits({ edits: [{ newText: "new", oldText: "old" }], version }),
    ).toMatchObject({
      conflicts: expect.arrayContaining(["contentHash", "editVersion"]),
      reason: "stale-version",
      status: "not-applied",
    });
    expect(editor.view.state.doc.toString()).toBe("old!");
    expect(editor.transactions).toEqual([]);
  });

  for (let testCase of [
    { conflict: "workspaceId", field: "workspaceId", value: "local:other" },
    { conflict: "documentId", field: "documentId", value: "doc:other.md" },
    { conflict: "path", field: "path", value: "other.md" },
    { conflict: "documentGeneration", field: "documentGeneration", value: 2 },
    { conflict: "targetGeneration", field: "targetGeneration", value: 2 },
  ] as const) {
    it(`rejects an active ${testCase.field} switch`, async () => {
      let editor = activeEditor("old");
      let host = createWorkspaceAgentHost({
        activeEditor: editor.capability,
        runtime: fakeRuntime(),
      });
      let version = await readVersion(host);
      Object.assign(editor.state, { [testCase.field]: testCase.value });

      expect(
        host.applyCurrentDocumentEdits({ edits: [{ newText: "new", oldText: "old" }], version }),
      ).toMatchObject({
        conflicts: expect.arrayContaining([testCase.conflict]),
        reason: "stale-version",
        status: "not-applied",
      });
      expect(editor.view.state.doc.toString()).toBe("old");
      expect(editor.transactions).toEqual([]);
    });
  }

  it("rejects disagreement between the host value and current EditorView", async () => {
    let editor = activeEditor("old");
    let host = createWorkspaceAgentHost({
      activeEditor: editor.capability,
      runtime: fakeRuntime(),
    });
    let version = await readVersion(host);
    editor.state.value = "stale host value";

    expect(
      host.applyCurrentDocumentEdits({ edits: [{ newText: "new", oldText: "old" }], version }),
    ).toMatchObject({
      conflicts: ["editorValue"],
      reason: "stale-version",
      status: "not-applied",
    });
    expect(editor.transactions).toEqual([]);
  });

  it("does not dispatch when aborted before or immediately before the write", async () => {
    let editor = activeEditor("old");
    let controller = new AbortController();
    let host = createWorkspaceAgentHost({
      activeEditor: editor.capability,
      runtime: fakeRuntime(),
    });
    let version = await readVersion(host);
    controller.abort();

    expect(
      host.applyCurrentDocumentEdits(
        { edits: [{ newText: "new", oldText: "old" }], version },
        controller.signal,
      ),
    ).toMatchObject({ reason: "aborted", status: "not-applied" });

    let lateController = new AbortController();
    let captures = 0;
    let lateCapability: WorkspaceAgentActiveEditorCapability = {
      getActiveEditor: () => {
        if (++captures == 2) lateController.abort();
        return { ...editor.state, view: editor.view };
      },
    };
    let lateHost = createWorkspaceAgentHost({
      activeEditor: lateCapability,
      runtime: fakeRuntime(),
    });
    captures = 0;
    expect(
      lateHost.applyCurrentDocumentEdits(
        { edits: [{ newText: "new", oldText: "old" }], version },
        lateController.signal,
      ),
    ).toMatchObject({ reason: "aborted", status: "not-applied" });
    expect(editor.view.state.doc.toString()).toBe("old");
    expect(editor.transactions).toEqual([]);
  });

  it("reports no write when the active editor disappeared", async () => {
    let editor = activeEditor("old");
    let host = createWorkspaceAgentHost({
      activeEditor: editor.capability,
      runtime: fakeRuntime(),
    });
    let version = await readVersion(host);
    editor.disable();

    expect(
      host.applyCurrentDocumentEdits({ edits: [{ newText: "new", oldText: "old" }], version }),
    ).toMatchObject({ reason: "active-document-unavailable", status: "not-applied" });
    expect(editor.transactions).toEqual([]);
  });
});

function activeEditor(value: string, extensions: Extension = []) {
  let state: Omit<WorkspaceAgentActiveEditor, "view"> = {
    documentGeneration: 1,
    documentId: "doc:draft.md",
    dirty: false,
    editVersion: 7,
    path: "draft.md",
    targetGeneration: 1,
    value,
    workspaceId: "local:test",
  };
  let transactions: Array<string | undefined> = [];
  let parent = document.body.appendChild(document.createElement("div"));
  let view = new EditorView({
    parent,
    state: EditorState.create({
      doc: value,
      extensions: [
        extensions,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          state.value = update.state.doc.toString();
          state.editVersion += 1;
          state.dirty = true;
          transactions.push(update.transactions.at(-1)?.annotation(Transaction.userEvent));
        }),
      ],
    }),
  });
  mountedViews.push(view);
  let enabled = true;
  let capability = {
    getActiveEditor: () => (enabled ? { ...state, view } : null),
  } satisfies WorkspaceAgentActiveEditorCapability;
  return {
    capability,
    disable: () => {
      enabled = false;
    },
    state,
    transactions,
    view,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function readVersion(host: WorkspaceAgentHost): Promise<WorkspaceAgentActiveDocumentVersion> {
  let result = await host.readMarkdown({ path: "draft.md" });
  if (result.status != "found" || result.source.kind != "active-document") {
    throw new Error("Expected an active-document read result.");
  }
  return result.source.version;
}

function fakeRuntime(): WorkspaceAgentReadRuntime {
  return {
    documents: {
      commit: vi.fn(),
      observe: vi.fn(async () => ({ state: "missing" as const })),
    },
    identity: { id: "local:test", kind: "local", name: "Test" },
    tree: {
      listEntries: vi.fn(async () => []),
      readDirectory: vi.fn(async () => rootDirectory()),
      readTree: vi.fn(async () => rootDirectory()),
    },
  };
}

function rootDirectory() {
  return {
    children: [{ kind: "file" as const, name: "draft.md", path: "draft.md" }],
    childrenLoaded: true,
    kind: "directory" as const,
    name: "Test",
    path: "",
  };
}
