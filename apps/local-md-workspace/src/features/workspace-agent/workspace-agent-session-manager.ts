import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { Effect, Fiber } from "effect";
import { runStandaloneEffect } from "@/app/effect-bridge";
import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  WorkspaceAgentHost,
  WorkspaceAgentRevertResult,
  WorkspaceAgentWriteControl,
} from "@/lib/agent/application/host-port";
import type { WorkspaceAgentChangeSummary } from "@/lib/agent/domain/contracts";
import { redactWorkspaceAgentErrorMessage } from "@/lib/agent/application/runtime-error";
import {
  DEFAULT_WORKSPACE_AGENT_MODEL,
  type WorkspaceAgentModel,
} from "@/lib/agent/providers/deepseek/config";
import type { WorkspaceAgentRunResult } from "@/lib/agent/application/run-contracts";
import type { runWorkspaceAgent } from "@/lib/agent/runtime";
import { createWorkspaceAgentChatTransport } from "./chat-transport";

export type WorkspaceAgentErrorCode = "missing-api-key" | "missing-prompt" | "missing-workspace";

export type WorkspaceAgentRunStatus = "cancelled" | "error" | "idle" | "running" | "success";

export type WorkspaceAgentRunner = typeof runWorkspaceAgent;

export type WorkspaceAgentWriteDecision = "allow-once" | "allow-session" | "deny";

/** A write to a non-open file that is blocked until the user decides. */
export type WorkspaceAgentPendingApproval = {
  change: WorkspaceAgentChangeSummary;
  id: string;
  path: string;
};

export type WorkspaceAgentEditStatus = "applied" | "revert-failed" | "reverted" | "reverting";

export type WorkspaceAgentEditRecord = {
  change: WorkspaceAgentChangeSummary;
  error?: string;
  id: string;
  path: string;
  status: WorkspaceAgentEditStatus;
};

export type WorkspaceAgentSessionSummary = {
  approvals: readonly WorkspaceAgentPendingApproval[];
  edits: readonly WorkspaceAgentEditRecord[];
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
  /** Runs the model/tool loop as this run's fiber (see `startRunFiber`). */
  execute: WorkspaceAgentRunExecutor;
  host: WorkspaceAgentHost;
  model: WorkspaceAgentModel;
  runner: WorkspaceAgentRunner;
  writeControl: WorkspaceAgentWriteControl;
};

export type WorkspaceAgentRunExecutor = (
  start: (signal: AbortSignal) => Promise<WorkspaceAgentRunResult>,
  chatSignal: AbortSignal | undefined,
) => Promise<WorkspaceAgentRunResult>;

type WorkspaceAgentRun = {
  configuration: WorkspaceAgentRunConfiguration;
  fiber: Fiber.Fiber<WorkspaceAgentRunResult, unknown> | null;
  succeeded: boolean;
};

type PendingApprovalRuntime = {
  resolve: (approved: boolean) => void;
  view: WorkspaceAgentPendingApproval;
};

type EditRecordRuntime = {
  record: WorkspaceAgentEditRecord;
  revert: () => Promise<WorkspaceAgentRevertResult>;
};

type WorkspaceAgentSessionRuntime = {
  /** Paths the user allowed for the rest of this session. */
  allowedPaths: Set<string>;
  approvals: Map<string, PendingApprovalRuntime>;
  chat: Chat<UIMessage>;
  edits: EditRecordRuntime[];
  failure: WorkspaceAgentFailure | null;
  run: WorkspaceAgentRun | null;
  status: Exclude<WorkspaceAgentRunStatus, "error" | "running">;
  title: string | null;
};

const missingApiKeyMessage = "Enter a DeepSeek API key before running the Agent.";
const missingPromptMessage = "Enter a message for the Agent.";
const missingWorkspaceMessage = "Open a workspace before running the Agent.";
const sessionTitleLimit = 48;
const maxEditRecordsPerSession = 100;

export class WorkspaceAgentSessionManager {
  readonly store: StoreApi<WorkspaceAgentSessionsSnapshot>;

  #active = false;
  #apiKey = "";
  private model: WorkspaceAgentModel = DEFAULT_WORKSPACE_AGENT_MODEL;
  private runner: WorkspaceAgentRunner;
  private sessions = new Map<string, WorkspaceAgentSessionRuntime>();
  private activeSessionId: string;
  private nextRecordId = 0;
  private openDocumentPath: () => string | null = () => null;

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

  /**
   * Resolves the workspace path of the document open in the editor. Writes to
   * that path are auto-approved; every other write needs explicit approval.
   */
  setOpenDocumentResolver(resolver: () => string | null) {
    this.openDocumentPath = resolver;
  }

  resolveApproval(sessionId: string, approvalId: string, decision: WorkspaceAgentWriteDecision) {
    let session = this.sessions.get(sessionId);
    let approval = session?.approvals.get(approvalId);
    if (!session || !approval) return;
    session.approvals.delete(approvalId);
    if (decision == "allow-session") session.allowedPaths.add(approval.view.path);
    approval.resolve(decision != "deny");
    this.publish();
  }

