// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_WORKSPACE_AGENT_MODEL,
  type WorkspaceAgentRunInput,
  type WorkspaceAgentRunResult,
} from "@/lib/agent/runtime-contracts";
import type { WorkspaceAgentHost } from "@/lib/agent/workspace-agent-host";
import {
  useWorkspaceAgent,
  type UseWorkspaceAgentOptions,
  type WorkspaceAgentRunner,
} from "./useWorkspaceAgent";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let currentApi: ReturnType<typeof useWorkspaceAgent> | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let scheduledFrames: Array<FrameRequestCallback | undefined> = [];

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  scheduledFrames = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      scheduledFrames.push(callback);
      return scheduledFrames.length;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      scheduledFrames[id - 1] = undefined;
    }),
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  currentApi = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useWorkspaceAgent", () => {
  it("keeps credentials out of state and storage while configuring and sending", async () => {
    let inputs: WorkspaceAgentRunInput[] = [];
    let runner: WorkspaceAgentRunner = async (nextInput) => {
      inputs.push(nextInput);
      return completedRun("Done");
    };
    let localStorageWrite = vi.spyOn(Storage.prototype, "setItem");
    await renderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });

    expect(currentApi?.model).toBe(DEFAULT_WORKSPACE_AGENT_MODEL);
    expect(currentApi?.hasApiKey).toBe(false);
    expect(currentApi?.status).toBe("idle");
    act(() => currentApi?.configure({ apiKey: "  sk-secret  ", model: "  gpt-test  " }));
    expect(currentApi?.hasApiKey).toBe(true);
    expect(currentApi?.model).toBe("gpt-test");

    await act(async () => {
      expect(await currentApi?.send("  Review this note  ", () => host)).toBe(true);
    });

    expect(inputs[0]).toMatchObject({ apiKey: "sk-secret", model: "gpt-test" });
    expect(inputs[0]?.messages).toEqual([{ content: "Review this note", role: "user" }]);
    expect(currentApi?.messages).toEqual([
      { content: "Review this note", id: 1, role: "user" },
      { content: "Done", id: 2, role: "assistant" },
    ]);
    expect(currentApi?.status).toBe("success");
    expect(JSON.stringify(currentApi)).not.toContain("sk-secret");
    expect(localStorageWrite).not.toHaveBeenCalled();

    act(() => currentApi?.configure({ apiKey: "" }));
    expect(currentApi?.hasApiKey).toBe(false);
  });

  it("batches streamed text to one animation frame and stores only safe tool activity", async () => {
    let deferred = createDeferred<WorkspaceAgentRunResult>();
    let runnerInputs: WorkspaceAgentRunInput[] = [];
    let runner: WorkspaceAgentRunner = (input) => {
      runnerInputs.push(input);
      input.onEvent?.({ delta: "one", type: "text-delta" });
      input.onEvent?.({ delta: " two", type: "text-delta" });
      input.onEvent?.({
        toolCallId: "private-call-id",
        toolName: "read_markdown",
        type: "tool-start",
      });
      input.onEvent?.({
        durationMs: 4,
        outcome: "success",
        toolCallId: "private-call-id",
        toolName: "read_markdown",
        type: "tool-finish",
      });
      return deferred.promise;
    };
    await renderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });
    act(() => currentApi?.configure({ apiKey: "sk-secret" }));

    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = currentApi!.send("Summarize", () => host);
      await Promise.resolve();
    });

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(currentApi?.messages.at(-1)?.content).toBe("");
    act(() => scheduledFrames[0]?.(16));
    expect(currentApi?.messages.at(-1)?.content).toBe("one two");
    expect(currentApi?.toolActivity).toEqual([{ name: "read_markdown", status: "success" }]);
    expect(currentApi?.toolActivity[0]).not.toHaveProperty("toolCallId");
    expect(JSON.stringify(currentApi?.toolActivity)).not.toContain("private-call-id");

    await act(async () => {
      deferred.resolve(completedRun("one two"));
      expect(await sendPromise).toBe(true);
    });
    expect(runnerInputs[0]?.signal?.aborted).toBe(false);
    expect(currentApi?.running).toBe(false);
  });

  it("aborts on scope changes and ignores late events and results from the old run", async () => {
    let deferred = createDeferred<WorkspaceAgentRunResult>();
    let runnerInputs: WorkspaceAgentRunInput[] = [];
    let runner: WorkspaceAgentRunner = (input) => {
      runnerInputs.push(input);
      return deferred.promise;
    };
    await renderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });
    act(() => currentApi?.configure({ apiKey: "sk-secret" }));

    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = currentApi!.send("Edit this", () => host);
      await Promise.resolve();
    });
    expect(currentApi?.running).toBe(true);
    expect(currentApi?.status).toBe("running");

    await rerenderHook({ runner, scopeKey: "doc-b", workspaceKey: "workspace-a" });
    expect(runnerInputs[0]?.signal?.aborted).toBe(true);
    expect(currentApi?.running).toBe(false);
    expect(currentApi?.status).toBe("cancelled");
    expect(currentApi?.messages).toEqual([{ content: "Edit this", id: 1, role: "user" }]);

    act(() => runnerInputs[0]?.onEvent?.({ delta: "late", type: "text-delta" }));
    await act(async () => {
      deferred.resolve(completedRun("late result"));
      expect(await sendPromise).toBe(false);
    });
    expect(currentApi?.messages).toEqual([{ content: "Edit this", id: 1, role: "user" }]);
  });

  it("stops a run without surfacing an abort error and keeps its streamed text", async () => {
    let deferred = createDeferred<WorkspaceAgentRunResult>();
    let runnerInputs: WorkspaceAgentRunInput[] = [];
    let runner: WorkspaceAgentRunner = (input) => {
      runnerInputs.push(input);
      input.onEvent?.({ delta: "Partial", type: "text-delta" });
      input.onEvent?.({ toolCallId: "call-1", toolName: "search_markdown", type: "tool-start" });
      return deferred.promise;
    };
    await renderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });
    act(() => currentApi?.configure({ apiKey: "sk-secret" }));

    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = currentApi!.send("Search", () => host);
      await Promise.resolve();
    });
    act(() => currentApi?.stop());

    expect(runnerInputs[0]?.signal?.aborted).toBe(true);
    expect(currentApi?.running).toBe(false);
    expect(currentApi?.error).toBeNull();
    expect(currentApi?.messages.at(-1)?.content).toBe("Partial");
    expect(currentApi?.toolActivity).toEqual([{ name: "search_markdown", status: "cancelled" }]);

    await act(async () => {
      deferred.resolve(completedRun("late result"));
      expect(await sendPromise).toBe(false);
    });
    expect(currentApi?.messages.at(-1)?.content).toBe("Partial");
  });

  it("clears the conversation for a new workspace or new chat and reports missing hosts", async () => {
    let runner = vi.fn<WorkspaceAgentRunner>(async () => completedRun("Answer"));
    await renderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });
    act(() => currentApi?.configure({ apiKey: "sk-secret" }));

    await act(async () => {
      expect(await currentApi?.send("Question", () => null)).toBe(false);
    });
    expect(currentApi?.error).toMatch(/workspace/i);
    expect(currentApi?.errorCode).toBe("missing-workspace");
    expect(currentApi?.status).toBe("error");
    expect(runner).not.toHaveBeenCalled();

    await act(async () => {
      expect(await currentApi?.send("Question", () => host)).toBe(true);
    });
    expect(currentApi?.messages).toHaveLength(2);
    act(() => currentApi?.newChat());
    expect(currentApi?.messages).toEqual([]);

    await act(async () => {
      expect(await currentApi?.send("Another", () => host)).toBe(true);
    });
    await rerenderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-b" });
    expect(currentApi?.messages).toEqual([]);
    expect(currentApi?.toolActivity).toEqual([]);
    expect(currentApi?.error).toBeNull();
    expect(currentApi?.hasApiKey).toBe(true);
  });
});

async function renderHook(options: UseWorkspaceAgentOptions) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await rerenderHook(options);
}

async function rerenderHook(options: UseWorkspaceAgentOptions) {
  await act(async () => {
    root?.render(<WorkspaceAgentHarness options={options} />);
  });
}

function WorkspaceAgentHarness({ options }: { options: UseWorkspaceAgentOptions }) {
  currentApi = useWorkspaceAgent(options);
  return null;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  let promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function completedRun(content: string): WorkspaceAgentRunResult {
  return {
    finishReason: "stop",
    message: { content, role: "assistant" },
    usage: {},
  };
}

const host = {} as WorkspaceAgentHost;
