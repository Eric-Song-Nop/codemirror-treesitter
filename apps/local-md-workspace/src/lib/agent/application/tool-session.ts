import { WORKSPACE_AGENT_MAX_TOOL_CALLS } from "./policy.ts";
import type {
  WorkspaceAgentContext,
  WorkspaceAgentListMarkdownInput,
  WorkspaceAgentListMarkdownResult,
  WorkspaceAgentReadFileInput,
  WorkspaceAgentReadFileResult,
  WorkspaceAgentSearchMarkdownInput,
  WorkspaceAgentSearchResult,
  WorkspaceAgentWriteFileInput,
  WorkspaceAgentWriteFileResult,
} from "../domain/contracts.ts";
import type { WorkspaceAgentHost } from "./host-port.ts";
import type { WorkspaceAgentRunEvent } from "./run-contracts.ts";

export type WorkspaceAgentToolExecution = {
  callId: string;
  signal?: AbortSignal;
};

export interface WorkspaceAgentToolSession {
  getContext(execution: WorkspaceAgentToolExecution): Promise<WorkspaceAgentContext>;
  listMarkdown(
    input: WorkspaceAgentListMarkdownInput,
    execution: WorkspaceAgentToolExecution,
  ): Promise<WorkspaceAgentListMarkdownResult>;
  readFile(
    input: WorkspaceAgentReadFileInput,
    execution: WorkspaceAgentToolExecution,
  ): Promise<WorkspaceAgentReadFileResult>;
  searchMarkdown(
    input: WorkspaceAgentSearchMarkdownInput,
    execution: WorkspaceAgentToolExecution,
  ): Promise<WorkspaceAgentSearchResult>;
  writeFile(
    input: WorkspaceAgentWriteFileInput,
    execution: WorkspaceAgentToolExecution,
  ): Promise<WorkspaceAgentWriteFileResult>;
}

type ToolDeduplicatedEvent = Extract<WorkspaceAgentRunEvent, { type: "tool-deduplicated" }>;

export function createWorkspaceAgentToolSession(
  host: WorkspaceAgentHost,
  onEvent?: (event: ToolDeduplicatedEvent) => void,
): WorkspaceAgentToolSession {
  let calls = new Map<string, { promise: Promise<unknown>; semanticKey: string }>();

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
    getContext: (execution) =>
      execute("get_workspace_context", {}, execution, () => host.getContext()),
    listMarkdown: (input, execution) =>
      execute("list_markdown_files", input, execution, () =>
        host.listMarkdown(input, execution.signal),
      ),
    readFile: (input, execution) =>
      execute("read_file", input, execution, () => host.readFile(input, execution.signal)),
    searchMarkdown: (input, execution) =>
      execute("search_markdown", input, execution, () =>
        host.searchMarkdown(input, execution.signal),
      ),
    writeFile: (input, execution) =>
      execute("write_file", input, execution, () => host.writeFile(input, execution.signal)),
  };
}
