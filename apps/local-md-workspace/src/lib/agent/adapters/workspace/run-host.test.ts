// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createMemoryWorkspaceRuntime,
  type MemoryWorkspaceRuntime,
} from "@/test/memory-workspace-runtime";
import type { SingleFileSource } from "@/lib/workspace/types";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";
import { createWorkspaceAgentRunHost, type WorkspaceAgentHostRefs } from "./run-host.ts";

let runtimes: MemoryWorkspaceRuntime[] = [];
let runtimeSequence = 0;

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe("workspace Agent run host", () => {
  it("returns null until a workspace is available", () => {
    let refs = createRefs(null);

    expect(createWorkspaceAgentRunHost(refs)).toBeNull();
  });

  it("does not expose a workspace host while a standalone file is active", () => {
    let refs = createRefs(memoryRuntime([["draft.md", "old"]]));
    refs.singleFileSourceRef.current = {
      draftId: "standalone",
      kind: "draft",
      name: "outside.md",
    };

    expect(createWorkspaceAgentRunHost(refs)).toBeNull();
  });

  it("binds a run to the workspace registry rather than the selected editor", async () => {
    let runtime = memoryRuntime([
      ["selected.md", "selected"],
      ["notes/other.md", "before"],
    ]);
    let host = createWorkspaceAgentRunHost(createRefs(runtime));
    if (!host) throw new Error("Expected a workspace Agent host.");

    expect(host.getContext()).toEqual({
      capabilities: {
        listMarkdown: true,
        readFile: true,
        searchMarkdown: true,
        writeFile: true,
      },
      workspace: { id: runtime.identity.id, kind: "local", name: "Memory" },
    });
    await expect(host.readFile({ path: "notes/other.md" })).resolves.toMatchObject({
      status: "found",
      text: "before",
    });
    await expect(
      host.writeFile({
        edits: [{ expectedText: "before", from: 0, insert: "after", to: 6 }],
        path: "notes/other.md",
      }),
    ).resolves.toMatchObject({ persistence: { status: "saved" }, status: "applied" });
    expect(runtime.files.get("notes/other.md")).toBe("after");
  });

  it("captures the current workspace each time a run starts", () => {
    let first = memoryRuntime([["first.md", "first"]]);
    let second = memoryRuntime([["second.md", "second"]]);
    let refs = createRefs(first);
    let firstHost = createWorkspaceAgentRunHost(refs)!;

    refs.workspaceRuntimeRef.current = second;
    let secondHost = createWorkspaceAgentRunHost(refs)!;

    expect(firstHost.getContext().workspace.id).toBe(first.identity.id);
    expect(secondHost.getContext().workspace.id).toBe(second.identity.id);
  });
});

function createRefs(runtime: WorkspaceRuntime | null): WorkspaceAgentHostRefs {
  return {
    singleFileSourceRef: { current: null as SingleFileSource | null },
    workspaceRuntimeRef: { current: runtime },
  };
}

function memoryRuntime(entries: Iterable<readonly [string, string]>) {
  let runtime = createMemoryWorkspaceRuntime(entries, {
    id: `memory:run-host-${runtimeSequence++}`,
  });
  runtimes.push(runtime);
  return runtime;
}
