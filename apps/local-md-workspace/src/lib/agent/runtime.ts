import type { WorkspaceAgentRunResult } from "./application/run-contracts.ts";
import type { DeepSeekWorkspaceAgentRunInput } from "./providers/deepseek/config.ts";

export type WorkspaceAgentRunInput = DeepSeekWorkspaceAgentRunInput;

export async function runWorkspaceAgent(
  input: WorkspaceAgentRunInput,
): Promise<WorkspaceAgentRunResult> {
  if (!input.apiKey.trim()) throw new Error("A DeepSeek API key is required.");
  let runtime = await import("./ai-sdk-runtime.ts");
  return runtime.runWorkspaceAgentWithAiSdk(input);
}
