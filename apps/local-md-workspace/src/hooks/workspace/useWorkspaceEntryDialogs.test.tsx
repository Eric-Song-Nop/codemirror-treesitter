// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import type { TFunction } from "@/lib/i18n";
import { createMemoryWorkspaceRuntime } from "../../test/memory-workspace-runtime";
import { useWorkspaceEntryDialogs } from "./useWorkspaceEntryDialogs";

type HookResult = ReturnType<typeof useWorkspaceEntryDialogs>;
type HookOptions = Parameters<typeof useWorkspaceEntryDialogs>[0];

let container: HTMLDivElement;
let root: Root;
let result: HookResult;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterAll(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useWorkspaceEntryDialogs active document ordering", () => {
  it("saves and closes an active file before renaming it with its source revision", async () => {
    let events: string[] = [];
    let options = createOptions(events);
    let rename = vi.fn(async (input) => {
      events.push("rename");
      expect(input.revision).toEqual({
        kind: "etag",
        validation: "atomic",
        value: "revision-1",
      });
      return { path: "renamed.md", result: { status: "applied" as const } };
    });
    options.workspaceRuntime!.entries.rename = rename;
    await render(options);

    await act(async () => {
      result.openRenameDialog({ kind: "file", name: "note.md", path: "note.md" });
    });
    await act(async () => {
      await result.submitFileDialog("renamed");
    });

    expect(events).toEqual(["save", "close", "rename", "transition:renamed.md", "load:renamed.md"]);
  });

  it("closes an active document before deleting it and clears it before refreshing", async () => {
    let events: string[] = [];
    let options = createOptions(events);
    options.workspaceRuntime!.entries.delete = vi.fn(async () => {
      events.push("delete");
      return { status: "applied" as const };
    });
    await render(options);

    await act(async () => {
      result.requestDeleteEntry({ kind: "file", name: "note.md", path: "note.md" });
    });
    await act(async () => {
      await result.deleteWorkspaceEntry();
    });

    expect(events).toEqual(["save", "close", "delete", "clear", "load:null"]);
  });
});

function Harness({ options }: { options: ReturnType<typeof createOptions> }) {
  result = useWorkspaceEntryDialogs(options);
  return null;
}

async function render(options: ReturnType<typeof createOptions>) {
  await act(async () => {
    root.render(<Harness options={options} />);
  });
}

function createOptions(events: string[]): HookOptions {
  let selectedFile = { kind: "file" as const, name: "note.md", path: "note.md" };
  let workspaceRuntime = createMemoryWorkspaceRuntime([["note.md", "# Note\n"]]);
  let revision = { kind: "etag" as const, validation: "atomic" as const, value: "revision-1" };

  return {
    autoSaveTaskRef: { current: null },
    beginDocumentTransition: (path = "") => {
      events.push(`transition:${path}`);
    },
    clearActiveDocument: async () => {
      events.push("clear");
    },
    closeActiveDocumentSession: async () => {
      events.push("close");
    },
    collabDocumentRef: {
      current: {
        source: { baseline: { contentHash: "hash-1", revision }, kind: "present" },
      } as CollabDocumentState,
    },
    documentTargetGenerationRef: { current: 0 },
    loadTree: async (_runtime, path) => {
      events.push(`load:${path ?? "null"}`);
    },
    saveCurrentFile: async () => {
      events.push("save");
      return true;
    },
    saveOperationRef: { current: 0 },
    selectedFile,
    selectedFileRef: { current: selectedFile },
    setBusy: vi.fn(),
    setErrorMessage: vi.fn(),
    setRetryLoadPath: vi.fn(),
    singleFileSourceRef: { current: null },
    t: ((key: string) => key) as TFunction,
    tree: null,
    treeSelection: null,
    workspaceRuntime,
  };
}
