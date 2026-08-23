import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_WORKSPACE_AGENT_MODEL,
  type WorkspaceAgentMessage,
  type WorkspaceAgentRunEvent,
  type WorkspaceAgentRunInput,
  type WorkspaceAgentRunResult,
} from "@/lib/agent/runtime-contracts";
import { runWorkspaceAgent } from "@/lib/agent/runtime";
import type { WorkspaceAgentHost } from "@/lib/agent/workspace-agent-host";

export type WorkspaceAgentControllerMessage = WorkspaceAgentMessage & {
  id: number;
};

export type WorkspaceAgentToolStatus =
  | "cancelled"
  | "deduplicated"
  | "error"
  | "running"
  | "success";

export type WorkspaceAgentToolActivity = {
  name: string;
  status: WorkspaceAgentToolStatus;
};

export type WorkspaceAgentErrorCode = "missing-api-key" | "missing-prompt" | "missing-workspace";

export type WorkspaceAgentRunStatus = "cancelled" | "error" | "idle" | "running" | "success";

export type WorkspaceAgentRunner = (
  input: WorkspaceAgentRunInput,
) => Promise<WorkspaceAgentRunResult>;

export type UseWorkspaceAgentOptions = {
  runner?: WorkspaceAgentRunner;
  scopeKey: string;
  workspaceKey: string;
};

export type WorkspaceAgentConfiguration = {
  apiKey?: string;
  model?: string;
};

type FrameHandle =
  | { kind: "animation-frame"; value: number }
  | { kind: "timeout"; value: ReturnType<typeof setTimeout> };

type ActiveRun = {
  abortController: AbortController;
  assistantMessageId: number;
  frameHandle: FrameHandle | null;
  id: number;
  streamedContent: string;
};

const missingApiKeyMessage = "Enter an OpenAI API key before running the agent.";
const missingPromptMessage = "Enter a message for the agent.";
const missingWorkspaceMessage = "Open a workspace before running the agent.";
const unknownRunErrorMessage = "The agent run failed.";

