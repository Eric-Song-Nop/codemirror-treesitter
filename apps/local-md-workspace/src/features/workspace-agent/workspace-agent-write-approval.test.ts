// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createWorkspaceAgentHost } from "@/lib/agent/adapters/workspace/host";
import { createWorkspaceAgentToolSession } from "@/lib/agent/application/tool-session";
import type { WorkspaceAgentWriteFileResult } from "@/lib/agent/domain/contracts";
import {
  createMemoryWorkspaceRuntime,
  type MemoryWorkspaceRuntime,
} from "@/test/memory-workspace-runtime";
import {
  WorkspaceAgentSessionManager,
  type WorkspaceAgentRunner,
} from "./workspace-agent-session-manager";

let runtimes: MemoryWorkspaceRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe("Agent write approval gate", () => {
  it("auto-applies writes to the open document and blocks other files until approved", async () => {
    let fixture = setup();
    let send = fixture.manager.send("edit both", () => fixture.host);

    let approval = await vi.waitFor(() => {
      let pending = fixture.activeSession().approvals[0];
      expect(pending).toBeDefined();
      return pending!;
    });
    expect(approval.path).toBe("other.md");
    expect(approval.change.diff).toContain("+injected");
    expect(fixture.results).toHaveLength(1);
    expect(fixture.results[0]).toMatchObject({ path: "open.md", status: "applied" });
    expect(await fixture.read("other.md")).toBe("B\n");

    fixture.manager.resolveApproval(fixture.sessionId(), approval.id, "deny");
    await send;
    expect(fixture.results[1]).toMatchObject({
      path: "other.md",
      reason: "denied",
      status: "not-applied",
    });
    expect(await fixture.read("other.md")).toBe("B\n");
    expect(fixture.activeSession().approvals).toEqual([]);
    expect(fixture.activeSession().edits.map((edit) => edit.path)).toEqual(["open.md"]);
  });

  it("applies after an explicit approval and reverts through the shared document", async () => {
    let fixture = setup();
    let send = fixture.manager.send("edit both", () => fixture.host);
    let approval = await vi.waitFor(() => {
      let pending = fixture.activeSession().approvals[0];
      expect(pending).toBeDefined();
      return pending!;
    });
    expect(await fixture.read("other.md")).toBe("B\n");

    fixture.manager.resolveApproval(fixture.sessionId(), approval.id, "allow-once");
    await send;
    expect(fixture.results[1]).toMatchObject({ path: "other.md", status: "applied" });
    expect(await fixture.read("other.md")).toBe("injected\nB\n");

    let edit = fixture.activeSession().edits.find((entry) => entry.path == "other.md")!;
    expect(edit.change).toMatchObject({ added: 1, removed: 0 });
    await expect(fixture.manager.revertEdit(fixture.sessionId(), edit.id)).resolves.toBe(true);
    expect(await fixture.read("other.md")).toBe("B\n");
    expect(fixture.runtime.files.get("other.md")).toBe("B\n");
    expect(fixture.activeSession().edits.find((entry) => entry.id == edit.id)?.status).toBe(
      "reverted",
    );
  });

  it("denies pending approvals when the session is stopped", async () => {
    let fixture = setup();
    let send = fixture.manager.send("edit both", () => fixture.host);
    await vi.waitFor(() => {
      let pending = fixture.activeSession().approvals[0];
      expect(pending).toBeDefined();
      return pending!;
    });

    fixture.manager.stop();
    await send;
    await vi.waitFor(() => expect(fixture.results).toHaveLength(2));
    expect(fixture.results[1]).toMatchObject({ status: "not-applied" });
    expect(await fixture.read("other.md")).toBe("B\n");
  });
});

function setup() {
  let runtime = createMemoryWorkspaceRuntime(
    [
      ["open.md", "A\n"],
      ["other.md", "B\n"],
    ],
    { id: `memory:approval-${runtimes.length}` },
  );
  runtimes.push(runtime);
  let host = createWorkspaceAgentHost({ runtime });
  let results: WorkspaceAgentWriteFileResult[] = [];
  let runner: WorkspaceAgentRunner = async (input) => {
    let tools = createWorkspaceAgentToolSession(input.host, input.onEvent, input.writeControl);
    let execution = (callId: string) => ({ callId, signal: input.signal });
    results.push(
      await tools.writeFile(
        { edits: [{ expectedText: "", from: 0, insert: "open edit\n", to: 0 }], path: "open.md" },
        execution("call-open"),
      ),
    );
    results.push(
      await tools.writeFile(
        { edits: [{ expectedText: "", from: 0, insert: "injected\n", to: 0 }], path: "other.md" },
        execution("call-other"),
      ),
    );
    return {
      finishReason: "stop",
      message: { content: "Done", role: "assistant" },
      usage: {},
    };
  };
  let manager = new WorkspaceAgentSessionManager(runner);
  manager.activate();
  manager.syncApiKey("sk-test");
  manager.setOpenDocumentResolver(() => "open.md");
  let sessionId = () => manager.store.getState().activeSessionId;
  return {
    activeSession: () =>
      manager.store.getState().sessions.find((session) => session.id == sessionId())!,
    host,
    manager,
    read: async (path: string) => (await runtime.documents.document(path)).read(),
    results,
    runtime,
    sessionId,
  };
}