  async revertEdit(sessionId: string, editId: string) {
    let session = this.sessions.get(sessionId);
    let edit = session?.edits.find((entry) => entry.record.id == editId);
    if (
      !session ||
      !edit ||
      (edit.record.status != "applied" && edit.record.status != "revert-failed")
    ) {
      return false;
    }
    edit.record = { ...edit.record, error: undefined, status: "reverting" };
    this.publish();
    let result: WorkspaceAgentRevertResult;
    try {
      result = await edit.revert();
    } catch (error) {
      result = {
        message: error instanceof Error ? error.message : "The edit could not be reverted.",
        status: "failed",
      };
    }
    edit.record =
      result.status == "reverted"
        ? { ...edit.record, status: "reverted" }
        : { ...edit.record, error: result.message, status: "revert-failed" };
    if (this.sessions.get(sessionId) === session) this.publish();
    return result.status == "reverted";
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

    let run: WorkspaceAgentRun = {
      configuration: {
        apiKey: this.#apiKey,
        execute: (start, chatSignal) => startRunFiber(run, start, chatSignal),
        host,
        model: this.model,
        runner: this.runner,
        writeControl: {},
      },
      fiber: null,
      succeeded: false,
    };
    run.configuration.writeControl = this.createWriteControl(session, run);
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

  private createWriteControl(
    session: WorkspaceAgentSessionRuntime,
    run: WorkspaceAgentRun,
  ): WorkspaceAgentWriteControl {
    return {
      approve: (request) => {
        if (session.run !== run || request.signal?.aborted) return Promise.resolve(false);
        let openPath = this.currentOpenDocumentPath();
        if (openPath != null && openPath == request.path) return Promise.resolve(true);
        if (session.allowedPaths.has(request.path)) return Promise.resolve(true);

        let id = `approval-${++this.nextRecordId}`;
        // The gate waits for the user's decision. Interrupting it (the run's
        // signal aborted by Stop, lock, or delete) withdraws the request and
        // denies the write.
        let gate = Effect.callback<boolean>((resume) => {
          let settle = (approved: boolean) => {
            if (session.approvals.get(id)?.resolve === settle) session.approvals.delete(id);
            resume(Effect.succeed(approved));
          };
          session.approvals.set(id, {
            resolve: settle,
            view: { change: request.change, id, path: request.path },
          });
          this.publish();
          return Effect.sync(() => {
            if (session.approvals.get(id)?.resolve === settle) session.approvals.delete(id);
          });
        });
        return runStandaloneEffect(gate, { signal: request.signal }).catch(() => false);
      },
      onApplied: (edit) => {
        if (!this.sessions.has(session.chat.id)) return;
        session.edits.push({
          record: {
            change: edit.change,
            id: `edit-${++this.nextRecordId}`,
            path: edit.path,
            status: "applied",
          },
          revert: () => edit.revert(),
        });
        if (session.edits.length > maxEditRecordsPerSession) session.edits.shift();
        this.publish();
      },
    };
  }

  private currentOpenDocumentPath() {
    try {
      return this.openDocumentPath();
    } catch {
      return null;
    }
  }

  private denyPendingApprovals(session: WorkspaceAgentSessionRuntime) {
    let approvals = [...session.approvals.values()];
    session.approvals.clear();
    for (let approval of approvals) approval.resolve(false);
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
      allowedPaths: new Set(),
      approvals: new Map(),
      chat,
      edits: [],
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
    // Interrupting the run fiber aborts the model request and tool loop now,
    // before the chat finishes stopping asynchronously.
    session.run?.fiber?.interruptUnsafe();
    this.denyPendingApprovals(session);
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
        approvals: Array.from(session.approvals.values(), (approval) => approval.view),
        edits: session.edits.map((edit) => edit.record),
        id,
        status: sessionStatus(session),
        title: session.title,
      })),
    };
  }
}

/**
 * Runs one Agent turn as a fiber. Its interruption aborts the signal handed to
 * the runner, so `stopSession` (Stop, credential lock or delete, deactivation)
 * cancels the model request and pending tool work deterministically; the
 * chat's own abort signal interrupts it too. Interruption rejects with an
 * `AbortError`, which the chat treats as a stop. The API key stays in the run
 * configuration and is never placed in fiber state, spans, or logs.
 */
function startRunFiber(
  run: WorkspaceAgentRun,
  start: (signal: AbortSignal) => Promise<WorkspaceAgentRunResult>,
  chatSignal: AbortSignal | undefined,
) {
  let fiber = Effect.runFork(
    Effect.tryPromise({ catch: (cause) => cause, try: (signal) => start(signal) }),
    { signal: chatSignal },
  );
  run.fiber = fiber;
  return runStandaloneEffect(Fiber.join(fiber)).finally(() => {
    if (run.fiber === fiber) run.fiber = null;
  });
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
