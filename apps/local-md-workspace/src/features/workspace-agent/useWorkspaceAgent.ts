import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { WorkspaceAgentHost } from "@/lib/agent/application/host-port";
import { runWorkspaceAgent } from "@/lib/agent/runtime";
import {
  WorkspaceAgentSessionManager,
  type WorkspaceAgentConfiguration,
} from "./workspace-agent-session-manager";

export type {
  WorkspaceAgentConfiguration,
  WorkspaceAgentErrorCode,
  WorkspaceAgentRunner,
  WorkspaceAgentRunStatus,
  WorkspaceAgentSessionSummary,
} from "./workspace-agent-session-manager";

export type UseWorkspaceAgentOptions = {
  runner?: typeof runWorkspaceAgent;
  scopeKey: string;
  throttleMs?: number;
  workspaceKey: string;
};

export function useWorkspaceAgent({
  runner = runWorkspaceAgent,
  scopeKey,
  throttleMs = 16,
  workspaceKey,
}: UseWorkspaceAgentOptions) {
  let [manager] = useState(() => new WorkspaceAgentSessionManager(runner));
  manager.setRunner(runner);

  let { activeSessionId, hasApiKey, model, sessions } = useStore(manager.store);
  let activeChat = manager.chat(activeSessionId);
  let { error: chatError, messages } = useChat({ chat: activeChat, throttle: throttleMs });
  let previousScopeKeyRef = useRef(scopeKey);
  let previousWorkspaceKeyRef = useRef(workspaceKey);
  let activeSession = sessions.find((session) => session.id == activeSessionId)!;
  let running = activeSession.status == "running";
  let error = manager.error(activeSessionId) ?? chatError?.message ?? null;

  let configure = useCallback(
    (configuration: WorkspaceAgentConfiguration) =>
      manager.configure(activeSessionId, configuration),
    [activeSessionId, manager],
  );
  let newChat = useCallback(() => manager.newSession(), [manager]);
  let selectSession = useCallback(
    (sessionId: string) => manager.selectSession(sessionId),
    [manager],
  );
  let stop = useCallback(() => manager.stop(activeSessionId), [activeSessionId, manager]);
  let stopAll = useCallback(() => manager.stopAll(), [manager]);
  let send = useCallback(
    (prompt: string, createHost: () => WorkspaceAgentHost | null) =>
      manager.send(activeSessionId, prompt, createHost),
    [activeSessionId, manager],
  );

  useLayoutEffect(() => {
    let workspaceChanged = previousWorkspaceKeyRef.current != workspaceKey;
    let scopeChanged = previousScopeKeyRef.current != scopeKey;
    previousWorkspaceKeyRef.current = workspaceKey;
    previousScopeKeyRef.current = scopeKey;
    if (workspaceChanged) manager.resetSessions();
    else if (scopeChanged) manager.stopAll();
  }, [manager, scopeKey, workspaceKey]);

  useEffect(() => () => manager.stopAll(), [manager]);

  return {
    activeSessionId,
    configure,
    error,
    errorCode: manager.errorCode(activeSessionId),
    hasApiKey,
    messages,
    model,
    newChat,
    running,
    selectSession,
    send,
    sessions,
    status: activeSession.status,
    stop,
    stopAll,
  };
}
