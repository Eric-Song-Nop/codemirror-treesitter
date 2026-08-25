import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import type { LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import {
  createWorkspaceAgentRunHost,
  type WorkspaceAgentHostRefs,
} from "../src/lib/agent/adapters/workspace/run-host.ts";
import { runWorkspaceAgentWithAiSdkModel } from "../src/lib/agent/adapters/ai-sdk/runner.ts";
import type { WorkspaceAgentRunEvent } from "../src/lib/agent/application/run-contracts.ts";
import type { WorkspaceAgentApplyCurrentDocumentEditsResult } from "../src/lib/agent/domain/contracts.ts";
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
  switchedWriteReason: string | null;
  toolNames: string[];
  userEvents: Array<string | null>;
};

/**
 * Runs outside the production entry. Vitest and the Chromium smoke both import
 * this fixture to exercise the browser Agent's complete write path.
 */
export async function runWorkspaceAgentBrowserIntegration(): Promise<WorkspaceAgentBrowserIntegrationResult> {
  let suffix = uniqueSuffix();
  let path = `agent-${suffix}.md`;
  let initialValue = "# Browser Agent\n\nbefore\n";
  let expectedValue = "# Browser Agent\n\nafter\n";
  let runtime = createMemoryWorkspaceRuntime([[path, initialValue]], {
    id: `agent-smoke:${suffix}`,
    name: "Agent smoke",
  });
  let view: EditorView | null = null;
  let parent: HTMLDivElement | null = null;
  let unsubscribeLocalUpdates: (() => void) | null = null;

  try {
    let documentState: WorkspaceCollaborativeDocument = await runtime.documents.document(path);
    let dirtyRef = { current: false };
    let editVersionRef = { current: 0 };
    let editorValueRef = { current: initialValue };
    let userEvents: Array<string | null> = [];
    parent = document.body.appendChild(document.createElement("div"));
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          documentState.liveMdConfig.plugins?.map((plugin) => plugin.extension ?? []) ?? [],
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            dirtyRef.current = true;
            editVersionRef.current += 1;
            editorValueRef.current = update.state.doc.toString();
            userEvents.push(update.transactions.at(-1)?.annotation(Transaction.userEvent) ?? null);
          }),
        ],
      }),
    });

    let refs: WorkspaceAgentHostRefs = {
      activeDocumentGenerationRef: { current: 1 },
      collabDocumentRef: { current: documentState },
      dirtyRef,
      documentTargetGenerationRef: { current: 1 },
      editorElementRef: { current: { view } as LiveMdEditorElement },
      editVersionRef,
      selectedFileSourceRef: { current: runtime },
      selectedFileRef: {
        current: { kind: "file", name: path, path },
      },
      singleFileSourceRef: { current: null },
      workspaceRuntimeRef: { current: runtime },
    };
    let host = createWorkspaceAgentRunHost(refs);
    if (!host) throw new Error("The real collaboration document did not bind to the Agent host.");

    let read = await host.readMarkdown({ path });
    if (read.status != "found" || read.source.kind != "active-document") {
      throw new Error("The Agent did not read the open collaboration document as active.");
    }
    let version = read.source.version;
    let localUpdates = 0;
    await flushMicrotasks();
    unsubscribeLocalUpdates = documentState.loroDoc.subscribeLocalUpdates(() => localUpdates++);
    let events: WorkspaceAgentRunEvent[] = [];
    let model = new MockLanguageModelV4({
      modelId: "mock-browser-agent",
      provider: "mock",
      doStream: [
        toolCallStream("read-current", "read_markdown", { path }),
        toolCallStream("edit-current", "apply_current_document_edits", {
          edits: [{ newText: "after", oldText: "before" }],
          version,
        }),
        textStream("Updated the open document."),
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
    await documentState.flush();
    let persistedValue = runtime.files.get(path) ?? "";

    refs.selectedFileRef.current = {
      kind: "file",
      name: "other.md",
      path: "other.md",
    };
    let switchedWrite = host.applyCurrentDocumentEdits({
      edits: [{ newText: "again", oldText: "after" }],
      version,
    });
    refs.selectedFileRef.current = { kind: "file", name: path, path };
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
      switchedWrite,
      userEvents,
    });

    return {
      documentId: documentState.docId,
      editorValue,
      localUpdates,
      loroValue,
      persistedValue,
      response: result.message.content,
      standaloneBlocked: createWorkspaceAgentRunHost(refs) == null,
      switchedWriteReason: switchedWrite.status == "not-applied" ? switchedWrite.reason : null,
      toolNames: events
        .filter((event) => event.type == "tool-start")
        .map((event) => event.toolName),
      userEvents,
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
  switchedWrite: WorkspaceAgentApplyCurrentDocumentEditsResult;
  userEvents: Array<string | null>;
}) {
  if (input.result != "Updated the open document.") {
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
  if (input.userEvents.length != 1 || input.userEvents[0] != "input.agent") {
    throw new Error(`Expected one input.agent transaction: ${JSON.stringify(input.userEvents)}`);
  }
  if (
    input.switchedWrite.status != "not-applied" ||
    input.switchedWrite.reason != "active-document-unavailable"
  ) {
    throw new Error(
      `A document switch did not fail closed: ${JSON.stringify(input.switchedWrite)}`,
    );
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
