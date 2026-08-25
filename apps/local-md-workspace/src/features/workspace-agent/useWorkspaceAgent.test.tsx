// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceAgentHost } from "@/lib/agent/application/host-port";
import type { WorkspaceAgentRunResult } from "@/lib/agent/application/run-contracts";
import { DEFAULT_WORKSPACE_AGENT_MODEL } from "@/lib/agent/providers/deepseek/config";
import type { WorkspaceAgentRunInput } from "@/lib/agent/runtime";
import {
  useWorkspaceAgent,
  type UseWorkspaceAgentOptions,
  type WorkspaceAgentRunner,
} from "./useWorkspaceAgent";

type TestOptions = Omit<UseWorkspaceAgentOptions, "getApiKey" | "subscribeToCredentials">;
type ReactActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

let api: ReturnType<typeof useWorkspaceAgent> | null = null;
let container: HTMLDivElement | null = null;
let credentials: ReturnType<typeof credentialSource>;
let root: Root | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  credentials = credentialSource("sk-secret");
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  api = null;
  vi.restoreAllMocks();
});

describe("useWorkspaceAgent", () => {
  it("keeps credentials private while sending, changing models, and reporting failures", async () => {
    let inputs: WorkspaceAgentRunInput[] = [];
    let runner: WorkspaceAgentRunner = async (input) => {
      inputs.push(input);
      if (input.messages.at(-1)?.content == "Fail safely") {
        throw new Error("Provider exposed sk-secret.");
      }
      return completedRun("Done");
    };
    let localStorageWrite = vi.spyOn(Storage.prototype, "setItem");
    await mount({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });

    expect(api?.model).toBe(DEFAULT_WORKSPACE_AGENT_MODEL);
    act(() => api?.setModel("deepseek-v4-pro"));
    await act(async () => expect(await api?.send("  Review this note  ", () => host)).toBe(true));

    expect(inputs[0]).toMatchObject({ apiKey: "sk-secret", model: "deepseek-v4-pro" });
    expect(inputs[0]?.messages).toEqual([{ content: "Review this note", role: "user" }]);
    expect(api?.messages.map((message) => [message.role, messageText(message)])).toEqual([
      ["user", "Review this note"],
      ["assistant", "Done"],
    ]);
    expect(JSON.stringify(api)).not.toContain("sk-secret");
    expect(localStorageWrite).not.toHaveBeenCalled();

    act(() => {
      api?.newChat();
    });
    await act(async () => expect(await api?.send("Fail safely", () => host)).toBe(false));
    expect(api?.error).toBe("Provider exposed [redacted].");

    act(() => credentials.set(null));
    await act(async () => expect(await api?.send("Locked", () => host)).toBe(false));
    expect(api?.hasApiKey).toBe(false);
    expect(api?.errorCode).toBe("missing-api-key");
  });

  it("streams safe message parts, rejects duplicate sends, and preserves partial output on stop", async () => {
    let deferred = createDeferred<WorkspaceAgentRunResult>();
    let input: WorkspaceAgentRunInput | undefined;
    let runner = vi.fn<WorkspaceAgentRunner>((nextInput) => {
      input = nextInput;
      nextInput.onEvent?.({ delta: "Partial", type: "text-delta" });
      nextInput.onEvent?.({ toolCallId: "private-id", toolName: "read_file", type: "tool-start" });
      nextInput.onEvent?.({
        durationMs: 4,
        outcome: "success",
        toolCallId: "private-id",
        toolName: "read_file",
        type: "tool-finish",
      });
      return deferred.promise;
    });
    await mount({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });

    let send!: Promise<boolean>;
    await act(async () => {
      send = api!.send("Summarize", () => host);
      await Promise.resolve();
    });
    await waitUntil(() => messageText(api?.messages.at(-1)) == "Partial");

    let tool = api?.messages.at(-1)?.parts.find(isToolUIPart);
    expect(tool && getToolName(tool)).toBe("read_file");
    expect(tool).toMatchObject({ output: { status: "success" }, state: "output-available" });
    expect(JSON.stringify(tool)).not.toContain("private-id");
    await act(async () => expect(await api?.send("", () => host)).toBe(false));
    expect(runner).toHaveBeenCalledOnce();

    act(() => api?.stop());
    expect(input?.signal?.aborted).toBe(true);
    expect(api).toMatchObject({ error: null, running: false, status: "cancelled" });
    expect(messageText(api?.messages.at(-1))).toBe("Partial");
    await act(async () => expect(await send).toBe(false));
    deferred.resolve(completedRun("late result"));
    expect(messageText(api?.messages.at(-1))).toBe("Partial");
  });

  it("aborts stale scope work and resets sessions only for a new workspace", async () => {
    let deferred = createDeferred<WorkspaceAgentRunResult>();
    let input: WorkspaceAgentRunInput | undefined;
    let runner: WorkspaceAgentRunner = (nextInput) => {
      input = nextInput;
      return deferred.promise;
    };
    let options = { runner, scopeKey: "doc-a", workspaceKey: "workspace-a" };
    await mount(options);

    await act(async () => expect(await api?.send("Missing host", () => null)).toBe(false));
    expect(api).toMatchObject({ errorCode: "missing-workspace", status: "error" });

    let send!: Promise<boolean>;
    await act(async () => {
      send = api!.send("Edit this", () => host);
      await Promise.resolve();
    });
    await rerender({ ...options, scopeKey: "doc-b" });
    expect(input?.signal?.aborted).toBe(true);
    expect(api?.messages.map(messageText)).toEqual(["Edit this"]);
    act(() => input?.onEvent?.({ delta: "late", type: "text-delta" }));
    await act(async () => expect(await send).toBe(false));

    let firstSession = api!.activeSessionId;
    act(() => {
      api?.newChat();
    });
    expect(api?.sessions).toHaveLength(2);
    expect(api?.activeSessionId).not.toBe(firstSession);

    await rerender({ ...options, scopeKey: "doc-b", workspaceKey: "workspace-b" });
    expect(api?.sessions).toHaveLength(1);
    expect(api?.messages).toEqual([]);
    expect(api?.hasApiKey).toBe(true);
    deferred.resolve(completedRun("late result"));
  });

  it("keeps parallel session output with the session that started it", async () => {
    let runs = new Map<string, ReturnType<typeof createRun>>();
    let runner: WorkspaceAgentRunner = (input) => {
      let prompt = input.messages.at(-1)?.content;
      if (!prompt) throw new Error("Expected an Agent prompt.");
      let run = createRun(input);
      runs.set(prompt, run);
      return run.deferred.promise;
    };
    await mount({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });

    let sessionA = api!.activeSessionId;
    let sendA!: Promise<boolean>;
    await act(async () => {
      sendA = api!.send("Run A", () => hostA);
      await Promise.resolve();
    });
    act(() => {
      api?.newChat();
    });
    let sessionB = api!.activeSessionId;
    let sendB!: Promise<boolean>;
    await act(async () => {
      sendB = api!.send("Run B", () => hostB);
      await Promise.resolve();
    });

    expect(runs.get("Run A")?.input.host).toBe(hostA);
    expect(runs.get("Run B")?.input.host).toBe(hostB);
    act(() => api?.selectSession(sessionA));
    await act(async () => {
      runs.get("Run B")?.input.onEvent?.({ delta: "B background", type: "text-delta" });
      runs.get("Run B")?.deferred.resolve(completedRun("B background complete"));
      expect(await sendB).toBe(true);
    });
    expect(api?.activeSessionId).toBe(sessionA);
    expect(api?.messages.map(messageText).join(" ")).not.toContain("B");
    expect(api?.sessions.find(({ id }) => id == sessionB)?.status).toBe("success");

    act(() => api?.selectSession(sessionB));
    await waitUntil(() => messageText(api?.messages.at(-1)) == "B background complete");
    expect(api?.messages.map(messageText)).toEqual(["Run B", "B background complete"]);
    runs.get("Run A")?.deferred.resolve(completedRun("A complete"));
    await act(async () => expect(await sendA).toBe(true));
  });

  it("survives StrictMode setup and aborts active work when credentials lock", async () => {
    let deferred = createDeferred<WorkspaceAgentRunResult>();
    let input: WorkspaceAgentRunInput | undefined;
    await mount(
      {
        runner: (nextInput) => {
          input = nextInput;
          return deferred.promise;
        },
        scopeKey: "doc-a",
        workspaceKey: "workspace-a",
      },
      true,
    );

    let send!: Promise<boolean>;
    await act(async () => {
      send = api!.send("Strict run", () => host);
      await Promise.resolve();
    });
    expect(credentials.listenerCount()).toBe(1);
    act(() => credentials.set(null));

    expect(input?.signal?.aborted).toBe(true);
    expect(api).toMatchObject({ hasApiKey: false, status: "cancelled" });
    await act(async () => expect(await send).toBe(false));
    deferred.resolve(completedRun("late result"));
  });
});

