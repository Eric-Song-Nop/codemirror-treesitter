import { createUIMessageStream, type ChatTransport, type UIMessage, type UIMessageChunk } from "ai";
import type {
  WorkspaceAgentHost,
  WorkspaceAgentWriteControl,
} from "@/lib/agent/application/host-port";
import { redactWorkspaceAgentErrorMessage } from "@/lib/agent/application/runtime-error";
import type { WorkspaceAgentRunResult } from "@/lib/agent/application/run-contracts";
import type { WorkspaceAgentChangeSummary } from "@/lib/agent/domain/contracts";
import type {
  DeepSeekWorkspaceAgentRunInput,
  WorkspaceAgentModel,
} from "@/lib/agent/providers/deepseek/config";

type WorkspaceAgentRunner = (
  input: DeepSeekWorkspaceAgentRunInput,
) => Promise<WorkspaceAgentRunResult>;

type WorkspaceAgentTransportOptions = {
  getConfiguration: () => {
    apiKey: string;
    host: WorkspaceAgentHost;
    model: WorkspaceAgentModel;
    runner: WorkspaceAgentRunner;
    writeControl?: WorkspaceAgentWriteControl;
  };
};

/** Display-only tool output: status plus, for writes, the path and change. */
export type WorkspaceAgentToolDisplayOutput = {
  change?: WorkspaceAgentChangeSummary;
  path?: string;
  status: "deduplicated" | "denied" | "not-applied" | "success";
};

export function createWorkspaceAgentChatTransport({
  getConfiguration,
}: WorkspaceAgentTransportOptions): ChatTransport<UIMessage> {
  return {
    reconnectToStream: async () => null,
    sendMessages: async ({ chatId, messages, abortSignal }) => {
      let configuration = getConfiguration();
      let responseId = `${chatId}-response-${messages.length}`;
      return createUIMessageStream({
        onError: (error) => redactWorkspaceAgentErrorMessage(error, configuration.apiKey),
        execute: async ({ writer }) => {
          let text = "";
          let toolIds = new Map<string, string>();
          let edits = new Map<string, { change: WorkspaceAgentChangeSummary; path: string }>();
          let write = (chunk: UIMessageChunk) => {
            if (!abortSignal?.aborted) writer.write(chunk);
          };
          let writeText = (delta: string) => {
            if (!delta) return;
            if (!text) write({ id: `${responseId}-text`, type: "text-start" });
            text += delta;
            write({ delta, id: `${responseId}-text`, type: "text-delta" });
          };
          let toolId = (callId: string, name: string, target?: Record<string, string>) => {
            let id = toolIds.get(callId);
            if (id) return id;
            id = `${responseId}-tool-${toolIds.size + 1}`;
            toolIds.set(callId, id);
            write({
              dynamic: true,
              // Only display-safe targets (path, directory, query) are surfaced.
              input: target ?? {},
              toolCallId: id,
              toolName: name,
              type: "tool-input-available",
            });
            return id;
          };

          write({ messageId: responseId, type: "start" });
          let result = await configuration.runner({
            apiKey: configuration.apiKey,
            host: configuration.host,
            messages: textMessages(messages),
            model: configuration.model,
            onEvent: (event) => {
              if (event.type == "text-delta") writeText(event.delta);
              else if (event.type == "tool-start") {
                toolId(event.toolCallId, event.toolName, event.target);
              } else if (event.type == "file-edit-applied") {
                edits.set(event.toolCallId, { change: event.change, path: event.path });
              } else if (event.type == "tool-finish" || event.type == "tool-deduplicated") {
                let id = toolId(event.toolCallId, event.toolName);
                if (event.type == "tool-finish" && event.outcome == "error") {
                  write({
                    errorText: "error",
                    toolCallId: id,
                    type: "tool-output-error",
                  });
                } else {
                  let output: WorkspaceAgentToolDisplayOutput = {
                    ...edits.get(event.toolCallId),
                    status:
                      event.type == "tool-deduplicated"
                        ? "deduplicated"
                        : event.result?.reason == "denied"
                          ? "denied"
                          : event.result?.status == "not-applied"
                            ? "not-applied"
                            : "success",
                  };
                  write({
                    output,
                    toolCallId: id,
                    type: "tool-output-available",
                  });
                }
              }
            },
            signal: abortSignal,
            writeControl: configuration.writeControl,
          });
          writeText(result.message.content.slice(text.length));
          if (text) write({ id: `${responseId}-text`, type: "text-end" });
          write({ finishReason: result.finishReason, type: "finish" });
        },
      });
    },
  };
}

function textMessages(messages: UIMessage[]) {
  return messages.flatMap((message) => {
    if (message.role != "assistant" && message.role != "user") return [];
    let content = message.parts.flatMap((part) => (part.type == "text" ? part.text : [])).join("");
    return content ? [{ content, role: message.role }] : [];
  });
}
