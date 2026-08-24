// @vitest-environment happy-dom

import { act } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import type { WorkspaceAgentHost } from "@/lib/agent/workspace-agent-host";
import type { ActiveDocumentSource, SingleFileSource } from "@/lib/workspace/types";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";
import {
  createWorkspaceAgentRunHost,
  useWorkspaceAgentHost,
  type CreateWorkspaceAgentRunHost,
  type WorkspaceAgentHostRefs,
} from "./useWorkspaceAgentHost";

vi.mock("@/lib/collaboration/markdown-document", () => ({
  getCollabDocumentValue: (document: CollabDocumentState) => document.value,
}));

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type TestRig = {
  document: CollabDocumentState;
  editor: LiveMdEditorElement;
  host: WorkspaceAgentHost;
  refs: WorkspaceAgentHostRefs;
  runtime: WorkspaceRuntime;
  setValue(value: string): void;
  view: EditorView;
};

let mountedViews: EditorView[] = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  for (let view of mountedViews.splice(0)) view.destroy();
  vi.restoreAllMocks();
});

describe("workspace Agent run host", () => {
  it("returns null until a workspace is available", () => {
    let rig = createRefs();
    rig.refs.workspaceRuntimeRef.current = null;

    expect(createWorkspaceAgentRunHost(rig.refs)).toBeNull();
  });

  it("revokes the previous workspace while a standalone file is active", () => {
    let rig = createRefs();
    rig.refs.singleFileSourceRef.current = {
      draftId: "standalone",
      kind: "draft",
      name: "outside.md",
    };

    expect(createWorkspaceAgentRunHost(rig.refs)).toBeNull();
  });

  it("keeps a run permanently read-only when it starts without an active document", () => {
    let rig = createRefs();
    rig.refs.collabDocumentRef.current = null;
    let host = createWorkspaceAgentRunHost(rig.refs)!;

    expect(host.getContext()).toMatchObject({
      activeDocument: null,
      capabilities: { applyCurrentDocumentEdits: false },
    });

    rig.refs.collabDocumentRef.current = rig.document;
    expect(host.getContext()).toMatchObject({
      activeDocument: null,
      capabilities: { applyCurrentDocumentEdits: false },
    });
  });

  it("reads live value, edit version, and dirty state without unbinding the run", () => {
    let rig = createRig();
    rig.setValue("# Revised\n");
    rig.refs.editVersionRef.current = 9;
    rig.refs.dirtyRef.current = true;

    let context = rig.host.getContext();
    expect(context.activeDocument).toMatchObject({
      dirty: true,
      path: "notes/draft.md",
      version: {
        documentGeneration: 3,
        documentId: "doc:notes/draft.md",
        editVersion: 9,
        targetGeneration: 5,
        workspaceId: "local:test",
      },
    });

    let result = rig.host.applyCurrentDocumentEdits({
      edits: [{ newText: "Updated", oldText: "Revised" }],
      version: context.activeDocument!.version,
    });
    expect(result).toMatchObject({ appliedEdits: 1, status: "applied" });
    expect(rig.view.state.doc.toString()).toBe("# Updated\n");
  });

  it.each([
    [
      "workspace runtime",
      (rig: TestRig) => {
        rig.refs.workspaceRuntimeRef.current = fakeRuntime("local:test");
      },
    ],
    [
      "workspace identity",
      (rig: TestRig) => {
        rig.runtime.identity.id = "local:other";
      },
    ],
    [
      "selected source",
      (rig: TestRig) => {
        rig.refs.selectedFileSourceRef.current = null;
      },
    ],
    [
      "selected path",
      (rig: TestRig) => {
        rig.refs.selectedFileRef.current = markdownFile("notes/other.md");
      },
    ],
    [
      "single-file source",
      (rig: TestRig) => {
        rig.refs.singleFileSourceRef.current = {
          draftId: "draft",
          kind: "draft",
          name: "draft.md",
        };
      },
    ],
    [
      "collaboration document",
      (rig: TestRig) => {
        rig.refs.collabDocumentRef.current = {
          ...rig.document,
          metadata: { ...rig.document.metadata },
        };
      },
    ],
    [
      "document id",
      (rig: TestRig) => {
        rig.document.docId = "doc:other.md";
      },
    ],
    [
      "document path",
      (rig: TestRig) => {
        rig.document.path = "notes/other.md";
      },
    ],
    [
      "document generation",
      (rig: TestRig) => {
        rig.refs.activeDocumentGenerationRef.current += 1;
      },
    ],
    [
      "target generation",
      (rig: TestRig) => {
        rig.refs.documentTargetGenerationRef.current += 1;
      },
    ],
    [
      "editor element",
      (rig: TestRig) => {
        rig.refs.editorElementRef.current = { view: rig.view } as LiveMdEditorElement;
      },
    ],
  ])("rejects writes after the %s identity changes", (_name, changeIdentity) => {
    let rig = createRig();
    let version = rig.host.getContext().activeDocument!.version;
    changeIdentity(rig);

    expect(
      rig.host.applyCurrentDocumentEdits({
        edits: [{ newText: "new", oldText: "Draft" }],
        version,
      }),
    ).toMatchObject({
      reason: "active-document-unavailable",
      status: "not-applied",
    });
    expect(rig.view.state.doc.toString()).toBe("# Draft\n");
  });

  it("returns a stable hook factory that reads refs when each run starts", async () => {
    let rig = createRefs();
    let factories: CreateWorkspaceAgentRunHost[] = [];
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);

    function Harness() {
      factories.push(useWorkspaceAgentHost(rig.refs));
      return null;
    }

    await act(async () => root?.render(<Harness />));
    await act(async () => root?.render(<Harness />));
    expect(factories[1]).toBe(factories[0]);
    expect(factories[0]!()?.getContext().workspace.id).toBe("local:test");

    rig.refs.workspaceRuntimeRef.current = null;
    expect(factories[0]!()).toBeNull();
  });
});

