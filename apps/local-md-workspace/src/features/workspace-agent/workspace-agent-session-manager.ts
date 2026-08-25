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

type WorkspaceAgentFailure = {
  code: WorkspaceAgentErrorCode | null;
  message: string;
};

type WorkspaceAgentRunConfiguration = {
  apiKey: string;
  host: WorkspaceAgentHost;
  model: WorkspaceAgentModel;
  runner: WorkspaceAgentRunner;
};

type WorkspaceAgentSessionRuntime = {
  chat: Chat<UIMessage>;
  failure: WorkspaceAgentFailure | null;
  run: { configuration: WorkspaceAgentRunConfiguration; succeeded: boolean } | null;
  status: Exclude<WorkspaceAgentRunStatus, "error" | "running">;
  title: string | null;
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

  chat() {
    return this.activeSession().chat;
  }

  error() {
    let session = this.activeSession();
    return session.failure?.message ?? session.chat.error?.message ?? null;
  }

  errorCode() {
    return this.activeSession().failure?.code ?? null;
  }

  setModel(model: WorkspaceAgentModel) {
    if (!this.#active) return;
    let session = this.activeSession();
    this.model = model;
    session.failure = null;
    session.chat.clearError();
    if (!isSessionBusy(session)) session.status = "idle";
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

  async send(prompt: string, createHost: () => WorkspaceAgentHost | null) {
    if (!this.#active) return false;
    let session = this.activeSession();
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

    let run = {
      configuration: {
        apiKey: this.#apiKey,
        host,
        model: this.model,
        runner: this.runner,
      },
      succeeded: false,
    };
    session.run = run;
    session.failure = null;
    session.chat.clearError();
    session.status = "idle";
    session.title ??= sessionTitle(content);
    this.publish();

    try {
      await session.chat.sendMessage({ text: content });
    } catch (error) {
      if (session.run == run && (!(error instanceof Error) || error.name != "AbortError")) {
        session.failure = {
          code: null,
          message: redactWorkspaceAgentErrorMessage(error, run.configuration.apiKey),
        };
      }
      return false;
    } finally {
      if (session.run == run) {
        session.run = null;
        this.publish();
      }
    }
    return run.succeeded;
  }

  stop() {
    if (!this.#active) return;
    let session = this.activeSession();
    if (!isSessionBusy(session) || session.status == "cancelled") return;
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
      if (!isSessionBusy(session) || session.status == "cancelled") continue;
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
        if (session?.run) session.run.succeeded = false;
      },
      onFinish: ({ isAbort, isError }) => {
        let run = session?.run;
        if (!session || !run) return;
        run.succeeded = !isAbort && !isError;
        session.run = null;
        session.status = isAbort ? "cancelled" : isError ? "idle" : "success";
        this.publish();
      },
      transport: createWorkspaceAgentChatTransport({
        getConfiguration: () => {
          if (!session?.run) {
            throw new Error("Workspace Agent run configuration is unavailable.");
          }
          return session.run.configuration;
        },
      }),
    });
    session = {
      chat,
      failure: null,
      run: null,
      status: "idle",
      title: null,
    };
    return session;
  }

  private rejectRun(
    session: WorkspaceAgentSessionRuntime,
    code: WorkspaceAgentErrorCode,
    message: string,
  ) {
    session.failure = { code, message };
    session.status = "idle";
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
    session.run = null;
    session.status = "cancelled";
  }

  private requireSession(sessionId: string) {
    let session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Workspace Agent session: ${sessionId}`);
    return session;
  }

  private activeSession() {
    return this.requireSession(this.activeSessionId);
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
    Boolean(session.run) || session.chat.status == "streaming" || session.chat.status == "submitted"
  );
}

function sessionStatus(session: WorkspaceAgentSessionRuntime): WorkspaceAgentRunStatus {
  if (isSessionBusy(session) && session.status != "cancelled") return "running";
  if (session.failure || session.chat.status == "error") return "error";
  return session.status;
}

function sessionTitle(prompt: string) {
  let normalized = prompt.replace(/\s+/g, " ").trim();
  let characters = Array.from(normalized);
  return characters.length <= sessionTitleLimit
    ? normalized
    : `${characters.slice(0, sessionTitleLimit - 1).join("")}…`;
}
