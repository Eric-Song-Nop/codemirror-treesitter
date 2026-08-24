import { runWorkspaceAgentWithAiSdkModel } from "./adapters/ai-sdk/runner.ts";
import { redactWorkspaceAgentError } from "./application/runtime-error.ts";
import type { WorkspaceAgentRunResult } from "./application/run-contracts.ts";
import type { DeepSeekWorkspaceAgentRunInput } from "./providers/deepseek/config.ts";
import { createDeepSeekWorkspaceAgentModel } from "./providers/deepseek/model.ts";

export async function runWorkspaceAgentWithAiSdk(
  input: DeepSeekWorkspaceAgentRunInput,
): Promise<WorkspaceAgentRunResult> {
  let apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("A DeepSeek API key is required.");

  try {
    let modelBinding = createDeepSeekWorkspaceAgentModel(apiKey, input.model);
    let { apiKey: _apiKey, model: _model, ...request } = input;
    return await runWorkspaceAgentWithAiSdkModel(request, modelBinding);
  } catch (error) {
    throw redactWorkspaceAgentError(error, apiKey);
  }
}
