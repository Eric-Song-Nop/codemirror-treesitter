import { createDeepSeek, type DeepSeekLanguageModelChatOptions } from "@ai-sdk/deepseek";
import type { AiSdkModelBinding } from "../../adapters/ai-sdk/runner.ts";
import { resolveWorkspaceAgentModel } from "./config.ts";

const DEEPSEEK_WORKSPACE_AGENT_API_BASE_URL = "https://api.deepseek.com";

export function createDeepSeekWorkspaceAgentModel(
  apiKey: string,
  requestedModel: string | undefined,
): AiSdkModelBinding {
  let modelId = resolveWorkspaceAgentModel(requestedModel);
  let deepseek = createDeepSeek({
    apiKey,
    baseURL: DEEPSEEK_WORKSPACE_AGENT_API_BASE_URL,
  });
  return {
    model: deepseek(modelId),
    modelId,
    providerOptions: {
      deepseek: {
        thinking: { type: "enabled" },
      } satisfies DeepSeekLanguageModelChatOptions,
    },
  };
}
