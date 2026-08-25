import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import {
  createWorkspaceAgentRunHost,
  type WorkspaceAgentHostRefs,
} from "../src/lib/agent/adapters/workspace/run-host.ts";
import { runWorkspaceAgentWithAiSdkModel } from "../src/lib/agent/adapters/ai-sdk/runner.ts";
import type { WorkspaceAgentRunEvent } from "../src/lib/agent/application/run-contracts.ts";
import type { WorkspaceAgentWriteFileResult } from "../src/lib/agent/domain/contracts.ts";
import type { WorkspaceCollaborativeDocument } from "../src/lib/workspace/documents/contracts.ts";
import { createMemoryWorkspaceRuntime } from "../src/test/memory-workspace-runtime.ts";

export type WorkspaceAgentBrowserIntegrationResult = {
  documentId: string;
  editorValue: string;
  loroValue: string;
  localUpdates: number;
  persistedValue: string;
  response: string;
  standaloneBlocked: boolean;
  toolNames: string[];
  unselectedValue: string;
};

/**
 * Runs outside the production entry. Vitest and the Chromium smoke both import
 * this fixture to exercise the browser Agent's complete write path.
 */
export async function runWorkspaceAgentBrowserIntegration(): Promise<WorkspaceAgentBrowserIntegrationResult> {
  let suffix = uniqueSuffix();
  let path = `agent-${suffix}.md`;
  let otherPath = `other-${suffix}.md`;
  let initialValue = "# Browser Agent\n\nbefore\n";
  let expectedValue = "# Browser Agent\n\nafter\n";
  let from = initialValue.indexOf("before");
  let runtime = createMemoryWorkspaceRuntime(
    [
      [path, initialValue],
      [otherPath, "other"],
    ],
    {
      id: `agent-smoke:${suffix}`,
      name: "Agent smoke",
    },
  );
  let view: EditorView | null = null;
  let parent: HTMLDivElement | null = null;
  let unsubscribeLocalUpdates: (() => void) | null = null;

  try {
    let documentState: WorkspaceCollaborativeDocument = await runtime.documents.document(path);
    parent = document.body.appendChild(document.createElement("div"));
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          documentState.liveMdConfig.plugins?.map((plugin) => plugin.extension ?? []) ?? [],
        ],
      }),
    });

    let refs: WorkspaceAgentHostRefs = {
      singleFileSourceRef: { current: null },
      workspaceRuntimeRef: { current: runtime },
    };
    let host = createWorkspaceAgentRunHost(refs);
    if (!host) throw new Error("The workspace registry did not bind to the Agent host.");

    let localUpdates = 0;
    await flushMicrotasks();
    unsubscribeLocalUpdates = documentState.loroDoc.subscribeLocalUpdates(() => localUpdates++);
    let events: WorkspaceAgentRunEvent[] = [];
    let model = new MockLanguageModelV4({
      modelId: "mock-browser-agent",
      provider: "mock",
      doStream: [
        toolCallStream("read-current", "read_file", { path }),
        toolCallStream("edit-current", "write_file", {
          edits: [{ expectedText: "before", from, insert: "after", to: from + 6 }],
          path,
        }),
        textStream("Updated the workspace document."),
      ],
    });

    let result = await runWorkspaceAgentWithAiSdkModel(
      {
        host,
        messages: [{ content: "Replace before with after.", role: "user" }],
        onEvent: (event) => events.push(event),
      },
      { model, modelId: model.modelId },
    );
    await flushMicrotasks();

    let editorValue = view.state.doc.toString();
    let loroValue = documentState.read();
    let persistedValue = runtime.files.get(path) ?? "";
    let unselectedWrite = await host.writeFile({
      edits: [{ expectedText: "other", from: 0, insert: "unselected", to: 5 }],
      path: otherPath,
    });
    let unselectedValue = runtime.files.get(otherPath) ?? "";
    refs.singleFileSourceRef.current = {
      draftId: "standalone",
      kind: "draft",
      name: "outside.md",
    };

    assertIntegrationResult({
      editorValue,
      expectedValue,
      localUpdates,
      loroValue,
      persistedValue,
      result: result.message.content,
      unselectedValue,
      unselectedWrite,
    });

    return {
      documentId: documentState.docId,
      editorValue,
      localUpdates,
      loroValue,
      persistedValue,
      response: result.message.content,
      standaloneBlocked: createWorkspaceAgentRunHost(refs) == null,
      toolNames: events
        .filter((event) => event.type == "tool-start")
        .map((event) => event.toolName),
      unselectedValue,
    };
  } finally {
    unsubscribeLocalUpdates?.();
    view?.destroy();
    parent?.remove();
    await runtime.dispose();
  }
}

function assertIntegrationResult(input: {
  editorValue: string;
  expectedValue: string;
  localUpdates: number;
  loroValue: string;
  persistedValue: string;
  result: string;
  unselectedValue: string;
  unselectedWrite: WorkspaceAgentWriteFileResult;
}) {
  if (input.result != "Updated the workspace document.") {
    throw new Error(`Unexpected fake Agent response: ${input.result}`);
  }
  if (
    input.editorValue != input.expectedValue ||
    input.loroValue != input.expectedValue ||
    input.persistedValue != input.expectedValue
  ) {
    throw new Error(
      `Agent edit did not converge and persist: ${JSON.stringify({
        editorValue: input.editorValue,
        loroValue: input.loroValue,
        persistedValue: input.persistedValue,
      })}`,
    );
  }
  if (input.localUpdates != 1) {
    throw new Error(`Expected one main-peer Loro update, received ${input.localUpdates}.`);
  }
  if (
    input.unselectedWrite.status != "applied" ||
    input.unselectedWrite.persistence.status != "saved" ||
    input.unselectedValue != "unselected"
  ) {
    throw new Error(`The unselected document write failed: ${JSON.stringify(input)}`);
  }
}

function uniqueSuffix() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
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

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
