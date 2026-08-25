// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createMemoryWorkspaceRuntime,
  type MemoryWorkspaceRuntime,
} from "@/test/memory-workspace-runtime";
import type { WorkspaceCollaborativeDocument, WorkspaceDocuments } from "@/lib/workspace/documents";
import type { WorkspaceTreePort } from "@/lib/workspace/runtime/types";
import { createWorkspaceAgentHost } from "./host.ts";

let runtimes: MemoryWorkspaceRuntime[] = [];
let runtimeSequence = 0;

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.restoreAllMocks();
});

describe("path-based Agent file edits", () => {
  it("edits an unselected, previously unopened document through the workspace registry", async () => {
    let runtime = memoryRuntime([
      ["selected.md", "# Selected\n"],
      ["notes/other.md", "# Other\nalpha\nbeta"],
    ]);
    let selected = await runtime.documents.document("selected.md");
    let host = createWorkspaceAgentHost({ runtime });

    let result = await host.writeFile({
      edits: [
        { expectedText: "beta", from: 14, insert: "two", to: 18 },
        { expectedText: "alpha", from: 8, insert: "one", to: 13 },
      ],
      path: "notes/other.md",
    });

    expect(result).toMatchObject({
      appliedEdits: 2,
      path: "notes/other.md",
      persistence: { status: "saved" },
      status: "applied",
    });
    expect(runtime.files.get("notes/other.md")).toBe("# Other\none\ntwo");
    expect(await runtime.documents.document("selected.md")).toBe(selected);
    expect((await runtime.documents.document("notes/other.md")).read()).toBe("# Other\none\ntwo");
  });

  it("rejects stale expected text without changing the collaborative document", async () => {
    let runtime = memoryRuntime([["draft.md", "before"]]);
    let host = createWorkspaceAgentHost({ runtime });
    let read = await host.readFile({ path: "draft.md" });
    expect(read).toMatchObject({ endOffset: 6, startOffset: 0, text: "before" });
    let document = await runtime.documents.document("draft.md");
    document.edit([{ expectedText: "before", from: 0, insert: "people", to: 6 }]);

    await expect(
      host.writeFile({
        edits: [{ expectedText: "before", from: 0, insert: "agent", to: 6 }],
        path: "draft.md",
      }),
    ).resolves.toMatchObject({
      editIndex: 0,
      reason: "expected-text-mismatch",
      status: "not-applied",
    });
    expect(document.read()).toBe("people");
  });

  it("bounds edit count and projected output without mutating the document", async () => {
    let runtime = memoryRuntime([["draft.md", "old"]]);
    let host = createWorkspaceAgentHost({
      limits: { write: { maxOutputBytes: 3, maxReplacements: 2 } },
      runtime,
    });

    await expect(host.writeFile({ edits: [], path: "draft.md" })).resolves.toMatchObject({
      reason: "invalid-edit-count",
      status: "not-applied",
    });
    await expect(
      host.writeFile({
        edits: [{ expectedText: "old", from: 0, insert: "four", to: 3 }],
        path: "draft.md",
      }),
    ).resolves.toMatchObject({ reason: "output-too-large", status: "not-applied" });
    await expect(
      host.writeFile({
        edits: [
          { expectedText: "o", from: 0, insert: "a", to: 1 },
          { expectedText: "l", from: 1, insert: "b", to: 2 },
          { expectedText: "d", from: 2, insert: "c", to: 3 },
        ],
        path: "draft.md",
      }),
    ).resolves.toMatchObject({ reason: "invalid-edit-count", status: "not-applied" });
    expect((await runtime.documents.document("draft.md")).read()).toBe("old");
  });

  it("reports a logical edit as applied when filesystem projection is blocked", async () => {
    let value = "old";
    let edit = vi.fn(() => {
      value = "new";
      return { appliedEdits: 1, generation: 1, status: "applied" as const, value };
    });
    let document = {
      edit,
      flush: vi.fn(async () => {
        throw new Error("source is unavailable");
      }),
      path: "draft.md",
      read: () => value,
      snapshot: () => ({ persistenceStatus: "blocked" as const }),
    } as unknown as WorkspaceCollaborativeDocument;
    let documents = {
      close: vi.fn(),
      document: vi.fn(async () => document),
    } satisfies WorkspaceDocuments;
    let host = createWorkspaceAgentHost({
      runtime: {
        documents,
        identity: { id: "local:test", kind: "local", name: "Test" },
        tree: singleFileTree("draft.md"),
      },
    });

    await expect(
      host.writeFile({
        edits: [{ expectedText: "old", from: 0, insert: "new", to: 3 }],
        path: "draft.md",
      }),
    ).resolves.toEqual({
      appliedEdits: 1,
      generation: 1,
      outputBytes: 3,
      path: "draft.md",
      persistence: { message: "source is unavailable", status: "blocked" },
      status: "applied",
    });
    expect(value).toBe("new");
    expect(edit).toHaveBeenCalledOnce();
  });

  it("does not apply after cancellation or outside the exposed Markdown tree", async () => {
    let runtime = memoryRuntime([["draft.md", "old"]]);
    let host = createWorkspaceAgentHost({ runtime });
    let controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));

    await expect(
      host.writeFile(
        {
          edits: [{ expectedText: "old", from: 0, insert: "new", to: 3 }],
          path: "draft.md",
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({ reason: "aborted", status: "not-applied" });
    await expect(
      host.writeFile({
        edits: [{ expectedText: "old", from: 0, insert: "new", to: 3 }],
        path: "private.txt",
      }),
    ).resolves.toMatchObject({ reason: "not-markdown", status: "not-applied" });
    expect(runtime.files.get("draft.md")).toBe("old");
  });
});

function memoryRuntime(entries: Iterable<readonly [string, string]>) {
  let runtime = createMemoryWorkspaceRuntime(entries, { id: `memory:agent-${runtimeSequence++}` });
  runtimes.push(runtime);
  return runtime;
}

function singleFileTree(path: string): WorkspaceTreePort {
  let root = {
    children: [{ kind: "file" as const, name: path, path }],
    childrenLoaded: true,
    kind: "directory" as const,
    name: "Test",
    path: "",
  };
  return {
    listEntries: vi.fn(async () => []),
    readDirectory: vi.fn(async () => root),
    readTree: vi.fn(async () => root),
  };
}
