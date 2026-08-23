import type { WorkspaceAgentHost } from "./workspace-agent-host.ts";

export const DEFAULT_WORKSPACE_AGENT_MODEL = "gpt-5.4-mini";
export const DEFAULT_WORKSPACE_AGENT_RUN_TIMEOUT_MS = 120_000;
export const MAX_WORKSPACE_AGENT_RUN_TIMEOUT_MS = 10 * 60_000;
export const WORKSPACE_AGENT_MAX_STEPS = 12;
export const WORKSPACE_AGENT_MAX_STALE_RETRIES = 2;

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

export type WorkspaceAgentRunInput = {
  apiKey: string;
  host: WorkspaceAgentHost;
  messages: readonly WorkspaceAgentMessage[];
  model?: string;
  onEvent?: (event: WorkspaceAgentRunEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type WorkspaceAgentRunResult = {
  finishReason: WorkspaceAgentFinishReason;
  message: WorkspaceAgentMessage & { role: "assistant" };
  usage: WorkspaceAgentUsage;
};
