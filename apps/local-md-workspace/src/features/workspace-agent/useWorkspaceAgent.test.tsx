// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { flushSync } from "react-dom";
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

  it("re-reads a stable private credential getter on revision changes and snapshots each run", async () => {
    let firstRun = createDeferred<WorkspaceAgentRunResult>();
    let inputs: WorkspaceAgentRunInput[] = [];
    let runner: WorkspaceAgentRunner = (input) => {
      inputs.push(input);
      return input.messages.at(-1)?.content == "First credential"
        ? firstRun.promise
        : Promise.resolve(completedRun("Replacement credential response"));
    };
    let credential = "sk-revision-first";
    let getApiKey = vi.fn(() => credential);
    let options = {
      credentialRevision: 1,
      getApiKey,
      runner,
      scopeKey: "doc-a",
      workspaceKey: "workspace-a",
    };
    await renderHook(options);

    expect(getApiKey).toHaveBeenCalledOnce();
    expect(currentApi?.hasApiKey).toBe(true);
    expect(JSON.stringify(currentApi)).not.toContain(credential);

    credential = "sk-revision-replacement";
    await rerenderHook(options);
    expect(getApiKey).toHaveBeenCalledOnce();

    let firstSend!: Promise<boolean>;
    await act(async () => {
      firstSend = currentApi!.send("First credential", () => hostA);
      await Promise.resolve();
    });
    await waitUntil(() => inputs.length == 1);
    expect(inputs[0]).toMatchObject({ apiKey: "sk-revision-first", host: hostA });

    await rerenderHook({ ...options, credentialRevision: 2 });
    expect(getApiKey).toHaveBeenCalledTimes(2);
    expect(inputs[0]?.signal?.aborted).toBe(false);

    act(() => {
      currentApi!.newChat();
    });
    await act(async () => {
      expect(await currentApi!.send("Replacement credential", () => hostB)).toBe(true);
    });
    expect(inputs[1]).toMatchObject({ apiKey: "sk-revision-replacement", host: hostB });
    expect(inputs[0]?.signal?.aborted).toBe(false);
    expect(JSON.stringify(currentApi)).not.toContain("sk-revision-first");
    expect(JSON.stringify(currentApi)).not.toContain("sk-revision-replacement");

    await act(async () => {
      firstRun.resolve(completedRun("First credential response"));
      expect(await firstSend).toBe(true);
    });
  });

  it("reactivates its private controller after the StrictMode effect probe", async () => {
    let inputs: WorkspaceAgentRunInput[] = [];
    let runner: WorkspaceAgentRunner = async (input) => {
      inputs.push(input);
      return completedRun("Strict response");
    };
    await renderStrictHook({
      credentialRevision: 1,
      getApiKey: () => "sk-strict-mode",
      runner,
      scopeKey: "doc-a",
      workspaceKey: "workspace-a",
    });

    expect(currentApi?.hasApiKey).toBe(true);
    await act(async () => {
      expect(await currentApi!.send("Strict request", () => host)).toBe(true);
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.apiKey).toBe("sk-strict-mode");
  });

  it("stops every session when a credential revision locks the private key", async () => {
    let firstRun = createDeferred<WorkspaceAgentRunResult>();
    let secondRun = createDeferred<WorkspaceAgentRunResult>();
    let inputs = new Map<string, WorkspaceAgentRunInput>();
    let runner: WorkspaceAgentRunner = (input) => {
      let prompt = input.messages.at(-1)?.content;
      if (!prompt) throw new Error("Expected a prompt for the Agent run.");
      inputs.set(prompt, input);
      return prompt == "Credential run A" ? firstRun.promise : secondRun.promise;
    };
    let credential: string | null = "sk-lock-revision";
    let getApiKey = vi.fn(() => credential);
    let options = {
      credentialRevision: 1,
      getApiKey,
      runner,
      scopeKey: "doc-a",
      workspaceKey: "workspace-a",
    };
    await renderHook(options);

    let sessionA = currentApi!.activeSessionId;
    let sendA!: Promise<boolean>;
    await act(async () => {
      sendA = currentApi!.send("Credential run A", () => hostA);
      await Promise.resolve();
    });
    await waitUntil(() => inputs.has("Credential run A"));

    act(() => {
      currentApi!.newChat();
    });
    let sessionB = currentApi!.activeSessionId;
    let sendB!: Promise<boolean>;
    await act(async () => {
      sendB = currentApi!.send("Credential run B", () => hostB);
      await Promise.resolve();
    });
    await waitUntil(() => inputs.has("Credential run B"));

    credential = null;
    await rerenderHook({ ...options, credentialRevision: 2 });

    expect(getApiKey).toHaveBeenCalledTimes(2);
    expect(currentApi?.hasApiKey).toBe(false);
    expect(inputs.get("Credential run A")?.signal?.aborted).toBe(true);
    expect(inputs.get("Credential run B")?.signal?.aborted).toBe(true);
    expect(currentApi?.sessions.find((session) => session.id == sessionA)?.status).toBe(
      "cancelled",
    );
    expect(currentApi?.sessions.find((session) => session.id == sessionB)?.status).toBe(
      "cancelled",
    );
    await act(async () => {
      expect(await Promise.all([sendA, sendB])).toEqual([false, false]);
    });

    let runnerCount = inputs.size;
    await act(async () => {
      expect(await currentApi!.send("Must stay locked", () => host)).toBe(false);
    });
    expect(inputs.size).toBe(runnerCount);
    expect(currentApi?.errorCode).toBe("missing-api-key");
    expect(JSON.stringify(currentApi)).not.toContain("sk-lock-revision");

    firstRun.resolve(completedRun("late A"));
    secondRun.resolve(completedRun("late B"));
    await act(async () => Promise.resolve());
  });

  it("aborts every session synchronously when the credential subscription locks", async () => {
    let firstRun = createDeferred<WorkspaceAgentRunResult>();
    let secondRun = createDeferred<WorkspaceAgentRunResult>();
    let inputs = new Map<string, WorkspaceAgentRunInput>();
    let runner: WorkspaceAgentRunner = (input) => {
      let prompt = input.messages.at(-1)?.content;
      if (!prompt) throw new Error("Expected a prompt for the Agent run.");
      inputs.set(prompt, input);
      return prompt == "Subscribed run A" ? firstRun.promise : secondRun.promise;
    };
    let credential: string | null = "sk-subscribed-credential";
    let credentialListeners = new Set<() => void>();
    let subscribeToCredentials = vi.fn((listener: () => void) => {
      credentialListeners.add(listener);
      return () => {
        credentialListeners.delete(listener);
      };
    });
    await renderHook({
      credentialRevision: 1,
      getApiKey: () => credential,
      runner,
      scopeKey: "doc-a",
      subscribeToCredentials,
      workspaceKey: "workspace-a",
    });
    expect(credentialListeners.size).toBe(1);

    let sendA!: Promise<boolean>;
    await act(async () => {
      sendA = currentApi!.send("Subscribed run A", () => hostA);
      await Promise.resolve();
    });
    await waitUntil(() => inputs.has("Subscribed run A"));

    act(() => {
      currentApi!.newChat();
    });
    let sendB!: Promise<boolean>;
    await act(async () => {
      sendB = currentApi!.send("Subscribed run B", () => hostB);
      await Promise.resolve();
    });
    await waitUntil(() => inputs.has("Subscribed run B"));

    act(() => {
      credential = null;
      for (let listener of credentialListeners) {
        listener();
        expect(inputs.get("Subscribed run A")?.signal?.aborted).toBe(true);
        expect(inputs.get("Subscribed run B")?.signal?.aborted).toBe(true);
      }
    });

    expect(currentApi?.hasApiKey).toBe(false);
    expect(currentApi?.sessions.map((session) => session.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    await act(async () => {
      expect(await Promise.all([sendA, sendB])).toEqual([false, false]);
    });

    firstRun.resolve(completedRun("late subscribed A"));
    secondRun.resolve(completedRun("late subscribed B"));
    await act(async () => Promise.resolve());
  });

  it("cannot reconfigure or send through retained callbacks after unmount", async () => {
    let runner = vi.fn<WorkspaceAgentRunner>(async () => completedRun("Must not run"));
    await renderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });
    act(() => currentApi!.configure({ apiKey: "sk-before-unmount" }));
    expect(currentApi?.hasApiKey).toBe(true);

    let retainedConfigure = currentApi!.configure;
    let retainedSend = currentApi!.send;
    await act(async () => {
      root?.unmount();
      root = null;
    });

    retainedConfigure({ apiKey: "sk-after-unmount" });
    let createHost = vi.fn(() => host);
    await expect(retainedSend("Must remain disposed", createHost)).resolves.toBe(false);

    expect(createHost).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
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
        toolName: "read_file",
        type: "tool-start",
      });
      input.onEvent?.({
        durationMs: 4,
        outcome: "success",
        toolCallId: "private-call-id",
        toolName: "read_file",
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
    expect(toolPart && getToolName(toolPart)).toBe("read_file");
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

  it("snapshots the runner when a send starts before the transport microtask", async () => {
    let runnerA = vi.fn<WorkspaceAgentRunner>(async () => completedRun("Runner A response"));
    let runnerB = vi.fn<WorkspaceAgentRunner>(async () => completedRun("Runner B response"));
    let optionsA = { runner: runnerA, scopeKey: "doc-a", workspaceKey: "workspace-a" };
    let optionsB = { runner: runnerB, scopeKey: "doc-a", workspaceKey: "workspace-a" };
    await renderHook(optionsA);
    act(() => currentApi?.configure({ apiKey: "sk-secret" }));

    let sendA!: Promise<boolean>;
    await act(async () => {
      sendA = currentApi!.send("Use runner A", () => hostA);
      expect(runnerA).not.toHaveBeenCalled();
      flushSync(() => {
        root?.render(<WorkspaceAgentHarness options={{ throttleMs: 0, ...optionsB }} />);
      });
      expect(runnerA).not.toHaveBeenCalled();
      expect(runnerB).not.toHaveBeenCalled();
    });

    await act(async () => expect(await sendA).toBe(true));
    expect(runnerA).toHaveBeenCalledOnce();
    expect(runnerB).not.toHaveBeenCalled();
    expect(messageText(currentApi?.messages.at(-1))).toBe("Runner A response");

    act(() => {
      currentApi!.newChat();
    });
    await act(async () => {
      expect(await currentApi!.send("Use runner B", () => hostB)).toBe(true);
    });
    expect(runnerA).toHaveBeenCalledOnce();
    expect(runnerB).toHaveBeenCalledOnce();
    expect(messageText(currentApi?.messages.at(-1))).toBe("Runner B response");
  });

  it("keeps parallel sessions running while switching and routes background output to its owner", async () => {
    let deferredA = createDeferred<WorkspaceAgentRunResult>();
    let deferredB = createDeferred<WorkspaceAgentRunResult>();
    let runnerInputs = new Map<string, WorkspaceAgentRunInput>();
    let runner: WorkspaceAgentRunner = (input) => {
      let prompt = input.messages.at(-1)?.content;
      if (!prompt) throw new Error("Expected a prompt for the Agent run.");
      runnerInputs.set(prompt, input);
      if (prompt == "Run A") return deferredA.promise;
      if (prompt == "Run B") return deferredB.promise;
      throw new Error(`Unexpected Agent prompt: ${prompt}`);
    };
    await renderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });
    act(() => currentApi?.configure({ apiKey: "sk-secret" }));

    let sessionA = currentApi!.activeSessionId;
    let sendA!: Promise<boolean>;
    await act(async () => {
      sendA = currentApi!.send("Run A", () => hostA);
      await Promise.resolve();
    });
    await waitUntil(() => runnerInputs.has("Run A"));

    await act(async () => {
      currentApi!.newChat();
      await Promise.resolve();
    });
    let sessionB = currentApi!.activeSessionId;
    expect(sessionB).not.toBe(sessionA);
    expect(currentApi?.sessions).toHaveLength(2);
    expect(currentApi?.sessions.find((session) => session.id == sessionA)).toMatchObject({
      status: "running",
      title: "Run A",
    });
    expect(runnerInputs.get("Run A")?.signal?.aborted).toBe(false);

    let sendB!: Promise<boolean>;
    await act(async () => {
      sendB = currentApi!.send("Run B", () => hostB);
      await Promise.resolve();
    });
    await waitUntil(() => runnerInputs.has("Run B"));
    expect(runnerInputs.get("Run A")?.host).toBe(hostA);
    expect(runnerInputs.get("Run B")?.host).toBe(hostB);

    await act(async () => {
      currentApi!.selectSession(sessionA);
      await Promise.resolve();
    });
    expect(currentApi?.activeSessionId).toBe(sessionA);
    expect(currentApi?.status).toBe("running");
    expect(runnerInputs.get("Run A")?.signal?.aborted).toBe(false);
    expect(runnerInputs.get("Run B")?.signal?.aborted).toBe(false);

    await act(async () => {
      runnerInputs.get("Run B")?.onEvent?.({ delta: "B background", type: "text-delta" });
      await Promise.resolve();
    });
    await act(async () => {
      deferredB.resolve(completedRun("B background complete"));
      expect(await sendB).toBe(true);
    });

    expect(currentApi?.activeSessionId).toBe(sessionA);
    expect(currentApi?.status).toBe("running");
    expect(currentApi?.messages.map(messageText).join("\n")).not.toContain("B background");
    expect(currentApi?.sessions.find((session) => session.id == sessionB)?.status).toBe("success");

    await act(async () => {
      currentApi!.selectSession(sessionB);
      await Promise.resolve();
    });
    await waitUntil(() => messageText(currentApi?.messages.at(-1)) == "B background complete");
    expect(currentApi?.status).toBe("success");
    expect(currentApi?.messages.map((message) => [message.role, messageText(message)])).toEqual([
      ["user", "Run B"],
      ["assistant", "B background complete"],
    ]);

    await act(async () => {
      currentApi!.selectSession(sessionA);
      await Promise.resolve();
    });
    expect(currentApi?.status).toBe("running");
    expect(currentApi?.messages.map(messageText).join("\n")).not.toContain("B background");

    await act(async () => {
      runnerInputs.get("Run A")?.onEvent?.({ delta: "A foreground", type: "text-delta" });
      deferredA.resolve(completedRun("A foreground complete"));
      expect(await sendA).toBe(true);
    });
    expect(currentApi?.status).toBe("success");
    expect(currentApi?.messages.map((message) => [message.role, messageText(message)])).toEqual([
      ["user", "Run A"],
      ["assistant", "A foreground complete"],
    ]);

    await act(async () => {
      currentApi!.selectSession(sessionB);
      await Promise.resolve();
    });
    expect(currentApi?.messages.map((message) => [message.role, messageText(message)])).toEqual([
      ["user", "Run B"],
      ["assistant", "B background complete"],
    ]);
  });

  it("stops only the active session while another session continues running", async () => {
    let deferredA = createDeferred<WorkspaceAgentRunResult>();
    let deferredB = createDeferred<WorkspaceAgentRunResult>();
    let runnerInputs = new Map<string, WorkspaceAgentRunInput>();
    let runner: WorkspaceAgentRunner = (input) => {
      let prompt = input.messages.at(-1)?.content;
      if (!prompt) throw new Error("Expected a prompt for the Agent run.");
      runnerInputs.set(prompt, input);
      return prompt == "Stop A" ? deferredA.promise : deferredB.promise;
    };
    await renderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });
    act(() => currentApi?.configure({ apiKey: "sk-secret" }));

    let sessionA = currentApi!.activeSessionId;
    let sendA!: Promise<boolean>;
    await act(async () => {
      sendA = currentApi!.send("Stop A", () => hostA);
      await Promise.resolve();
    });
    await waitUntil(() => runnerInputs.has("Stop A"));

    act(() => {
      currentApi!.newChat();
    });
    let sessionB = currentApi!.activeSessionId;
    let sendB!: Promise<boolean>;
    await act(async () => {
      sendB = currentApi!.send("Keep B", () => hostB);
      await Promise.resolve();
    });
    await waitUntil(() => runnerInputs.has("Keep B"));

    await act(async () => {
      currentApi!.selectSession(sessionA);
      await Promise.resolve();
    });
    act(() => currentApi!.stop());

    expect(runnerInputs.get("Stop A")?.signal?.aborted).toBe(true);
    expect(runnerInputs.get("Keep B")?.signal?.aborted).toBe(false);
    expect(currentApi?.sessions.find((session) => session.id == sessionA)?.status).toBe(
      "cancelled",
    );
    expect(currentApi?.sessions.find((session) => session.id == sessionB)?.status).toBe("running");
    await act(async () => expect(await sendA).toBe(false));

    await act(async () => {
      currentApi!.selectSession(sessionB);
      await Promise.resolve();
    });
    expect(currentApi?.status).toBe("running");
    await act(async () => {
      deferredB.resolve(completedRun("B completed"));
      expect(await sendB).toBe(true);
    });
    expect(messageText(currentApi?.messages.at(-1))).toBe("B completed");
    expect(currentApi?.status).toBe("success");

    deferredA.resolve(completedRun("late A"));
    await act(async () => Promise.resolve());
    expect(messageText(currentApi?.messages.at(-1))).toBe("B completed");
  });

  it("stops every run and resets the session collection when the workspace changes", async () => {
    let deferredA = createDeferred<WorkspaceAgentRunResult>();
    let deferredB = createDeferred<WorkspaceAgentRunResult>();
    let runnerInputs = new Map<string, WorkspaceAgentRunInput>();
    let runner: WorkspaceAgentRunner = (input) => {
      let prompt = input.messages.at(-1)?.content;
      if (!prompt) throw new Error("Expected a prompt for the Agent run.");
      runnerInputs.set(prompt, input);
      return prompt == "Workspace A" ? deferredA.promise : deferredB.promise;
    };
    await renderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });
    act(() => currentApi?.configure({ apiKey: "sk-secret", model: "deepseek-v4-pro" }));

    let sessionA = currentApi!.activeSessionId;
    let sendA!: Promise<boolean>;
    await act(async () => {
      sendA = currentApi!.send("Workspace A", () => hostA);
      await Promise.resolve();
    });
    await waitUntil(() => runnerInputs.has("Workspace A"));

    act(() => {
      currentApi!.newChat();
    });
    let sessionB = currentApi!.activeSessionId;
    let sendB!: Promise<boolean>;
    await act(async () => {
      sendB = currentApi!.send("Workspace B", () => hostB);
      await Promise.resolve();
    });
    await waitUntil(() => runnerInputs.has("Workspace B"));

    await rerenderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-b" });
    expect(runnerInputs.get("Workspace A")?.signal?.aborted).toBe(true);
    expect(runnerInputs.get("Workspace B")?.signal?.aborted).toBe(true);
    expect(currentApi?.sessions).toHaveLength(1);
    expect(currentApi?.activeSessionId).not.toBe(sessionA);
    expect(currentApi?.activeSessionId).not.toBe(sessionB);
    expect(currentApi?.messages).toEqual([]);
    expect(currentApi?.status).toBe("idle");
    expect(currentApi?.error).toBeNull();
    expect(currentApi?.hasApiKey).toBe(true);
    expect(currentApi?.model).toBe("deepseek-v4-pro");

    await act(async () => {
      expect(await Promise.all([sendA, sendB])).toEqual([false, false]);
    });
    act(() => {
      runnerInputs.get("Workspace A")?.onEvent?.({ delta: "late A", type: "text-delta" });
      runnerInputs.get("Workspace B")?.onEvent?.({ delta: "late B", type: "text-delta" });
      deferredA.resolve(completedRun("late A"));
      deferredB.resolve(completedRun("late B"));
    });
    await act(async () => Promise.resolve());
    expect(currentApi?.messages).toEqual([]);
  });

  it("preserves prior sessions for a new chat, resets them for a new workspace, and reports missing hosts", async () => {
    let runner = vi.fn<WorkspaceAgentRunner>(async () => completedRun("Answer"));
    await renderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-a" });
    act(() => currentApi?.configure({ apiKey: "sk-secret" }));
    let firstSessionId = currentApi!.activeSessionId;

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
    act(() => {
      currentApi?.newChat();
    });
    let secondSessionId = currentApi!.activeSessionId;
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(currentApi?.sessions).toHaveLength(2);
    expect(currentApi?.messages).toEqual([]);

    await act(async () => {
      currentApi!.selectSession(firstSessionId);
      await Promise.resolve();
    });
    expect(currentApi?.messages.map((message) => [message.role, messageText(message)])).toEqual([
      ["user", "Question"],
      ["assistant", "Answer"],
    ]);
    act(() => currentApi!.selectSession(secondSessionId));

    await act(async () => {
      expect(await currentApi?.send("Another", () => host)).toBe(true);
    });
    await rerenderHook({ runner, scopeKey: "doc-a", workspaceKey: "workspace-b" });
    expect(currentApi?.sessions).toHaveLength(1);
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

async function renderStrictHook(options: UseWorkspaceAgentOptions) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <StrictMode>
        <WorkspaceAgentHarness options={{ throttleMs: 0, ...options }} />
      </StrictMode>,
    );
  });
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
const hostA = {} as WorkspaceAgentHost;
const hostB = {} as WorkspaceAgentHost;
