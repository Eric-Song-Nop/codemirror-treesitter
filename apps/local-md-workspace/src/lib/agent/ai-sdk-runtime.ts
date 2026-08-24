import { runWorkspaceAgentWithAiSdkModel } from "./adapters/ai-sdk/runner.ts";
import { redactWorkspaceAgentError } from "./application/runtime-error.ts";
import type { WorkspaceAgentRunResult } from "./application/run-contracts.ts";
import type { OpenAIWorkspaceAgentRunInput } from "./providers/openai/config.ts";
import { createOpenAIWorkspaceAgentModel } from "./providers/openai/model.ts";

export async function runWorkspaceAgentWithAiSdk(
  input: OpenAIWorkspaceAgentRunInput,
): Promise<WorkspaceAgentRunResult> {
  let apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("An OpenAI API key is required.");

  try {
    let modelBinding = createOpenAIWorkspaceAgentModel(apiKey, input.model);
    let { apiKey: _apiKey, model: _model, ...request } = input;
    return await runWorkspaceAgentWithAiSdkModel(request, modelBinding);
  } catch (error) {
    throw redactWorkspaceAgentError(error, apiKey);
  }
}
