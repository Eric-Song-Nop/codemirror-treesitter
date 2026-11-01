import {
  isStepCount,
  ToolLoopAgent,
  type LanguageModel,
  type ModelMessage,
  type ToolLoopAgentSettings,
} from "ai";
import {
  resolveWorkspaceAgentRunTimeout,
  WORKSPACE_AGENT_INSTRUCTIONS,
  WORKSPACE_AGENT_MAX_MODEL_RETRIES,
  WORKSPACE_AGENT_MAX_STEPS,
} from "../../application/policy.ts";
import { createWorkspaceAgentTools } from "./tools.ts";
import {
  type WorkspaceAgentRunEvent,
  type WorkspaceAgentRunRequest,
  type WorkspaceAgentRunResult,
  type WorkspaceAgentUsage,
} from "../../application/run-contracts.ts";
import { createWorkspaceAgentToolSession } from "../../application/tool-session.ts";
import type { WorkspaceAgentToolTarget } from "../../domain/contracts.ts";

export type AiSdkModelBinding = {
  model: LanguageModel;
  modelId: string;
  providerOptions?: ToolLoopAgentSettings["providerOptions"];
};

export async function runWorkspaceAgentWithAiSdkModel(
  input: WorkspaceAgentRunRequest,
  modelBinding: AiSdkModelBinding,
): Promise<WorkspaceAgentRunResult> {
  if (!input.messages.length) throw new Error("At least one Agent message is required.");
  input.signal?.throwIfAborted();
  let emit = createEventEmitter(input.onEvent);
  let session = createWorkspaceAgentToolSession(input.host, emit, input.writeControl);
  let agent = new ToolLoopAgent({
    instructions: WORKSPACE_AGENT_INSTRUCTIONS,
    maxRetries: WORKSPACE_AGENT_MAX_MODEL_RETRIES,
    model: modelBinding.model,
    providerOptions: modelBinding.providerOptions,
    stopWhen: isStepCount(WORKSPACE_AGENT_MAX_STEPS),
    telemetry: { isEnabled: false },
    tools: createWorkspaceAgentTools(session),
  });

  emit({ model: modelBinding.modelId, type: "run-start" });
  let result = await agent.stream({
    abortSignal: input.signal,
    messages: modelMessages(input.messages),
    onEnd: (event) => {
      emit({
        finishReason: event.finishReason,
        type: "run-finish",
        usage: agentUsage(event.usage),
      });
    },
    onStepEnd: (event) => {
      emit({
        finishReason: event.finishReason,
        stepNumber: event.stepNumber,
        toolCalls: event.toolCalls.length,
        type: "step-finish",
      });
    },
    onStepStart: (event) => {
      emit({ stepNumber: event.stepNumber, type: "step-start" });
    },
    onToolExecutionEnd: (event) => {
      emit({
        durationMs: event.toolExecutionMs,
        outcome: event.toolOutput.type == "tool-error" ? "error" : "success",
        result:
          event.toolOutput.type == "tool-result"
            ? workspaceAgentToolResultStatus(event.toolOutput.output)
            : undefined,
        toolCallId: event.toolCall.toolCallId,
        toolName: event.toolCall.toolName,
        type: "tool-finish",
      });
    },
    onToolExecutionStart: (event) => {
      emit({
        target: workspaceAgentToolTarget(event.toolCall.input),
        toolCallId: event.toolCall.toolCallId,
        toolName: event.toolCall.toolName,
        type: "tool-start",
      });
    },
    timeout: resolveWorkspaceAgentRunTimeout(input.timeoutMs),
  });

  let content = "";
  for await (let delta of result.textStream) {
    input.signal?.throwIfAborted();
    content += delta;
    emit({ delta, type: "text-delta" });
  }
  let [finishReason, usage] = await Promise.all([result.finishReason, result.usage]);
  return {
    finishReason,
    message: { content, role: "assistant" },
    usage: agentUsage(usage),
  };
}

function createEventEmitter(onEvent: WorkspaceAgentRunRequest["onEvent"]) {
  return (event: WorkspaceAgentRunEvent) => {
    try {
      onEvent?.(event);
    } catch {
      // UI observers must not interrupt a model run or a document transaction.
    }
  };
}

const toolTargetMaxCharacters = 512;

/** Extracts only the display-safe target fields (path, directory, query). */
export function workspaceAgentToolTarget(input: unknown): WorkspaceAgentToolTarget | undefined {
  if (!input || typeof input != "object") return undefined;
  let record = input as Record<string, unknown>;
  let target: WorkspaceAgentToolTarget = {};
  for (let key of ["path", "directory", "query"] as const) {
    let value = record[key];
    if (typeof value == "string") target[key] = value.slice(0, toolTargetMaxCharacters);
  }
  return Object.keys(target).length ? target : undefined;
}

/** Extracts only the status and failure reason of a tool result. */
export function workspaceAgentToolResultStatus(output: unknown) {
  if (!output || typeof output != "object") return undefined;
  let record = output as Record<string, unknown>;
  let status = typeof record.status == "string" ? record.status : undefined;
  let reason = typeof record.reason == "string" ? record.reason : undefined;
  return status || reason ? { reason, status } : undefined;
}

function modelMessages(messages: WorkspaceAgentRunRequest["messages"]): ModelMessage[] {
  return messages.map((message) => ({ content: message.content, role: message.role }));
}

function agentUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}): WorkspaceAgentUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}
