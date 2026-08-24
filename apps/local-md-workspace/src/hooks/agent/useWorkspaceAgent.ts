import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runWorkspaceAgent } from "@/lib/agent/runtime";
import { createWorkspaceAgentChatTransport } from "@/lib/agent/ui-transport";
import { DEFAULT_WORKSPACE_AGENT_MODEL } from "@/lib/agent/runtime-contracts";
import type { WorkspaceAgentHost } from "@/lib/agent/workspace-agent-host";

export type WorkspaceAgentErrorCode = "missing-api-key" | "missing-prompt" | "missing-workspace";

export type WorkspaceAgentRunStatus = "cancelled" | "error" | "idle" | "running" | "success";

export type UseWorkspaceAgentOptions = {
  runner?: typeof runWorkspaceAgent;
  scopeKey: string;
  throttleMs?: number;
  workspaceKey: string;
};

export type WorkspaceAgentConfiguration = {
  apiKey?: string;
  model?: string;
};

export type WorkspaceAgentRunner = typeof runWorkspaceAgent;

const missingApiKeyMessage = "Enter an OpenAI API key before running the Agent.";
const missingPromptMessage = "Enter a message for the Agent.";
const missingWorkspaceMessage = "Open a workspace before running the Agent.";

export function useWorkspaceAgent({
  runner = runWorkspaceAgent,
  scopeKey,
  throttleMs = 16,
  workspaceKey,
}: UseWorkspaceAgentOptions) {
  let [model, setModel] = useState(DEFAULT_WORKSPACE_AGENT_MODEL);
  let [hasApiKey, setHasApiKey] = useState(false);
  let [validation, setValidation] = useState<{
    code: WorkspaceAgentErrorCode;
    message: string;
  } | null>(null);
  let [cancelRequested, setCancelRequested] = useState(false);
  let [outcome, setOutcome] =
    useState<Exclude<WorkspaceAgentRunStatus, "error" | "running">>("idle");

  let apiKeyRef = useRef("");
  let modelRef = useRef(model);
  let hostRef = useRef<WorkspaceAgentHost | null>(null);
  let runnerRef = useRef(runner);
  let lastRunSucceededRef = useRef(false);
  let previousScopeKeyRef = useRef(scopeKey);
  let previousWorkspaceKeyRef = useRef(workspaceKey);
  runnerRef.current = runner;

  let transport = useMemo(
    () =>
      createWorkspaceAgentChatTransport({
        getConfiguration: () => ({
          apiKey: apiKeyRef.current,
          host: hostRef.current!,
          model: modelRef.current,
        }),
        runner: (input) => runnerRef.current(input),
      }),
    [],
  );

  let {
    clearError,
    error: chatError,
    messages,
    sendMessage,
    setMessages,
    status: sdkStatus,
    stop: stopChat,
  } = useChat({
    onError: () => {
      hostRef.current = null;
      lastRunSucceededRef.current = false;
    },
    onFinish: ({ isAbort, isError }) => {
      hostRef.current = null;
      lastRunSucceededRef.current = !isAbort && !isError;
      if (!isAbort) {
        setCancelRequested(false);
        setOutcome(isError ? "idle" : "success");
      }
    },
    throttle: throttleMs,
    transport,
  });

  let chatBusy = sdkStatus == "streaming" || sdkStatus == "submitted";
  let running = chatBusy && !cancelRequested;
  let status: WorkspaceAgentRunStatus = running
    ? "running"
    : validation || sdkStatus == "error"
      ? "error"
      : outcome;
  let error = validation?.message ?? chatError?.message ?? null;

  let configure = useCallback(
    (configuration: WorkspaceAgentConfiguration) => {
      if ("apiKey" in configuration) {
        let apiKey = configuration.apiKey?.trim() ?? "";
        apiKeyRef.current = apiKey;
        setHasApiKey(Boolean(apiKey));
      }
      if ("model" in configuration) {
        let nextModel = configuration.model?.trim() || DEFAULT_WORKSPACE_AGENT_MODEL;
        modelRef.current = nextModel;
        setModel(nextModel);
      }
      setValidation(null);
      clearError();
      if (!running) setOutcome("idle");
    },
    [clearError, running],
  );

  let stop = useCallback(() => {
    if (!chatBusy || cancelRequested) return;
    void stopChat();
    hostRef.current = null;
    lastRunSucceededRef.current = false;
    setMessages((current) =>
      current.filter((message) => message.role != "assistant" || message.parts.length),
    );
    setCancelRequested(true);
    setOutcome("cancelled");
  }, [cancelRequested, chatBusy, setMessages, stopChat]);

  let newChat = useCallback(() => {
    if (chatBusy) void stopChat();
    hostRef.current = null;
    lastRunSucceededRef.current = false;
    setMessages([]);
    setCancelRequested(chatBusy);
    setValidation(null);
    clearError();
    setOutcome("idle");
  }, [chatBusy, clearError, setMessages, stopChat]);

  let send = useCallback(
    async (prompt: string, createHost: () => WorkspaceAgentHost | null) => {
      if (chatBusy) return false;
      let content = prompt.trim();
      if (!content) {
        setValidation({ code: "missing-prompt", message: missingPromptMessage });
        setOutcome("idle");
        return false;
      }
      if (!apiKeyRef.current) {
        setValidation({ code: "missing-api-key", message: missingApiKeyMessage });
        setOutcome("idle");
        return false;
      }
      let host = createHost();
      if (!host) {
        setValidation({ code: "missing-workspace", message: missingWorkspaceMessage });
        setOutcome("idle");
        return false;
      }

      hostRef.current = host;
      lastRunSucceededRef.current = false;
      setCancelRequested(false);
      setValidation(null);
      clearError();
      setOutcome("idle");
      await sendMessage({ text: content });
      return lastRunSucceededRef.current;
    },
    [chatBusy, clearError, sendMessage],
  );

  useEffect(() => {
    let workspaceChanged = previousWorkspaceKeyRef.current != workspaceKey;
    let scopeChanged = previousScopeKeyRef.current != scopeKey;
    previousWorkspaceKeyRef.current = workspaceKey;
    previousScopeKeyRef.current = scopeKey;
    if (workspaceChanged || scopeChanged) stop();
    if (workspaceChanged) {
      setMessages([]);
      setValidation(null);
      clearError();
      setOutcome("idle");
    }
  }, [clearError, scopeKey, setMessages, stop, workspaceKey]);

  return {
    configure,
    error,
    errorCode: validation?.code ?? null,
    hasApiKey,
    messages,
    model,
    newChat,
    running,
    send,
    status,
    stop,
  };
}
