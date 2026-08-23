import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
  WorkspaceAgentActiveDocumentVersion,
  WorkspaceAgentApplyCurrentDocumentEditsResult,
} from "./contracts.ts";
import {
  createWorkspaceAgentTools,
  redactWorkspaceAgentError,
  runWorkspaceAgentWithLanguageModel,
} from "./ai-sdk-runtime.ts";
import type { WorkspaceAgentRunEvent } from "./runtime-contracts.ts";
import type { WorkspaceAgentHost } from "./workspace-agent-host.ts";

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

    let result = await runWorkspaceAgentWithLanguageModel(
      {
        host: mocks.host,
        messages: [{ content: "Find the needle and update it.", role: "user" }],
        modelId: "mock-markdown-agent",
        onEvent: (event) => events.push(event),
      },
      model,
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
    let tools = createWorkspaceAgentTools(mocks.host, (event) => deduplicated.push(event));
    let searchOptions = toolOptions("same-search");

    let firstSearch = tools.search_markdown.execute({ query: "needle" }, searchOptions);
    let secondSearch = tools.search_markdown.execute({ query: "needle" }, searchOptions);
    await expect(firstSearch).resolves.toMatchObject({ status: "complete" });
    await expect(secondSearch).resolves.toMatchObject({ status: "complete" });
    expect(mocks.searchMarkdown).toHaveBeenCalledOnce();
    expect(deduplicated).toContainEqual({
      toolCallId: "same-search",
      toolName: "search_markdown",
      type: "tool-deduplicated",
    });

    mocks.applyCurrentDocumentEdits.mockReturnValue(staleResult());
    let editInput = {
      edits: [{ newText: "updated", oldText: "needle" }],
      version: activeVersion,
    };
    for (let index = 0; index < 3; index++) {
      await expect(
        tools.apply_current_document_edits.execute(editInput, toolOptions(`stale-${index}`)),
      ).resolves.toMatchObject({ reason: "stale-version", status: "not-applied" });
    }
    await expect(
      tools.apply_current_document_edits.execute(editInput, toolOptions("stale-limit")),
    ).resolves.toMatchObject({ reason: "stale-retry-limit", status: "not-applied" });
    expect(mocks.applyCurrentDocumentEdits).toHaveBeenCalledTimes(3);
  });

  it("honors AbortSignal before budget branches and passes it to the model", async () => {
    let mocks = fakeHost();
    let tools = createWorkspaceAgentTools(mocks.host);
    let stopped = new AbortController();
    stopped.abort(new DOMException("Stopped", "AbortError"));

    expect(() =>
      tools.apply_current_document_edits.execute(
        { edits: [{ newText: "updated", oldText: "needle" }], version: activeVersion },
        toolOptions("stopped-tool", stopped.signal),
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
    let run = runWorkspaceAgentWithLanguageModel(
      {
        host: mocks.host,
        messages: [{ content: "Stop this run.", role: "user" }],
        modelId: "mock-abort",
        signal: controller.signal,
      },
      model,
    );
    let modelSignal = await started;
    expect(modelSignal.aborted).toBe(false);
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(modelSignal.aborted).toBe(true);
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

function toolOptions(toolCallId: string, abortSignal?: AbortSignal) {
  return {
    abortSignal,
    context: {},
    messages: [],
    toolCallId,
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
