import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vite-plus/test";
import { runWorkspaceAgentWithAiSdkModel } from "./adapters/ai-sdk/runner.ts";
import type { WorkspaceAgentHost } from "./application/host-port.ts";
import { WORKSPACE_AGENT_MAX_STEPS } from "./application/policy.ts";
import { redactWorkspaceAgentError } from "./application/runtime-error.ts";
import type { WorkspaceAgentRunEvent } from "./application/run-contracts.ts";
import { createWorkspaceAgentToolSession } from "./application/tool-session.ts";
import type { WorkspaceAgentActiveDocumentVersion } from "./domain/active-document.ts";
import type { WorkspaceAgentApplyCurrentDocumentEditsResult } from "./domain/contracts.ts";
import { createOpenAIWorkspaceAgentModel } from "./providers/openai/model.ts";

describe("AI SDK workspace Agent adapter", () => {
  it("streams a deterministic search, read, edit, and final response tool loop", async () => {
    let mocks = fakeHost();
    mocks.readMarkdown
      .mockResolvedValueOnce(activeReadResult(activeVersion))
      .mockResolvedValueOnce(activeReadResult(activeVersion2));
    mocks.applyCurrentDocumentEdits
      .mockReturnValueOnce(staleResult())
      .mockReturnValueOnce(appliedResult());
    let model = new MockLanguageModelV4({
      modelId: "mock-markdown-agent",
      provider: "mock",
      doStream: [
        toolCallStream("search-1", "search_markdown", { query: "needle" }),
        toolCallStream("read-1", "read_markdown", { path: "draft.md" }),
        toolCallStream("edit-1", "apply_current_document_edits", {
          edits: [{ newText: "updated", oldText: "needle" }],
          version: activeVersion,
        }),
        toolCallStream("reread-1", "read_markdown", { path: "draft.md" }),
        toolCallStream("edit-2", "apply_current_document_edits", {
          edits: [{ newText: "updated", oldText: "needle" }],
          version: activeVersion2,
        }),
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
        providerOptions: { openai: { parallelToolCalls: false, store: false } },
      },
    );

    expect(result).toEqual({
      finishReason: "stop",
      message: { content: "Updated draft.md.", role: "assistant" },
      usage: { inputTokens: 6, outputTokens: 6, totalTokens: 12 },
    });
    expect(mocks.searchMarkdown).toHaveBeenCalledOnce();
    expect(mocks.searchMarkdown).toHaveBeenCalledWith({ query: "needle" }, expect.any(AbortSignal));
    expect(mocks.readMarkdown).toHaveBeenNthCalledWith(
      1,
      { path: "draft.md" },
      expect.any(AbortSignal),
    );
    expect(mocks.readMarkdown).toHaveBeenNthCalledWith(
      2,
      { path: "draft.md" },
      expect.any(AbortSignal),
    );
    expect(mocks.applyCurrentDocumentEdits).toHaveBeenNthCalledWith(
      1,
      {
        edits: [{ newText: "updated", oldText: "needle" }],
        version: activeVersion,
      },
      expect.any(AbortSignal),
    );
    expect(mocks.applyCurrentDocumentEdits).toHaveBeenNthCalledWith(
      2,
      {
        edits: [{ newText: "updated", oldText: "needle" }],
        version: activeVersion2,
      },
      expect.any(AbortSignal),
    );
    expect(model.doStreamCalls).toHaveLength(6);
    expect(model.doStreamCalls[0]?.providerOptions).toEqual({
      openai: { parallelToolCalls: false, store: false },
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

  it("deduplicates toolCallId executions and enforces two post-conflict stale retries", async () => {
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
    await expect(session.readMarkdown({ path: "draft.md" }, searchExecution)).rejects.toThrow(
      /reused with different semantics/,
    );
    expect(mocks.readMarkdown).not.toHaveBeenCalled();

    mocks.applyCurrentDocumentEdits.mockReturnValue(staleResult());
    let editInput = {
      edits: [{ newText: "updated", oldText: "needle" }],
      version: activeVersion,
    };
    for (let index = 0; index < 3; index++) {
      await expect(
        session.applyCurrentDocumentEdits(editInput, toolExecution(`stale-${index}`)),
      ).resolves.toMatchObject({ reason: "stale-version", status: "not-applied" });
    }
    await expect(
      session.applyCurrentDocumentEdits(editInput, toolExecution("stale-limit")),
    ).resolves.toMatchObject({ reason: "stale-retry-limit", status: "not-applied" });
    expect(mocks.applyCurrentDocumentEdits).toHaveBeenCalledTimes(3);
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

  it("honors AbortSignal before budget branches and passes it to the model", async () => {
    let mocks = fakeHost();
    let session = createWorkspaceAgentToolSession(mocks.host);
    let stopped = new AbortController();
    stopped.abort(new DOMException("Stopped", "AbortError"));

    expect(() =>
      session.applyCurrentDocumentEdits(
        { edits: [{ newText: "updated", oldText: "needle" }], version: activeVersion },
        toolExecution("stopped-tool", stopped.signal),
      ),
    ).toThrowError(expect.objectContaining({ name: "AbortError" }));
    expect(mocks.applyCurrentDocumentEdits).not.toHaveBeenCalled();

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

  it("keeps OpenAI-specific model policy in the provider binding", () => {
    let binding = createOpenAIWorkspaceAgentModel("sk-test", "  gpt-test  ");

    expect(binding.modelId).toBe("gpt-test");
    expect(binding.model).toBeDefined();
    expect(binding.providerOptions).toEqual({
      openai: { parallelToolCalls: false, store: false },
    });
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
  let applyCurrentDocumentEdits = vi.fn<WorkspaceAgentHost["applyCurrentDocumentEdits"]>(() =>
    appliedResult(),
  );
  let getContext = vi.fn<WorkspaceAgentHost["getContext"]>(() => ({
    activeDocument: { dirty: false, path: "draft.md", version: activeVersion },
    capabilities: {
      applyCurrentDocumentEdits: true,
      listMarkdown: true,
      readMarkdown: true,
      searchMarkdown: true,
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
  let readMarkdown = vi.fn<WorkspaceAgentHost["readMarkdown"]>(async () =>
    activeReadResult(activeVersion),
  );
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
  let host: WorkspaceAgentHost = {
    applyCurrentDocumentEdits,
    getContext,
    listMarkdown,
    readMarkdown,
    searchMarkdown,
  };
  return {
    applyCurrentDocumentEdits,
    getContext,
    host,
    listMarkdown,
    readMarkdown,
    searchMarkdown,
  };
}

const activeVersion = {
  contentHash: "hash:needle",
  documentGeneration: 1,
  documentId: "doc:draft.md",
  editVersion: 1,
  path: "draft.md",
  targetGeneration: 1,
  version: 1,
  workspaceId: "local:test",
} satisfies WorkspaceAgentActiveDocumentVersion;

const activeVersion2 = {
  ...activeVersion,
  contentHash: "hash:needle-v2",
  editVersion: 2,
} satisfies WorkspaceAgentActiveDocumentVersion;

function activeReadResult(version: WorkspaceAgentActiveDocumentVersion) {
  return {
    endLine: 1,
    path: "draft.md",
    source: { dirty: false, kind: "active-document" as const, version },
    startLine: 1,
    status: "found" as const,
    text: "needle",
    totalBytes: 6,
    totalLines: 1,
    truncated: false,
  };
}

function appliedResult(): WorkspaceAgentApplyCurrentDocumentEditsResult {
  return {
    appliedEdits: 1,
    outputBytes: 7,
    path: "draft.md",
    status: "applied",
  };
}

function staleResult(): WorkspaceAgentApplyCurrentDocumentEditsResult {
  return {
    conflicts: ["editVersion"],
    message: "Read again.",
    path: "draft.md",
    reason: "stale-version",
    status: "not-applied",
  };
}

function toolExecution(callId: string, signal?: AbortSignal) {
  return {
    callId,
    signal,
  };
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
