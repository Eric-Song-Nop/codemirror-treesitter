import type { WorkspaceAgentHost } from "./host-port.ts";

export type WorkspaceAgentMessage = {
  content: string;
  role: "assistant" | "user";
};

export type WorkspaceAgentFinishReason =
  | "content-filter"
  | "error"
  | "length"
  | "other"
  | "stop"
  | "tool-calls";

export type WorkspaceAgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type WorkspaceAgentRunEvent =
  | {
      model: string;
      type: "run-start";
    }
  | {
      delta: string;
      type: "text-delta";
    }
  | {
      stepNumber: number;
      type: "step-start";
    }
  | {
      finishReason: WorkspaceAgentFinishReason;
      stepNumber: number;
      toolCalls: number;
      type: "step-finish";
    }
  | {
      toolCallId: string;
      toolName: string;
      type: "tool-start";
    }
  | {
      durationMs: number;
      outcome: "error" | "success";
      toolCallId: string;
      toolName: string;
      type: "tool-finish";
    }
  | {
      toolCallId: string;
      toolName: string;
      type: "tool-deduplicated";
    }
  | {
      finishReason: WorkspaceAgentFinishReason;
      type: "run-finish";
      usage: WorkspaceAgentUsage;
    };

export type WorkspaceAgentRunRequest = {
  host: WorkspaceAgentHost;
  messages: readonly WorkspaceAgentMessage[];
  onEvent?: (event: WorkspaceAgentRunEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type WorkspaceAgentRunResult = {
  finishReason: WorkspaceAgentFinishReason;
  message: WorkspaceAgentMessage & { role: "assistant" };
  usage: WorkspaceAgentUsage;
};
