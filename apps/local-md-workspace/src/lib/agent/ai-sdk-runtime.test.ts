import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vite-plus/test";
import { runWorkspaceAgentWithAiSdkModel } from "./adapters/ai-sdk/runner.ts";
import type { WorkspaceAgentHost } from "./application/host-port.ts";
import { WORKSPACE_AGENT_MAX_STEPS, WORKSPACE_AGENT_MAX_TOOL_CALLS } from "./application/policy.ts";
import { redactWorkspaceAgentError } from "./application/runtime-error.ts";
import type { WorkspaceAgentRunEvent } from "./application/run-contracts.ts";
import { createWorkspaceAgentToolSession } from "./application/tool-session.ts";
import type { WorkspaceAgentWriteFileResult } from "./domain/contracts.ts";
import { DEFAULT_WORKSPACE_AGENT_MODEL } from "./providers/deepseek/config.ts";
import { createDeepSeekWorkspaceAgentModel } from "./providers/deepseek/model.ts";

describe("AI SDK workspace Agent adapter", () => {
  it("streams a deterministic search, read, edit, and final response tool loop", async () => {
    let mocks = fakeHost();
    mocks.writeFile.mockResolvedValueOnce(conflictResult()).mockResolvedValueOnce(appliedResult());
    let editInput = {
      edits: [{ expectedText: "needle", from: 0, insert: "updated", to: 6 }],
      path: "draft.md",
    };
    let model = new MockLanguageModelV4({
      modelId: "mock-markdown-agent",
      provider: "mock",
      doStream: [
        toolCallStream("search-1", "search_markdown", { query: "needle" }),
        toolCallStream("read-1", "read_file", { path: "draft.md" }),
        toolCallStream("edit-1", "write_file", editInput),
        toolCallStream("reread-1", "read_file", { path: "draft.md" }),
        toolCallStream("edit-2", "write_file", editInput),
        textStream("Updated ", "draft.md."),
      ],
    });
    let events: WorkspaceAgentRunEvent[] = [];

    let result = await runWorkspaceAgentWithAiSdkModel(
      {
        host: mocks.host,
        messages: [{ content: "Find the needle and update it.", role: "user" }],
        onEvent: (event) => events.push(event),
      },
      {
        model,
        modelId: "mock-markdown-agent",
        providerOptions: { deepseek: { thinking: { type: "enabled" } } },
      },
    );

    expect(result).toEqual({
      finishReason: "stop",
      message: { content: "Updated draft.md.", role: "assistant" },
      usage: { inputTokens: 6, outputTokens: 6, totalTokens: 12 },
    });
    expect(mocks.searchMarkdown).toHaveBeenCalledWith({ query: "needle" }, expect.any(AbortSignal));
    expect(mocks.readFile).toHaveBeenCalledTimes(2);
    expect(mocks.readFile).toHaveBeenCalledWith({ path: "draft.md" }, expect.any(AbortSignal));
    expect(mocks.writeFile).toHaveBeenNthCalledWith(1, editInput, expect.any(AbortSignal));
    expect(mocks.writeFile).toHaveBeenNthCalledWith(2, editInput, expect.any(AbortSignal));
    expect(model.doStreamCalls).toHaveLength(6);
    expect(model.doStreamCalls[0]?.providerOptions).toEqual({
      deepseek: { thinking: { type: "enabled" } },
    });
    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("untrusted data"),
    });
    expect(events[0]).toEqual({ model: "mock-markdown-agent", type: "run-start" });
    expect(events.filter((event) => event.type == "tool-start")).toHaveLength(5);
    expect(events.filter((event) => event.type == "tool-finish")).toHaveLength(5);
    expect(events.filter((event) => event.type == "text-delta")).toEqual([
      { delta: "Updated ", type: "text-delta" },
      { delta: "draft.md.", type: "text-delta" },
    ]);
    expect(events.at(-1)).toEqual({
      finishReason: "stop",
      type: "run-finish",
      usage: { inputTokens: 6, outputTokens: 6, totalTokens: 12 },
    });
  });

  it("deduplicates toolCallId executions by tool name and exact input", async () => {
    let mocks = fakeHost();
    let deduplicated: WorkspaceAgentRunEvent[] = [];
    let session = createWorkspaceAgentToolSession(mocks.host, (event) => deduplicated.push(event));
    let searchExecution = toolExecution("same-search");

    let firstSearch = session.searchMarkdown({ query: "needle" }, searchExecution);
    let secondSearch = session.searchMarkdown({ query: "needle" }, searchExecution);
    await expect(firstSearch).resolves.toMatchObject({ status: "complete" });
    await expect(secondSearch).resolves.toMatchObject({ status: "complete" });
    expect(mocks.searchMarkdown).toHaveBeenCalledOnce();
    expect(deduplicated).toContainEqual({
      toolCallId: "same-search",
      toolName: "search_markdown",
      type: "tool-deduplicated",
    });
    await expect(session.searchMarkdown({ query: "different" }, searchExecution)).rejects.toThrow(
      /reused with different semantics/,
    );
    await expect(session.readFile({ path: "draft.md" }, searchExecution)).rejects.toThrow(
      /reused with different semantics/,
    );
    expect(mocks.readFile).not.toHaveBeenCalled();

    let editInput = {
      edits: [{ expectedText: "needle", from: 0, insert: "updated", to: 6 }],
      path: "draft.md",
    };
    let writeExecution = toolExecution("same-write");
    await expect(
      Promise.all([
        session.writeFile(editInput, writeExecution),
        session.writeFile(editInput, writeExecution),
      ]),
    ).resolves.toHaveLength(2);
    expect(mocks.writeFile).toHaveBeenCalledOnce();
    expect(deduplicated).toContainEqual({
      toolCallId: "same-write",
      toolName: "write_file",
      type: "tool-deduplicated",
    });
  });

  it("stops the model loop at the product step budget", async () => {
    let mocks = fakeHost();
    let model = new MockLanguageModelV4({
      doStream: Array.from({ length: WORKSPACE_AGENT_MAX_STEPS + 1 }, (_, index) =>
        toolCallStream(`search-${index}`, "search_markdown", { query: `needle-${index}` }),
      ),
    });

    let result = await runWorkspaceAgentWithAiSdkModel(
      {
        host: mocks.host,
        messages: [{ content: "Keep searching.", role: "user" }],
      },
      { model, modelId: "mock-step-budget" },
    );

    expect(model.doStreamCalls).toHaveLength(WORKSPACE_AGENT_MAX_STEPS);
    expect(mocks.searchMarkdown).toHaveBeenCalledTimes(WORKSPACE_AGENT_MAX_STEPS);
    expect(result.finishReason).toBe("tool-calls");
  });

  it("limits unique tool calls even when one model step schedules them in parallel", async () => {
    let mocks = fakeHost();
    let session = createWorkspaceAgentToolSession(mocks.host);
    let allowed = Array.from({ length: WORKSPACE_AGENT_MAX_TOOL_CALLS }, (_, index) =>
      session.searchMarkdown(
        { query: `needle-${index}` },
        toolExecution(`parallel-search-${index}`),
      ),
    );

    await expect(Promise.all(allowed)).resolves.toHaveLength(WORKSPACE_AGENT_MAX_TOOL_CALLS);
    await expect(
      session.searchMarkdown(
        { query: "over-budget" },
        toolExecution("parallel-search-over-budget"),
      ),
    ).rejects.toThrow(/unique tool-call budget/);
    await expect(
      session.searchMarkdown({ query: "needle-0" }, toolExecution("parallel-search-0")),
    ).resolves.toMatchObject({ status: "complete" });
    expect(mocks.searchMarkdown).toHaveBeenCalledTimes(WORKSPACE_AGENT_MAX_TOOL_CALLS);
  });

  it("honors AbortSignal before budget branches and passes it to the model", async () => {
    let mocks = fakeHost();
    let session = createWorkspaceAgentToolSession(mocks.host);
    let stopped = new AbortController();
    stopped.abort(new DOMException("Stopped", "AbortError"));

    expect(() =>
      session.writeFile(
        {
          edits: [{ expectedText: "needle", from: 0, insert: "updated", to: 6 }],
          path: "draft.md",
        },
        toolExecution("stopped-tool", stopped.signal),
      ),
    ).toThrowError(expect.objectContaining({ name: "AbortError" }));
    expect(mocks.writeFile).not.toHaveBeenCalled();

    let controller = new AbortController();
    let modelStarted: (signal: AbortSignal) => void = () => {};
    let started = new Promise<AbortSignal>((resolve) => {
      modelStarted = resolve;
    });
    let model = new MockLanguageModelV4({
      doStream: async (options) => {
        let signal = options.abortSignal!;
        modelStarted(signal);
        if (signal.aborted) throw signal.reason;
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      },
    });
    let run = runWorkspaceAgentWithAiSdkModel(
      {
        host: mocks.host,
        messages: [{ content: "Stop this run.", role: "user" }],
        signal: controller.signal,
      },
      { model, modelId: "mock-abort" },
    );
    let modelSignal = await started;
    expect(modelSignal.aborted).toBe(false);
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(modelSignal.aborted).toBe(true);
  });

  it("binds only the supported DeepSeek V4 models with thinking enabled", () => {
    let defaultBinding = createDeepSeekWorkspaceAgentModel("sk-test", undefined);
    let proBinding = createDeepSeekWorkspaceAgentModel("sk-test", "deepseek-v4-pro");

    expect(defaultBinding.modelId).toBe(DEFAULT_WORKSPACE_AGENT_MODEL);
    expect(defaultBinding.model).toBeDefined();
    expect(defaultBinding.providerOptions).toEqual({
      deepseek: { thinking: { type: "enabled" } },
    });
    expect(proBinding.modelId).toBe("deepseek-v4-pro");
    expect(() => createDeepSeekWorkspaceAgentModel("sk-test", "deepseek-chat")).toThrow(
      /Unsupported DeepSeek model/,
    );
  });

  it("redacts API keys from errors without retaining the provider cause", () => {
    let apiKey = "sk-test-secret-value";
    let original = new Error(`Provider rejected ${apiKey}.`, {
      cause: new Error(`raw body containing ${apiKey}`),
    });

    let redacted = redactWorkspaceAgentError(original, apiKey);

    expect(redacted.name).toBe("WorkspaceAgentRuntimeError");
    expect(redacted.message).toBe("Provider rejected [redacted].");
    expect(redacted.cause).toBeUndefined();
    expect(redacted.message).not.toContain(apiKey);
  });
});

