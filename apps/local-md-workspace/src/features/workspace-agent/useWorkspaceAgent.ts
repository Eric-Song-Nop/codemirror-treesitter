import { useChat } from "@ai-sdk/react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { WorkspaceAgentHost } from "@/lib/agent/application/host-port";
import { runWorkspaceAgent } from "@/lib/agent/runtime";
import { WorkspaceAgentSessionManager } from "./workspace-agent-session-manager";

export type {
  WorkspaceAgentErrorCode,
  WorkspaceAgentRunner,
  WorkspaceAgentRunStatus,
  WorkspaceAgentSessionSummary,
} from "./workspace-agent-session-manager";

export type UseWorkspaceAgentOptions = {
  getApiKey: () => string | null;
  runner?: typeof runWorkspaceAgent;
  scopeKey: string;
  subscribeToCredentials: (listener: () => void) => () => void;
  throttleMs?: number;
  workspaceKey: string;
};

export function useWorkspaceAgent({
  getApiKey,
  runner = runWorkspaceAgent,
  scopeKey,
  subscribeToCredentials,
  throttleMs = 16,
  workspaceKey,
}: UseWorkspaceAgentOptions) {
  let [manager] = useState(() => createWorkspaceAgentSessionAccess(runner));

  let { activeSessionId, hasApiKey, model, sessions } = useStore(manager.store);
  let activeChat = manager.chat();
  let { messages } = useChat({ chat: activeChat, throttle: throttleMs });
  let previousScopeKeyRef = useRef(scopeKey);
  let previousWorkspaceKeyRef = useRef(workspaceKey);
  let activeSession = sessions.find((session) => session.id == activeSessionId)!;
  let running = activeSession.status == "running";
  let error = manager.error();

  let setModel = useCallback(
    (nextModel: Parameters<typeof manager.setModel>[0]) => manager.setModel(nextModel),
    [manager],
  );
  let newChat = useCallback(() => manager.newSession(), [manager]);
  let selectSession = useCallback(
    (sessionId: string) => manager.selectSession(sessionId),
    [manager],
  );
  let stop = useCallback(() => manager.stop(), [manager]);
  let stopAll = useCallback(() => manager.stopAll(), [manager]);
  let send = useCallback(
    (prompt: string, createHost: () => WorkspaceAgentHost | null) =>
      manager.send(prompt, createHost),
    [manager],
  );

  useLayoutEffect(() => {
    manager.activate();
    return () => manager.deactivate();
  }, [manager]);

  useLayoutEffect(() => {
    manager.setRunner(runner);
  }, [manager, runner]);

  useLayoutEffect(() => {
    let syncCredential = () => manager.syncApiKey(getApiKey());
    let unsubscribe = subscribeToCredentials(syncCredential);
    syncCredential();
    return unsubscribe;
  }, [getApiKey, manager, subscribeToCredentials]);

  useLayoutEffect(() => {
    let workspaceChanged = previousWorkspaceKeyRef.current != workspaceKey;
    let scopeChanged = previousScopeKeyRef.current != scopeKey;
    previousWorkspaceKeyRef.current = workspaceKey;
    previousScopeKeyRef.current = scopeKey;
    if (workspaceChanged) manager.resetSessions();
    else if (scopeChanged) manager.stopAll();
  }, [manager, scopeKey, workspaceKey]);

  return {
    activeSessionId,
    error,
    errorCode: manager.errorCode(),
    hasApiKey,
    messages,
    model,
    newChat,
    running,
    selectSession,
    send,
    setModel,
    sessions,
    status: activeSession.status,
    stop,
    stopAll,
  };
}

function createWorkspaceAgentSessionAccess(runner: typeof runWorkspaceAgent) {
  let manager = new WorkspaceAgentSessionManager(runner);
  return Object.freeze({
    activate: () => manager.activate(),
    chat: () => manager.chat(),
    error: () => manager.error(),
    errorCode: () => manager.errorCode(),
    deactivate: () => manager.deactivate(),
    newSession: () => manager.newSession(),
    resetSessions: () => manager.resetSessions(),
    selectSession: (sessionId: string) => manager.selectSession(sessionId),
    send: (prompt: string, createHost: () => WorkspaceAgentHost | null) =>
      manager.send(prompt, createHost),
    setModel: (model: Parameters<WorkspaceAgentSessionManager["setModel"]>[0]) =>
      manager.setModel(model),
    setRunner: (nextRunner: typeof runWorkspaceAgent) => manager.setRunner(nextRunner),
    stop: () => manager.stop(),
    stopAll: () => manager.stopAll(),
    store: manager.store,
    syncApiKey: (apiKey: string | null) => manager.syncApiKey(apiKey),
  });
}
