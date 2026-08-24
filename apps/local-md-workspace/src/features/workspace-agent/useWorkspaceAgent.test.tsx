// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceAgentHost } from "@/lib/agent/application/host-port";
import type { WorkspaceAgentRunResult } from "@/lib/agent/application/run-contracts";
import { DEFAULT_WORKSPACE_AGENT_MODEL } from "@/lib/agent/providers/deepseek/config";
import type { WorkspaceAgentRunInput } from "@/lib/agent/runtime";
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

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  currentApi = null;
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
    act(() => currentApi?.configure({ apiKey: "  sk-secret  ", model: "deepseek-v4-pro" }));
    expect(currentApi?.hasApiKey).toBe(true);
    expect(currentApi?.model).toBe("deepseek-v4-pro");

    await act(async () => {
      expect(await currentApi?.send("  Review this note  ", () => host)).toBe(true);
    });

    expect(inputs[0]).toMatchObject({ apiKey: "sk-secret", model: "deepseek-v4-pro" });
    expect(inputs[0]?.messages).toEqual([{ content: "Review this note", role: "user" }]);
    expect(currentApi?.messages.map((message) => [message.role, messageText(message)])).toEqual([
      ["user", "Review this note"],
      ["assistant", "Done"],
    ]);
    expect(currentApi?.status).toBe("success");
    expect(JSON.stringify(currentApi)).not.toContain("sk-secret");
    expect(localStorageWrite).not.toHaveBeenCalled();

    act(() => currentApi?.configure({ apiKey: "" }));
    expect(currentApi?.hasApiKey).toBe(false);
  });

  it("redacts credentials from runner failures at the UI boundary", async () => {
    let runner: WorkspaceAgentRunner = async () => {
      throw new Error("Provider response exposed sk-secret.");
    };
    await renderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });
    act(() => currentApi?.configure({ apiKey: "sk-secret" }));

    await act(async () => {
      expect(await currentApi?.send("Fail safely", () => host)).toBe(false);
    });

    expect(currentApi?.error).toBe("Provider response exposed [redacted].");
    expect(currentApi?.status).toBe("error");
    expect(JSON.stringify(currentApi)).not.toContain("sk-secret");
  });

  it("stores AI SDK message parts while exposing only safe tool activity", async () => {
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
    await waitUntil(() => messageText(currentApi?.messages.at(-1)) == "one two");

    let toolPart = currentApi?.messages.at(-1)?.parts.find(isToolUIPart);
    expect(toolPart && getToolName(toolPart)).toBe("read_markdown");
    expect(toolPart).toMatchObject({
      input: {},
      output: { status: "success" },
      state: "output-available",
    });
    expect(JSON.stringify(toolPart)).not.toContain("private-call-id");

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
    expect(currentApi?.messages.map((message) => [message.role, messageText(message)])).toEqual([
      ["user", "Edit this"],
    ]);

    act(() => runnerInputs[0]?.onEvent?.({ delta: "late", type: "text-delta" }));
    await act(async () => expect(await sendPromise).toBe(false));
    deferred.resolve(completedRun("late result"));
    expect(currentApi?.messages.map(messageText)).not.toContain("late result");
  });

  it("stops a run without surfacing an abort error and keeps streamed text", async () => {
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
    await waitUntil(() => messageText(currentApi?.messages.at(-1)) == "Partial");
    act(() => currentApi?.stop());

    expect(runnerInputs[0]?.signal?.aborted).toBe(true);
    expect(currentApi?.running).toBe(false);
    expect(currentApi?.error).toBeNull();
    expect(messageText(currentApi?.messages.at(-1))).toBe("Partial");
    expect(currentApi?.messages.at(-1)?.parts.find(isToolUIPart)).toMatchObject({
      state: "input-available",
    });
    expect(currentApi?.status).toBe("cancelled");

    await act(async () => expect(await sendPromise).toBe(false));
    deferred.resolve(completedRun("late result"));
    expect(messageText(currentApi?.messages.at(-1))).toBe("Partial");
  });

  it("keeps one coherent running status during configuration and duplicate sends", async () => {
    let deferred = createDeferred<WorkspaceAgentRunResult>();
    let runner = vi.fn<WorkspaceAgentRunner>(() => deferred.promise);
    await renderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });
    act(() => currentApi?.configure({ apiKey: "sk-secret" }));

    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = currentApi!.send("First", () => host);
      await Promise.resolve();
    });
    await act(async () => {
      currentApi?.configure({ model: "deepseek-v4-pro" });
      expect(await currentApi?.send("", () => host)).toBe(false);
    });

    expect(currentApi?.model).toBe("deepseek-v4-pro");
    expect(currentApi?.error).toBeNull();
    expect(currentApi?.running).toBe(true);
    expect(currentApi?.status).toBe("running");
    expect(runner).toHaveBeenCalledOnce();

    await act(async () => {
      deferred.resolve(completedRun("Done"));
      expect(await sendPromise).toBe(true);
    });
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
    root?.render(<WorkspaceAgentHarness options={{ throttleMs: 0, ...options }} />);
  });
}

function WorkspaceAgentHarness({ options }: { options: UseWorkspaceAgentOptions }) {
  currentApi = useWorkspaceAgent(options);
  return null;
}

function messageText(message: UIMessage | null | undefined) {
  return message?.parts.flatMap((part) => (part.type == "text" ? part.text : [])).join("") ?? "";
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error("Timed out waiting for Agent state.");
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