function createRig(): TestRig {
  let rig = createRefs();
  let host = createWorkspaceAgentRunHost(rig.refs);
  if (!host) throw new Error("Expected a workspace Agent host.");
  return { ...rig, host };
}

function createRefs() {
  let runtime = fakeRuntime();
  let document = collabDocument();
  let parent = documentBody().appendChild(globalThis.document.createElement("div"));
  let view = new EditorView({
    parent,
    state: EditorState.create({ doc: document.value }),
  });
  mountedViews.push(view);
  let editor = { view } as LiveMdEditorElement;
  let refs: WorkspaceAgentHostRefs = {
    activeDocumentGenerationRef: { current: 3 },
    collabDocumentRef: { current: document },
    dirtyRef: { current: false },
    documentTargetGenerationRef: { current: 5 },
    editorElementRef: { current: editor },
    editorValueRef: { current: document.value },
    editVersionRef: { current: 7 },
    selectedFileSourceRef: { current: runtime as ActiveDocumentSource },
    selectedFileRef: { current: markdownFile() },
    singleFileSourceRef: { current: null as SingleFileSource | null },
    workspaceRuntimeRef: { current: runtime as WorkspaceRuntime | null },
  };
  return {
    document,
    editor,
    refs,
    runtime,
    setValue(value: string) {
      document.value = value;
      refs.editorValueRef.current = value;
      view.dispatch({ changes: { from: 0, insert: value, to: view.state.doc.length } });
    },
    view,
  };
}

function collabDocument(): CollabDocumentState {
  return {
    docId: "doc:notes/draft.md",
    metadata: {
      docId: "doc:notes/draft.md",
      path: "notes/draft.md",
      workspaceId: "local:test",
    },
    path: "notes/draft.md",
    value: "# Draft\n",
  } as CollabDocumentState;
}

function markdownFile(path = "notes/draft.md"): MarkdownFileNode {
  return { kind: "file", name: path.split("/").at(-1)!, path };
}

function fakeRuntime(id = "local:test"): WorkspaceRuntime {
  return {
    documents: {
      commit: vi.fn(),
      observe: vi.fn(async () => ({ state: "missing" as const })),
    },
    identity: { id, kind: "local", name: "Test" },
    tree: {
      listEntries: vi.fn(async () => []),
      readDirectory: vi.fn(async () => rootDirectory()),
      readTree: vi.fn(async () => rootDirectory()),
    },
  } as unknown as WorkspaceRuntime;
}

function rootDirectory() {
  return {
    children: [],
    childrenLoaded: true,
    kind: "directory" as const,
    name: "Test",
    path: "",
  };
}

function documentBody() {
  return globalThis.document.body;
}
