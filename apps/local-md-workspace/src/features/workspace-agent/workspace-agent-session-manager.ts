import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { WorkspaceAgentHost } from "@/lib/agent/application/host-port";
import { redactWorkspaceAgentErrorMessage } from "@/lib/agent/application/runtime-error";
import {
  DEFAULT_WORKSPACE_AGENT_MODEL,
  type WorkspaceAgentModel,
} from "@/lib/agent/providers/deepseek/config";
import type { runWorkspaceAgent } from "@/lib/agent/runtime";
import { createWorkspaceAgentChatTransport } from "./chat-transport";

export type WorkspaceAgentErrorCode = "missing-api-key" | "missing-prompt" | "missing-workspace";

export type WorkspaceAgentRunStatus = "cancelled" | "error" | "idle" | "running" | "success";

export type WorkspaceAgentConfiguration = {
  apiKey?: string;
  model?: WorkspaceAgentModel;
};

export type WorkspaceAgentRunner = typeof runWorkspaceAgent;

export type WorkspaceAgentSessionSummary = {
  id: string;
  status: WorkspaceAgentRunStatus;
  title: string | null;
};

export type WorkspaceAgentSessionsSnapshot = {
  activeSessionId: string;
  hasApiKey: boolean;
  model: WorkspaceAgentModel;
  sessions: readonly WorkspaceAgentSessionSummary[];
};

type WorkspaceAgentValidation = {
  code: WorkspaceAgentErrorCode;
  message: string;
};

type WorkspaceAgentRunConfiguration = {
  apiKey: string;
  host: WorkspaceAgentHost;
  model: WorkspaceAgentModel;
  runner: WorkspaceAgentRunner;
};

type WorkspaceAgentSessionRuntime = {
  cancelRequested: boolean;
  chat: Chat<UIMessage>;
  lastRunSucceeded: boolean;
  outcome: Exclude<WorkspaceAgentRunStatus, "error" | "running">;
  runConfiguration: WorkspaceAgentRunConfiguration | null;
  runRequested: boolean;
  runtimeError: string | null;
  title: string | null;
  validation: WorkspaceAgentValidation | null;
};

const missingApiKeyMessage = "Enter a DeepSeek API key before running the Agent.";
const missingPromptMessage = "Enter a message for the Agent.";
const missingWorkspaceMessage = "Open a workspace before running the Agent.";
const sessionTitleLimit = 48;

export class WorkspaceAgentSessionManager {
  readonly store: StoreApi<WorkspaceAgentSessionsSnapshot>;

  #active = false;
  #apiKey = "";
  private model: WorkspaceAgentModel = DEFAULT_WORKSPACE_AGENT_MODEL;
  private runner: WorkspaceAgentRunner;
  private sessions = new Map<string, WorkspaceAgentSessionRuntime>();
  private activeSessionId: string;

  constructor(runner: WorkspaceAgentRunner) {
    this.runner = runner;
    let session = this.createSessionRuntime();
    this.sessions.set(session.chat.id, session);
    this.activeSessionId = session.chat.id;
    this.store = createStore<WorkspaceAgentSessionsSnapshot>()(() => this.snapshot());
  }