export function useWorkspaceAgent({
  runner = runWorkspaceAgent,
  scopeKey,
  workspaceKey,
}: UseWorkspaceAgentOptions) {
  let [model, setModel] = useState(DEFAULT_WORKSPACE_AGENT_MODEL);
  let [hasApiKey, setHasApiKey] = useState(false);
  let [messages, setMessages] = useState<readonly WorkspaceAgentControllerMessage[]>([]);
  let [toolActivity, setToolActivity] = useState<readonly WorkspaceAgentToolActivity[]>([]);
  let [error, setError] = useState<string | null>(null);
  let [errorCode, setErrorCode] = useState<WorkspaceAgentErrorCode | null>(null);
  let [running, setRunning] = useState(false);
  let [status, setStatus] = useState<WorkspaceAgentRunStatus>("idle");

  let apiKeyRef = useRef("");
  let modelRef = useRef(model);
  let messagesRef = useRef(messages);
  let runnerRef = useRef(runner);
  let activeRunRef = useRef<ActiveRun | null>(null);
  let nextRunIdRef = useRef(0);
  let nextMessageIdRef = useRef(0);
  let previousScopeKeyRef = useRef(scopeKey);
  let previousWorkspaceKeyRef = useRef(workspaceKey);
  runnerRef.current = runner;

  let replaceMessages = useCallback((next: readonly WorkspaceAgentControllerMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  let updateAssistantMessage = useCallback(
    (messageId: number, content: string) => {
      replaceMessages(
        messagesRef.current.map((message) =>
          message.id == messageId ? { ...message, content } : message,
        ),
      );
    },
    [replaceMessages],
  );

  let removeEmptyAssistantMessage = useCallback(
    (run: ActiveRun) => {
      if (run.streamedContent) {
        updateAssistantMessage(run.assistantMessageId, run.streamedContent);
        return;
      }
      replaceMessages(
        messagesRef.current.filter((message) => message.id != run.assistantMessageId),
      );
    },
    [replaceMessages, updateAssistantMessage],
  );

  let cancelActiveRun = useCallback(() => {
    let run = activeRunRef.current;
    if (!run) return;
    activeRunRef.current = null;
    run.abortController.abort();
    cancelAgentFrame(run.frameHandle);
    removeEmptyAssistantMessage(run);
    setToolActivity((current) =>
      current.map((activity) =>
        activity.status == "running" ? { ...activity, status: "cancelled" } : activity,
      ),
    );
    setRunning(false);
    setStatus("cancelled");
  }, [removeEmptyAssistantMessage]);

  let configure = useCallback((configuration: WorkspaceAgentConfiguration) => {
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
    setError(null);
    setErrorCode(null);
    setStatus("idle");
  }, []);

  let stop = useCallback(() => cancelActiveRun(), [cancelActiveRun]);

  let newChat = useCallback(() => {
    cancelActiveRun();
    replaceMessages([]);
    setToolActivity([]);
    setError(null);
    setErrorCode(null);
    setStatus("idle");
  }, [cancelActiveRun, replaceMessages]);

  let send = useCallback(
    async (prompt: string, createHost: () => WorkspaceAgentHost | null) => {
      let content = prompt.trim();
      if (!content) {
        setError(missingPromptMessage);
        setErrorCode("missing-prompt");
        setStatus("error");
        return false;
      }
      let apiKey = apiKeyRef.current;
      if (!apiKey) {
        setError(missingApiKeyMessage);
        setErrorCode("missing-api-key");
        setStatus("error");
        return false;
      }
      if (activeRunRef.current) return false;

      let host = createHost();
      if (!host) {
        setError(missingWorkspaceMessage);
        setErrorCode("missing-workspace");
        setStatus("error");
        return false;
      }

      let userMessage: WorkspaceAgentControllerMessage = {
        content,
        id: ++nextMessageIdRef.current,
        role: "user",
      };
      let assistantMessage: WorkspaceAgentControllerMessage = {
        content: "",
        id: ++nextMessageIdRef.current,
        role: "assistant",
      };
      let inputMessages = [...messagesRef.current, userMessage].map(({ content, role }) => ({
        content,
        role,
      }));
      replaceMessages([...messagesRef.current, userMessage, assistantMessage]);
      setToolActivity([]);
      setError(null);
      setErrorCode(null);
      setRunning(true);
      setStatus("running");

      let run: ActiveRun = {
        abortController: new AbortController(),
        assistantMessageId: assistantMessage.id,
        frameHandle: null,
        id: ++nextRunIdRef.current,
        streamedContent: "",
      };
      activeRunRef.current = run;

      let onEvent = (event: WorkspaceAgentRunEvent) => {
        if (activeRunRef.current?.id != run.id) return;
        handleRunEvent(event, run, {
          scheduleTextCommit: () => {
            if (run.frameHandle) return;
            run.frameHandle = scheduleAgentFrame(() => {
              run.frameHandle = null;
              if (activeRunRef.current?.id != run.id) return;
              updateAssistantMessage(run.assistantMessageId, run.streamedContent);
            });
          },
          setToolActivity,
        });
      };

      try {
        let result = await runnerRef.current({
          apiKey,
          host,
          messages: inputMessages,
          model: modelRef.current,
          onEvent,
          signal: run.abortController.signal,
        });
        if (activeRunRef.current?.id != run.id) return false;
        activeRunRef.current = null;
        cancelAgentFrame(run.frameHandle);
        updateAssistantMessage(run.assistantMessageId, result.message.content);
        setRunning(false);
        setStatus("success");
        return true;
      } catch (runError) {
        if (activeRunRef.current?.id != run.id) return false;
        activeRunRef.current = null;
        cancelAgentFrame(run.frameHandle);
        removeEmptyAssistantMessage(run);
        setToolActivity((current) =>
          current.map((activity) =>
            activity.status == "running"
              ? { ...activity, status: run.abortController.signal.aborted ? "cancelled" : "error" }
              : activity,
          ),
        );
        setRunning(false);
        if (!run.abortController.signal.aborted) {
          setError(safeErrorMessage(runError, apiKey));
          setErrorCode(null);
          setStatus("error");
        }
        return false;
      }
    },
    [removeEmptyAssistantMessage, replaceMessages, updateAssistantMessage],
  );

  useEffect(() => {
    let workspaceChanged = previousWorkspaceKeyRef.current != workspaceKey;
    let scopeChanged = previousScopeKeyRef.current != scopeKey;
    previousWorkspaceKeyRef.current = workspaceKey;
    previousScopeKeyRef.current = scopeKey;
    if (workspaceChanged || scopeChanged) cancelActiveRun();
    if (workspaceChanged) {
      replaceMessages([]);
      setToolActivity([]);
      setError(null);
      setErrorCode(null);
      setStatus("idle");
    }
  }, [cancelActiveRun, replaceMessages, scopeKey, workspaceKey]);

  useEffect(
    () => () => {
      let run = activeRunRef.current;
      activeRunRef.current = null;
      if (!run) return;
      run.abortController.abort();
      cancelAgentFrame(run.frameHandle);
    },
    [],
  );

  return {
    configure,
    error,
    errorCode,
    hasApiKey,
    messages,
    model,
    newChat,
    running,
    send,
    stop,
    status,
    toolActivity,
  };
}

function handleRunEvent(
  event: WorkspaceAgentRunEvent,
  run: ActiveRun,
  callbacks: {
    scheduleTextCommit: () => void;
    setToolActivity: React.Dispatch<React.SetStateAction<readonly WorkspaceAgentToolActivity[]>>;
  },
) {
  if (event.type == "text-delta") {
    run.streamedContent += event.delta;
    callbacks.scheduleTextCommit();
    return;
  }
  if (event.type == "tool-start") {
    callbacks.setToolActivity((current) => [
      ...current,
      { name: event.toolName, status: "running" },
    ]);
    return;
  }
  if (event.type == "tool-finish") {
    callbacks.setToolActivity((current) =>
      updateMostRecentRunningTool(current, event.toolName, event.outcome),
    );
    return;
  }
  if (event.type == "tool-deduplicated") {
    callbacks.setToolActivity((current) => [
      ...current,
      { name: event.toolName, status: "deduplicated" },
    ]);
  }
}

function updateMostRecentRunningTool(
  current: readonly WorkspaceAgentToolActivity[],
  name: string,
  status: "error" | "success",
) {
  let index = current.findLastIndex(
    (activity) => activity.name == name && activity.status == "running",
  );
  if (index < 0) return [...current, { name, status }];
  return current.map((activity, activityIndex) =>
    activityIndex == index ? { ...activity, status } : activity,
  );
}

function scheduleAgentFrame(callback: () => void): FrameHandle {
  if (typeof requestAnimationFrame == "function") {
    return { kind: "animation-frame", value: requestAnimationFrame(callback) };
  }
  return { kind: "timeout", value: setTimeout(callback, 16) };
}

function cancelAgentFrame(handle: FrameHandle | null) {
  if (!handle) return;
  if (handle.kind == "animation-frame") cancelAnimationFrame(handle.value);
  else clearTimeout(handle.value);
}

function safeErrorMessage(error: unknown, apiKey: string) {
  let message = error instanceof Error ? error.message : unknownRunErrorMessage;
  let redacted = apiKey ? message.split(apiKey).join("[REDACTED]") : message;
  return redacted.trim() || unknownRunErrorMessage;
}
