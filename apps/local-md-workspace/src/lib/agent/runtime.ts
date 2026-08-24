import type { WorkspaceAgentRunResult } from "./application/run-contracts.ts";
import type { OpenAIWorkspaceAgentRunInput } from "./providers/openai/config.ts";

export type WorkspaceAgentRunInput = OpenAIWorkspaceAgentRunInput;

export async function runWorkspaceAgent(
  input: WorkspaceAgentRunInput,
): Promise<WorkspaceAgentRunResult> {
  if (!input.apiKey.trim()) throw new Error("An OpenAI API key is required.");
  let runtime = await import("./ai-sdk-runtime.ts");
  return runtime.runWorkspaceAgentWithAiSdk(input);
}
