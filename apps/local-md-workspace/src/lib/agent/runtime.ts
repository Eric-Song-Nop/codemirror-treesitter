import type { WorkspaceAgentRunInput, WorkspaceAgentRunResult } from "./runtime-contracts.ts";

export async function runWorkspaceAgent(
  input: WorkspaceAgentRunInput,
): Promise<WorkspaceAgentRunResult> {
  if (!input.apiKey.trim()) throw new Error("An OpenAI API key is required.");
  let runtime = await import("./ai-sdk-runtime.ts");
  return runtime.runWorkspaceAgentWithAiSdk(input);
}