function fakeHost() {
  let getContext = vi.fn<WorkspaceAgentHost["getContext"]>(() => ({
    capabilities: {
      listMarkdown: true,
      readFile: true,
      searchMarkdown: true,
      writeFile: true,
    },
    workspace: { id: "local:test", kind: "local", name: "Test" },
  }));
  let listMarkdown = vi.fn<WorkspaceAgentHost["listMarkdown"]>(async () => ({
    directory: "",
    files: [{ name: "draft.md", path: "draft.md" }],
    issues: [],
    scannedDirectories: 1,
    status: "complete" as const,
  }));
  let readFile = vi.fn<WorkspaceAgentHost["readFile"]>(async () => readResult());
  let searchMarkdown = vi.fn<WorkspaceAgentHost["searchMarkdown"]>(async () => ({
    directory: "",
    issues: [],
    matches: [{ column: 1, line: 1, path: "draft.md", preview: "needle" }],
    query: "needle",
    readBytes: 6,
    scannedFiles: 1,
    skippedLargeFiles: 0,
    status: "complete" as const,
  }));
  let writeFile = vi.fn<WorkspaceAgentHost["writeFile"]>(async () => appliedResult());
  let host: WorkspaceAgentHost = {
    getContext,
    listMarkdown,
    readFile,
    searchMarkdown,
    writeFile,
  };
  return { getContext, host, listMarkdown, readFile, searchMarkdown, writeFile };
}

