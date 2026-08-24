import { createUIMessageStream, type ChatTransport, type UIMessage, type UIMessageChunk } from "ai";
import type { WorkspaceAgentRunInput, WorkspaceAgentRunResult } from "./runtime-contracts.ts";
import type { WorkspaceAgentHost } from "./workspace-agent-host.ts";

type WorkspaceAgentRunner = (input: WorkspaceAgentRunInput) => Promise<WorkspaceAgentRunResult>;

type WorkspaceAgentTransportOptions = {
  getConfiguration: () => { apiKey: string; host: WorkspaceAgentHost; model: string };
  runner: WorkspaceAgentRunner;
};

export function createWorkspaceAgentChatTransport({
  getConfiguration,
  runner,
}: WorkspaceAgentTransportOptions): ChatTransport<UIMessage> {
  return {
    reconnectToStream: async () => null,
    sendMessages: async ({ messages, abortSignal }) => {
      let configuration = getConfiguration();
      let responseId = `workspace-agent-${messages.length}`;
      return createUIMessageStream({
        onError: (error) => redactedErrorMessage(error, configuration.apiKey),
        execute: async ({ writer }) => {
          let text = "";
          let toolIds = new Map<string, string>();
          let write = (chunk: UIMessageChunk) => {
            if (!abortSignal?.aborted) writer.write(chunk);
          };
          let writeText = (delta: string) => {
            if (!delta) return;
            if (!text) write({ id: `${responseId}-text`, type: "text-start" });
            text += delta;
            write({ delta, id: `${responseId}-text`, type: "text-delta" });
          };
          let toolId = (callId: string, name: string) => {
            let id = toolIds.get(callId);
            if (id) return id;
            id = `${responseId}-tool-${toolIds.size + 1}`;
            toolIds.set(callId, id);
            write({
              dynamic: true,
              input: {},
              toolCallId: id,
              toolName: name,
              type: "tool-input-available",
            });
            return id;
          };

          write({ messageId: responseId, type: "start" });
          let result = await runner({
            apiKey: configuration.apiKey,
            host: configuration.host,
            messages: textMessages(messages),
            model: configuration.model,
            onEvent: (event) => {
              if (event.type == "text-delta") writeText(event.delta);
              else if (event.type == "tool-start") toolId(event.toolCallId, event.toolName);
              else if (event.type == "tool-finish" || event.type == "tool-deduplicated") {
                let id = toolId(event.toolCallId, event.toolName);
                if (event.type == "tool-finish" && event.outcome == "error") {
                  write({
                    errorText: "error",
                    toolCallId: id,
                    type: "tool-output-error",
                  });
                } else {
                  let status = event.type == "tool-deduplicated" ? "deduplicated" : "success";
                  write({
                    output: { status },
                    toolCallId: id,
                    type: "tool-output-available",
                  });
                }
              }
            },
            signal: abortSignal,
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

function redactedErrorMessage(error: unknown, apiKey: string) {
  let message = error instanceof Error ? error.message : "The Agent request failed.";
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}
