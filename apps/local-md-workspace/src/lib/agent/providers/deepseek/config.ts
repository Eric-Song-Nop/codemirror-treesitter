import type { WorkspaceAgentRunRequest } from "../../application/run-contracts.ts";

export const WORKSPACE_AGENT_MODEL_OPTIONS = [
  { label: "DeepSeek V4 Flash", value: "deepseek-v4-flash" },
  { label: "DeepSeek V4 Pro", value: "deepseek-v4-pro" },
] as const;

export type WorkspaceAgentModel = (typeof WORKSPACE_AGENT_MODEL_OPTIONS)[number]["value"];

export const DEFAULT_WORKSPACE_AGENT_MODEL: WorkspaceAgentModel = "deepseek-v4-flash";

export type DeepSeekWorkspaceAgentRunInput = WorkspaceAgentRunRequest & {
  apiKey: string;
  model?: WorkspaceAgentModel;
};

export function resolveWorkspaceAgentModel(model: string | undefined): WorkspaceAgentModel {
  let normalized = model?.trim() || DEFAULT_WORKSPACE_AGENT_MODEL;
  if (WORKSPACE_AGENT_MODEL_OPTIONS.some((option) => option.value == normalized)) {
    return normalized as WorkspaceAgentModel;
  }
  throw new RangeError(`Unsupported DeepSeek model: ${normalized}`);
}