  setRunner(runner: WorkspaceAgentRunner) {
    if (!this.#active) return;
    this.runner = runner;
  }

  activate() {
    this.#active = true;
  }

  chat(sessionId: string) {
    return this.requireSession(sessionId).chat;
  }

  error(sessionId: string) {
    let session = this.requireSession(sessionId);
    return (
      session.validation?.message ?? session.runtimeError ?? session.chat.error?.message ?? null
    );
  }

  errorCode(sessionId: string) {
    return this.requireSession(sessionId).validation?.code ?? null;
  }

  configure(sessionId: string, configuration: WorkspaceAgentConfiguration) {
    if (!this.#active) return;
    let session = this.requireSession(sessionId);
    if ("apiKey" in configuration) {
      this.setApiKey(configuration.apiKey ?? null, false);
    }
    if ("model" in configuration) {
      this.model = configuration.model ?? DEFAULT_WORKSPACE_AGENT_MODEL;
    }
    session.validation = null;
    session.runtimeError = null;
    session.chat.clearError();
    if (!isSessionBusy(session)) session.outcome = "idle";
    this.publish();
  }

  syncApiKey(apiKey: string | null) {
    if (!this.#active) return;
    this.setApiKey(apiKey, true);
  }

  newSession() {
    if (!this.#active) return this.activeSessionId;
    let session = this.createSessionRuntime();
    this.sessions.set(session.chat.id, session);
    this.activeSessionId = session.chat.id;
    this.publish();
    return session.chat.id;
  }

  selectSession(sessionId: string) {
    if (!this.#active) return;
    if (!this.sessions.has(sessionId) || sessionId == this.activeSessionId) return;
    this.activeSessionId = sessionId;
    this.publish();
  }

  async send(sessionId: string, prompt: string, createHost: () => WorkspaceAgentHost | null) {
    let session = this.requireSession(sessionId);
    if (!this.#active) {
      this.rejectRun(session, "missing-api-key", missingApiKeyMessage);
      return false;
    }
    if (isSessionBusy(session)) return false;

    let content = prompt.trim();
    if (!content) {
      this.rejectRun(session, "missing-prompt", missingPromptMessage);
      return false;
    }
    if (!this.#apiKey) {
      this.rejectRun(session, "missing-api-key", missingApiKeyMessage);
      return false;
    }
    let host = createHost();
    if (!host) {
      this.rejectRun(session, "missing-workspace", missingWorkspaceMessage);
      return false;
    }

    let runConfiguration: WorkspaceAgentRunConfiguration = {
      apiKey: this.#apiKey,
      host,
      model: this.model,
      runner: this.runner,
    };
    session.runConfiguration = runConfiguration;
    session.lastRunSucceeded = false;
    session.cancelRequested = false;
    session.runRequested = true;
    session.validation = null;
    session.runtimeError = null;
    session.chat.clearError();
    session.outcome = "idle";
    session.title ??= sessionTitle(content);
    this.publish();

    try {
      await session.chat.sendMessage({ text: content });
    } catch (error) {
      if (!session.cancelRequested && (!(error instanceof Error) || error.name != "AbortError")) {
        session.runtimeError = redactWorkspaceAgentErrorMessage(error, runConfiguration.apiKey);
      }
      session.lastRunSucceeded = false;
      return false;
    } finally {
      if (session.runRequested) {
        session.runRequested = false;
        session.runConfiguration = null;
        this.publish();
      }
    }
    return session.lastRunSucceeded;
  }

  stop(sessionId: string) {
    let session = this.requireSession(sessionId);
    if (!isSessionBusy(session) || session.cancelRequested) return;
    this.stopSession(session);
    this.publish();
  }

  stopAll() {
    this.stopAllSessions(true);
  }

  resetSessions() {
    if (!this.#active) return;
    this.stopAllSessions(false);
    let session = this.createSessionRuntime();
    this.sessions = new Map([[session.chat.id, session]]);
    this.activeSessionId = session.chat.id;
    this.publish();
  }

  deactivate() {
    this.#active = false;
    this.#apiKey = "";
    this.stopAllSessions(false);
    this.publish();
  }

  private stopAllSessions(publish: boolean) {
    let changed = false;
    for (let session of this.sessions.values()) {
      if (!isSessionBusy(session) || session.cancelRequested) continue;
      this.stopSession(session);
      changed = true;
    }
    if (changed && publish) this.publish();
  }

  private setApiKey(apiKey: string | null, publish: boolean) {
    let normalized = apiKey?.trim() ?? "";
    if (normalized == this.#apiKey) return;
    let revokeRuns = !normalized && Boolean(this.#apiKey);
    this.#apiKey = normalized;
    if (revokeRuns) this.stopAllSessions(false);
    if (publish) this.publish();
  }

  private createSessionRuntime() {
    let session: WorkspaceAgentSessionRuntime | undefined;
    let chat = new Chat<UIMessage>({
      onError: () => {
        if (!session) return;
        session.lastRunSucceeded = false;
      },
      onFinish: ({ isAbort, isError }) => {
        if (!session) return;
        session.runConfiguration = null;
        session.runRequested = false;
        session.lastRunSucceeded = !isAbort && !isError;
        if (!isAbort) {
          session.cancelRequested = false;
          session.outcome = isError ? "idle" : "success";
        }
        this.publish();
      },
      transport: createWorkspaceAgentChatTransport({
        getConfiguration: () => {
          if (!session?.runConfiguration) {
            throw new Error("Workspace Agent run configuration is unavailable.");
          }
          return session.runConfiguration;
        },
      }),
    });
    session = {
      cancelRequested: false,
      chat,
      lastRunSucceeded: false,
      outcome: "idle",
      runConfiguration: null,
      runRequested: false,
      runtimeError: null,
      title: null,
      validation: null,
    };
    return session;
  }

  private rejectRun(
    session: WorkspaceAgentSessionRuntime,
    code: WorkspaceAgentErrorCode,
    message: string,
  ) {
    session.validation = { code, message };
    session.runtimeError = null;
    session.outcome = "idle";
    this.publish();
  }

  private stopSession(session: WorkspaceAgentSessionRuntime) {
    try {
      void session.chat.stop().catch(() => undefined);
    } catch {
      // The local key and run configuration are still revoked below.
    }
    session.chat.messages = session.chat.messages.filter(
      (message) => message.role != "assistant" || message.parts.length,
    );
    session.runConfiguration = null;
    session.runRequested = false;
    session.lastRunSucceeded = false;
    session.cancelRequested = true;
    session.outcome = "cancelled";
  }

  private requireSession(sessionId: string) {
    let session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Workspace Agent session: ${sessionId}`);
    return session;
  }

  private publish() {
    this.store.setState(this.snapshot());
  }

  private snapshot(): WorkspaceAgentSessionsSnapshot {
    return {
      activeSessionId: this.activeSessionId,
      hasApiKey: Boolean(this.#apiKey),
      model: this.model,
      sessions: Array.from(this.sessions, ([id, session]) => ({
        id,
        status: sessionStatus(session),
        title: session.title,
      })),
    };
  }
}

function isSessionBusy(session: WorkspaceAgentSessionRuntime) {
  return (
    session.runRequested || session.chat.status == "streaming" || session.chat.status == "submitted"
  );
}

function sessionStatus(session: WorkspaceAgentSessionRuntime): WorkspaceAgentRunStatus {
  if (isSessionBusy(session) && !session.cancelRequested) return "running";
  if (session.validation || session.runtimeError || session.chat.status == "error") return "error";
  return session.outcome;
}

function sessionTitle(prompt: string) {
  let normalized = prompt.replace(/\s+/g, " ").trim();
  let characters = Array.from(normalized);
  return characters.length <= sessionTitleLimit
    ? normalized
    : `${characters.slice(0, sessionTitleLimit - 1).join("")}…`;
}
