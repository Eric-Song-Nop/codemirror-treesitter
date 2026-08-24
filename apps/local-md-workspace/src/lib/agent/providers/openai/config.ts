import type { WorkspaceAgentRunRequest } from "../../application/run-contracts.ts";

export const DEFAULT_WORKSPACE_AGENT_MODEL = "gpt-5.4-mini";

export type OpenAIWorkspaceAgentRunInput = WorkspaceAgentRunRequest & {
  apiKey: string;
  model?: string;
};
