import { WORKSPACE_AGENT_MAX_STALE_RETRIES, WORKSPACE_AGENT_MAX_TOOL_CALLS } from "./policy.ts";
import type {
  WorkspaceAgentApplyCurrentDocumentEditsInput,
  WorkspaceAgentApplyCurrentDocumentEditsResult,
  WorkspaceAgentContext,
  WorkspaceAgentListMarkdownInput,
  WorkspaceAgentListMarkdownResult,
  WorkspaceAgentReadMarkdownInput,
  WorkspaceAgentReadMarkdownResult,
  WorkspaceAgentSearchMarkdownInput,
  WorkspaceAgentSearchResult,
} from "../domain/contracts.ts";
import type { WorkspaceAgentHost } from "./host-port.ts";
import type { WorkspaceAgentRunEvent } from "./run-contracts.ts";

export type WorkspaceAgentToolExecution = {
  callId: string;
  signal?: AbortSignal;
};

export type WorkspaceAgentApplyCurrentDocumentEditsToolResult =
  | WorkspaceAgentApplyCurrentDocumentEditsResult
  | {
      message: string;
      path: string;
      reason: "stale-retry-limit";
      status: "not-applied";
    };

export interface WorkspaceAgentToolSession {
  applyCurrentDocumentEdits(
    input: WorkspaceAgentApplyCurrentDocumentEditsInput,
    execution: WorkspaceAgentToolExecution,
  ): Promise<WorkspaceAgentApplyCurrentDocumentEditsToolResult>;
  getContext(execution: WorkspaceAgentToolExecution): Promise<WorkspaceAgentContext>;
  listMarkdown(
    input: WorkspaceAgentListMarkdownInput,
    execution: WorkspaceAgentToolExecution,
  ): Promise<WorkspaceAgentListMarkdownResult>;
  readMarkdown(
    input: WorkspaceAgentReadMarkdownInput,
    execution: WorkspaceAgentToolExecution,
  ): Promise<WorkspaceAgentReadMarkdownResult>;
  searchMarkdown(
    input: WorkspaceAgentSearchMarkdownInput,
    execution: WorkspaceAgentToolExecution,
  ): Promise<WorkspaceAgentSearchResult>;
}

type ToolDeduplicatedEvent = Extract<WorkspaceAgentRunEvent, { type: "tool-deduplicated" }>;

export function createWorkspaceAgentToolSession(
  host: WorkspaceAgentHost,
  onEvent?: (event: ToolDeduplicatedEvent) => void,
): WorkspaceAgentToolSession {
  let calls = new Map<string, { promise: Promise<unknown>; semanticKey: string }>();
  let staleRetryPending = false;
  let staleRetriesUsed = 0;

  let execute = <OUTPUT>(
    toolName: string,
    toolInput: unknown,
    execution: WorkspaceAgentToolExecution,
    operation: () => OUTPUT | PromiseLike<OUTPUT>,
  ): Promise<OUTPUT> => {
    execution.signal?.throwIfAborted();
    let semanticKey = `${toolName}:${JSON.stringify(toolInput)}`;
    let cached = calls.get(execution.callId);
    if (cached) {
      if (cached.semanticKey != semanticKey) {
        return Promise.reject(
          new Error(`Tool call ID ${execution.callId} was reused with different semantics.`),
        );
      }
      try {
        onEvent?.({
          toolCallId: execution.callId,
          toolName,
          type: "tool-deduplicated",
        });
      } catch {
        // Observers must not interrupt a tool transaction.
      }
      return cached.promise as Promise<OUTPUT>;
    }
    if (calls.size >= WORKSPACE_AGENT_MAX_TOOL_CALLS) {
      return Promise.reject(
        new Error(`The run reached its ${WORKSPACE_AGENT_MAX_TOOL_CALLS} unique tool-call budget.`),
      );
    }

    let pending = Promise.resolve().then(() => {
      execution.signal?.throwIfAborted();
      return operation();
    });
    calls.set(execution.callId, { promise: pending, semanticKey });
    return pending;
  };

  return {
    applyCurrentDocumentEdits: (input, execution) =>
      execute("apply_current_document_edits", input, execution, () => {
        if (staleRetryPending && staleRetriesUsed >= WORKSPACE_AGENT_MAX_STALE_RETRIES) {
          return {
            message: `The run used all ${WORKSPACE_AGENT_MAX_STALE_RETRIES} stale edit retries. Start a new run after reviewing the document.`,
            path: input.version.path,
            reason: "stale-retry-limit" as const,
            status: "not-applied" as const,
          };
        }
        if (staleRetryPending) staleRetriesUsed++;
        let result = host.applyCurrentDocumentEdits(input, execution.signal);
        staleRetryPending = result.status == "not-applied" && result.reason == "stale-version";
        return result;
      }),
    getContext: (execution) =>
      execute("get_workspace_context", {}, execution, () => host.getContext()),
    listMarkdown: (input, execution) =>
      execute("list_markdown_files", input, execution, () =>
        host.listMarkdown(input, execution.signal),
      ),
    readMarkdown: (input, execution) =>
      execute("read_markdown", input, execution, () => host.readMarkdown(input, execution.signal)),
    searchMarkdown: (input, execution) =>
      execute("search_markdown", input, execution, () =>
        host.searchMarkdown(input, execution.signal),
      ),
  };
}
