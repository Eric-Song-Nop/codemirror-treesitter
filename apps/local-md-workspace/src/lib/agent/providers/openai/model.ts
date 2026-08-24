import { createOpenAI } from "@ai-sdk/openai";
import type { AiSdkModelBinding } from "../../adapters/ai-sdk/runner.ts";
import { DEFAULT_WORKSPACE_AGENT_MODEL } from "./config.ts";

const OPENAI_WORKSPACE_AGENT_API_BASE_URL = "https://api.openai.com/v1";

export function createOpenAIWorkspaceAgentModel(
  apiKey: string,
  requestedModel: string | undefined,
): AiSdkModelBinding {
  let modelId = requestedModel?.trim() || DEFAULT_WORKSPACE_AGENT_MODEL;
  let openai = createOpenAI({
    apiKey,
    baseURL: OPENAI_WORKSPACE_AGENT_API_BASE_URL,
  });
  return {
    model: openai(modelId),
    modelId,
    providerOptions: {
      openai: {
        parallelToolCalls: false,
        store: false,
      },
    },
  };
}