function readResult() {
  return {
    endLine: 1,
    endOffset: 6,
    path: "draft.md",
    startLine: 1,
    startOffset: 0,
    status: "found" as const,
    text: "needle",
    totalBytes: 6,
    totalLines: 1,
    truncated: false,
  };
}

function appliedResult(): WorkspaceAgentWriteFileResult {
  return {
    appliedEdits: 1,
    generation: 1,
    outputBytes: 7,
    path: "draft.md",
    persistence: { status: "saved" },
    status: "applied",
  };
}

function conflictResult(): WorkspaceAgentWriteFileResult {
  return {
    editIndex: 0,
    message: "Read again.",
    path: "draft.md",
    reason: "expected-text-mismatch",
    status: "not-applied",
  };
}

function toolExecution(callId: string, signal?: AbortSignal) {
  return { callId, signal };
}

function toolCallStream(toolCallId: string, toolName: string, input: object) {
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start" as const, warnings: [] },
      {
        input: JSON.stringify(input),
        toolCallId,
        toolName,
        type: "tool-call" as const,
      },
      {
        finishReason: { raw: undefined, unified: "tool-calls" as const },
        type: "finish" as const,
        usage: mockUsage(),
      },
    ]),
  };
}

function textStream(...deltas: string[]) {
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start" as const, warnings: [] },
      { id: "text-1", type: "text-start" as const },
      ...deltas.map((delta) => ({ delta, id: "text-1", type: "text-delta" as const })),
      { id: "text-1", type: "text-end" as const },
      {
        finishReason: { raw: undefined, unified: "stop" as const },
        type: "finish" as const,
        usage: mockUsage(),
      },
    ]),
  };
}

function mockUsage() {
  return {
    inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
    outputTokens: { reasoning: undefined, text: 1, total: 1 },
  };
}