async function mount(options: TestOptions, strict = false) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await render(options, strict);
}

async function rerender(options: TestOptions) {
  await render(options, false);
}

async function render(options: TestOptions, strict: boolean) {
  let harness = <Harness options={resolveOptions(options)} />;
  await act(async () => root?.render(strict ? <StrictMode>{harness}</StrictMode> : harness));
}

function resolveOptions(options: TestOptions): UseWorkspaceAgentOptions {
  return {
    ...options,
    getApiKey: credentials.get,
    subscribeToCredentials: (listener) => credentials.subscribe(listener),
    throttleMs: 0,
  };
}

function Harness({ options }: { options: UseWorkspaceAgentOptions }) {
  api = useWorkspaceAgent(options);
  return null;
}

function credentialSource(initial: string | null) {
  let value = initial;
  let listeners = new Set<() => void>();
  return {
    get: () => value,
    listenerCount: () => listeners.size,
    set(next: string | null) {
      value = next;
      for (let listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
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
  let promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createRun(input: WorkspaceAgentRunInput) {
  return { deferred: createDeferred<WorkspaceAgentRunResult>(), input };
}

function completedRun(content: string): WorkspaceAgentRunResult {
  return { finishReason: "stop", message: { content, role: "assistant" }, usage: {} };
}

const host = {} as WorkspaceAgentHost;
const hostA = {} as WorkspaceAgentHost;
const hostB = {} as WorkspaceAgentHost;
