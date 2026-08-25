import { getToolName, isToolUIPart, type UIMessage } from "ai";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleIcon,
  KeyRoundIcon,
  PlusIcon,
  SendIcon,
  SparklesIcon,
  SquareIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { TooltipIconButton } from "@/components/workspace/TooltipIconButton";
import {
  WORKSPACE_AGENT_MODEL_OPTIONS,
  type WorkspaceAgentModel,
} from "@/lib/agent/providers/deepseek/config";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { isMobileSidebarViewport } from "@/lib/workspace/constants";
import type { WorkspaceAgentRunStatus, WorkspaceAgentSessionSummary } from "./useWorkspaceAgent";

type WorkspaceAgentPanelProps = {
  activeSessionId?: string;
  credentialLoading?: boolean;
  credentialStored?: boolean;
  error: string | null;
  hasApiKey: boolean;
  messages: readonly UIMessage[];
  model: WorkspaceAgentModel;
  open: boolean;
  runStatus: WorkspaceAgentRunStatus;
  sessions?: readonly WorkspaceAgentSessionSummary[];
  workspaceAvailable: boolean;
  onClose: () => void;
  onConfigure: (input: { apiKey?: string; model?: WorkspaceAgentModel }) => void;
  onNewChat: () => string | void;
  onOpenSettings?: () => void;
  onSelectSession?: (sessionId: string) => void;
  onSend: (prompt: string) => Promise<boolean>;
  onStop: () => void;
};

const fallbackSessionId = "workspace-agent-current-session";

export function WorkspaceAgentPanel({
  activeSessionId,
  credentialLoading = false,
  credentialStored = false,
  error,
  hasApiKey,
  messages,
  model,
  open,
  runStatus,
  sessions,
  workspaceAvailable,
  onClose,
  onConfigure,
  onNewChat,
  onOpenSettings,
  onSelectSession,
  onSend,
  onStop,
}: WorkspaceAgentPanelProps) {
  let { t } = useI18n();
  let [mobile, setMobile] = useState(() => isMobileSidebarViewport());
  let [drafts, setDrafts] = useState<Record<string, string>>({});
  let resolvedSessions = useMemo<readonly WorkspaceAgentSessionSummary[]>(
    () =>
      sessions?.length ? sessions : [{ id: fallbackSessionId, status: runStatus, title: null }],
    [runStatus, sessions],
  );
  let resolvedActiveSessionId = resolvedSessions.some((session) => session.id == activeSessionId)
    ? activeSessionId!
    : resolvedSessions[0]!.id;
  let activeSessionIndex = resolvedSessions.findIndex(
    (session) => session.id == resolvedActiveSessionId,
  );
  let activeSession = resolvedSessions[activeSessionIndex]!;
  let activeSessionTitle =
    activeSession.title ?? t("agent.sessions.untitled", { number: activeSessionIndex + 1 });
  let prompt = drafts[resolvedActiveSessionId] ?? "";
  let followOutputRef = useRef(true);
  let focusNewSessionRef = useRef(false);
  let modelSelectRef = useRef<HTMLSelectElement | null>(null);
  let promptRef = useRef<HTMLTextAreaElement | null>(null);
  let scrollEndRef = useRef<HTMLDivElement | null>(null);
  let sessionListRef = useRef<HTMLElement | null>(null);
  let settingsButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let update = () => setMobile(isMobileSidebarViewport());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    let sessionIds = new Set(resolvedSessions.map((session) => session.id));
    setDrafts((current) => {
      let entries = Object.entries(current).filter(([sessionId]) => sessionIds.has(sessionId));
      if (entries.length == Object.keys(current).length) return current;
      return Object.fromEntries(entries);
    });
  }, [resolvedSessions]);

  useEffect(() => {
    if (!open) return;
    followOutputRef.current = true;
    let focusTarget = mobile
      ? sessionListRef.current?.querySelector<HTMLElement>("[aria-current='true']")
      : hasApiKey
        ? workspaceAvailable
          ? promptRef.current
          : modelSelectRef.current
        : settingsButtonRef.current;
    let frame = requestAnimationFrame(() => focusTarget?.focus());
    return () => cancelAnimationFrame(frame);
  }, [hasApiKey, mobile, open, workspaceAvailable]);

  useEffect(() => {
    if (!open) return;
    followOutputRef.current = true;
    let activeButton = sessionListRef.current?.querySelector<HTMLElement>("[aria-current='true']");
    activeButton?.scrollIntoView({ block: "nearest" });
    if (!focusNewSessionRef.current) return;
    focusNewSessionRef.current = false;
    let frame = requestAnimationFrame(() => promptRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, resolvedActiveSessionId]);

  useEffect(() => {
    if (!open || !followOutputRef.current || (!messages.length && !error)) return;
    scrollEndRef.current?.scrollIntoView({ block: "end" });
  }, [error, messages, open, resolvedActiveSessionId]);

  if (!open) return null;

  let running = activeSession.status == "running";
  let updatePrompt = (value: string) => {
    setDrafts((current) => ({ ...current, [resolvedActiveSessionId]: value }));
  };
  let submitPrompt = async () => {
    let value = prompt.trim();
    if (!value || running || !workspaceAvailable) return;
    updatePrompt("");
    await onSend(value);
  };
  let handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key != "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitPrompt();
  };
  let createSession = () => {
    followOutputRef.current = true;
    focusNewSessionRef.current = true;
    onNewChat();
  };
  let selectSession = (sessionId: string) => {
    if (sessionId == resolvedActiveSessionId) return;
    followOutputRef.current = true;
    onSelectSession?.(sessionId);
  };
  let handleSessionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, sessionIndex: number) => {
    let nextIndex = sessionIndex;
    if (event.key == "ArrowDown") nextIndex = (sessionIndex + 1) % resolvedSessions.length;
    else if (event.key == "ArrowUp")
      nextIndex = (sessionIndex - 1 + resolvedSessions.length) % resolvedSessions.length;
    else if (event.key == "Home") nextIndex = 0;
    else if (event.key == "End") nextIndex = resolvedSessions.length - 1;
    else return;

    event.preventDefault();
    let buttons = event.currentTarget
      .closest("nav")
      ?.querySelectorAll<HTMLButtonElement>("[data-agent-session]");
    buttons?.[nextIndex]?.focus();
    selectSession(resolvedSessions[nextIndex]!.id);
  };

  return (
    <DialogPrimitive.Root
      modal={mobile}
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      {mobile ? (
        <DialogPrimitive.Overlay
          aria-hidden
          className="fixed inset-0 z-30 bg-background/70 md:hidden"
        />
      ) : null}
      <DialogPrimitive.Content
        asChild
        onEscapeKeyDown={(event) => {
          if (event.isComposing) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (!mobile) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div
          id="workspace-agent-panel"
          className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[28rem] flex-col overscroll-contain border-l bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 md:static md:z-auto md:w-[22.5rem] md:max-w-none md:shrink-0 md:pt-0 md:pb-0 md:shadow-none"
        >
          <header className="flex min-h-12 items-center gap-2 border-b px-3">
            <div className="grid size-7 place-items-center rounded-md border bg-muted/50">
              <SparklesIcon className="size-3.5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title asChild>
                <h2 className="text-sm font-medium">{t("agent.panel.title")}</h2>
              </DialogPrimitive.Title>
              <DialogPrimitive.Description asChild>
                <p className="truncate text-[0.7rem] text-muted-foreground">
                  {running
                    ? t("agent.status.running")
                    : workspaceAvailable
                      ? t("agent.panel.subtitle")
                      : t("agent.status.openWorkspace")}
                </p>
              </DialogPrimitive.Description>
            </div>
            <TooltipIconButton
              className="size-11 touch-manipulation md:size-7"
              label={t("agent.actions.newChat")}
              size="icon-sm"
              variant="ghost"
              onClick={createSession}
            >
              <PlusIcon aria-hidden />
            </TooltipIconButton>
            <TooltipIconButton
              className="size-11 touch-manipulation md:size-7"
              label={t("agent.actions.hide")}
              size="icon-sm"
              variant="ghost"
              onClick={onClose}
            >
              <XIcon aria-hidden />
            </TooltipIconButton>
          </header>

          <section className="shrink-0 border-b bg-muted/15">
            <h3 className="px-3 pt-2 pb-1 text-[0.68rem] font-medium text-muted-foreground uppercase">
              {t("agent.sessions.title")}
            </h3>
            <nav
              ref={sessionListRef}
              aria-label={t("agent.sessions.label")}
              className="max-h-32 overflow-y-auto overscroll-contain px-2 pb-2"
            >
              <ul className="space-y-1" role="list">
                {resolvedSessions.map((session, index) => {
                  let selected = session.id == resolvedActiveSessionId;
                  let title = session.title ?? t("agent.sessions.untitled", { number: index + 1 });
                  return (
                    <li key={session.id}>
                      <button
                        type="button"
                        aria-current={selected ? "true" : undefined}
                        className={cn(
                          "relative flex min-h-11 w-full touch-manipulation items-center gap-2 overflow-hidden rounded-md py-1.5 pr-2 pl-3 text-left text-xs outline-none transition-colors before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-transparent hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none md:min-h-9",
                          selected &&
                            "bg-accent text-accent-foreground before:bg-primary hover:bg-accent",
                        )}
                        data-agent-session
                        tabIndex={selected ? 0 : -1}
                        onClick={() => selectSession(session.id)}
                        onKeyDown={(event) => handleSessionKeyDown(event, index)}
                      >
                        <span className="min-w-0 flex-1 truncate font-medium" dir="auto">
                          {title}
                        </span>
                        <WorkspaceAgentSessionStatus status={session.status} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </section>

          <ScrollArea
            className="min-h-0 flex-1"
            onScrollCapture={(event) => {
              let viewport = event.target;
              if (!(viewport instanceof HTMLElement)) return;
              followOutputRef.current =
                viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
            }}
          >
            <div
              aria-label={t("agent.sessions.transcript", { title: activeSessionTitle })}
              className="space-y-5 px-4 py-5"
              role="log"
            >
              {messages.length ? (
                <div className="space-y-4">
                  {messages.map((message, index) => (
                    <WorkspaceAgentMessage
                      key={message.id}
                      message={message}
                      status={index == messages.length - 1 ? activeSession.status : "success"}
                    />
                  ))}
                </div>
              ) : (
                <Empty className="min-h-56 border">
                  <SparklesIcon className="size-5" aria-hidden />
                  <strong className="text-sm font-medium">{t("agent.empty.title")}</strong>
                  <p className="text-sm text-muted-foreground">{t("agent.empty.description")}</p>
                </Empty>
              )}

              {error ? (
                <div
                  role="alert"
                  className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                >
                  <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="wrap-break-word min-w-0">{error}</span>
                </div>
              ) : null}
              <div ref={scrollEndRef} />
            </div>
          </ScrollArea>

          <div className="space-y-3 border-t bg-muted/15 p-3">
            <Field>
              <div className="space-y-1">
                <FieldLabel htmlFor="workspace-agent-model">{t("agent.model.label")}</FieldLabel>
                <select
                  ref={modelSelectRef}
                  id="workspace-agent-model"
                  name="workspace-agent-model"
                  className="h-11 w-full touch-manipulation rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:h-9"
                  disabled={running}
                  value={model}
                  onChange={(event) => {
                    onConfigure({ model: event.currentTarget.value as WorkspaceAgentModel });
                  }}
                >
                  {WORKSPACE_AGENT_MODEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </Field>

            {hasApiKey ? (
              <form
                className="space-y-2 rounded-lg border bg-background p-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitPrompt();
                }}
              >
                <Field>
                  <FieldLabel className="sr-only" htmlFor="workspace-agent-prompt">
                    {t("agent.prompt.label")}
                  </FieldLabel>
                  <Textarea
                    ref={promptRef}
                    id="workspace-agent-prompt"
                    name="workspace-agent-prompt"
                    autoComplete="off"
                    className="max-h-40 min-h-20 resize-y border-0 bg-transparent shadow-none focus-visible:ring-0"
                    value={prompt}
                    disabled={!workspaceAvailable || running}
                    placeholder={t("agent.prompt.placeholder")}
                    onChange={(event) => updatePrompt(event.currentTarget.value)}
                    onKeyDown={handlePromptKeyDown}
                  />
                </Field>
                <div className="flex items-center justify-between gap-2 px-1">
                  <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <KeyRoundIcon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{t("agent.status.keyReady")}</span>
                  </div>
                  <Button
                    className="size-11 touch-manipulation md:size-7"
                    type={running ? "button" : "submit"}
                    size="icon-sm"
                    variant={running ? "outline" : "default"}
                    aria-label={running ? t("agent.actions.stop") : t("agent.actions.send")}
                    disabled={!running && (!workspaceAvailable || !prompt.trim())}
                    onClick={running ? onStop : undefined}
                  >
                    {running ? <SquareIcon aria-hidden /> : <SendIcon aria-hidden />}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="space-y-3 rounded-lg border bg-background p-3">
                <div className="flex gap-2.5">
                  <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    {credentialLoading ? (
                      <Spinner aria-hidden className="size-4 motion-reduce:animate-none" />
                    ) : (
                      <KeyRoundIcon aria-hidden className="size-4" />
                    )}
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-sm font-medium">
                      {credentialLoading
                        ? t("agent.status.keyChecking")
                        : credentialStored
                          ? t("agent.status.keyLocked")
                          : t("agent.apiKey.label")}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("agent.apiKey.settingsDescription")}
                    </p>
                  </div>
                </div>
                <Button
                  ref={settingsButtonRef}
                  type="button"
                  className="min-h-11 w-full touch-manipulation md:min-h-7"
                  size="sm"
                  disabled={credentialLoading}
                  onClick={onOpenSettings}
                >
                  <KeyRoundIcon data-icon="inline-start" aria-hidden />
                  {t("agent.actions.openSettings")}
                </Button>
              </div>
            )}
          </div>

          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {resolvedSessions
              .map((session, index) => {
                if (session.status == "idle") return null;
                let title = session.title ?? t("agent.sessions.untitled", { number: index + 1 });
                let status =
                  session.status == "error" && session.id == resolvedActiveSessionId && error
                    ? error
                    : workspaceAgentSessionStatusLabel(session.status, t);
                return `${title}: ${status}`;
              })
              .filter((announcement): announcement is string => announcement != null)
              .join(". ")}
          </div>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  );
}

function WorkspaceAgentSessionStatus({ status }: { status: WorkspaceAgentRunStatus }) {
  let { t } = useI18n();
  let label = workspaceAgentSessionStatusLabel(status, t);
  let icon =
    status == "running" ? (
      <Spinner aria-hidden className="size-3 motion-reduce:animate-none" />
    ) : status == "success" ? (
      <CheckIcon aria-hidden className="size-3" />
    ) : status == "error" ? (
      <CircleAlertIcon aria-hidden className="size-3" />
    ) : status == "cancelled" ? (
      <SquareIcon aria-hidden className="size-3" />
    ) : (
      <CircleIcon aria-hidden className="size-2.5" />
    );

  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 text-[0.65rem] text-muted-foreground",
        status == "running" && "text-primary",
        status == "error" && "text-destructive",
      )}
    >
      {icon}
      <span>{label}</span>
    </span>
  );
}

function workspaceAgentSessionStatusLabel(
  status: WorkspaceAgentRunStatus,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (status == "running") return t("agent.status.running");
  if (status == "success") return t("agent.status.complete");
  if (status == "error") return t("agent.status.failed");
  if (status == "cancelled") return t("agent.status.stopped");
  return t("agent.status.ready");
}

function WorkspaceAgentMessage({
  message,
  status,
}: {
  message: UIMessage;
  status: WorkspaceAgentRunStatus;
}) {
  let { t } = useI18n();
  let text = message.parts
    .filter((part) => part.type == "text")
    .map((part) => part.text)
    .join("");
  let tools = message.parts.filter(isToolUIPart);

  return (
    <article
      className={
        message.role == "user"
          ? "ml-7 rounded-lg bg-muted/70 px-3 py-2.5 text-sm leading-6"
          : "border-l-2 border-primary/30 pl-3 text-sm leading-6"
      }
    >
      <div className="mb-1 text-[0.68rem] font-medium text-muted-foreground uppercase">
        {message.role == "user" ? t("agent.message.you") : t("agent.message.agent")}
      </div>
      <div className="space-y-2">
        {text ? <div className="wrap-break-word whitespace-pre-wrap">{text}</div> : null}
        {tools.map((part) => {
          let toolStatus = workspaceAgentToolStatus(part, status);
          return (
            <Badge
              className="flex w-full gap-2 p-2"
              key={part.toolCallId}
              variant={toolStatus == "error" ? "destructive" : "secondary"}
            >
              <WrenchIcon aria-hidden />
              <span className="min-w-0 truncate">{toolLabel(getToolName(part), t)}</span>
              <span className="ml-auto">{t(`agent.tool.${toolStatus}` as TranslationKey)}</span>
            </Badge>
          );
        })}
        {status == "running" && !text && !tools.length ? (
          <Spinner
            aria-label={t("agent.status.running")}
            className="size-3.5 motion-reduce:animate-none"
          />
        ) : null}
      </div>
    </article>
  );
}

function workspaceAgentToolStatus(
  part: Parameters<typeof getToolName>[0],
  runStatus: WorkspaceAgentRunStatus,
) {
  if (part.state == "output-error") return "error";
  if (part.state != "output-available")
    return runStatus == "running" ? "running" : runStatus == "error" ? "error" : "cancelled";
  return (part.output as { status?: unknown } | null)?.status == "deduplicated"
    ? "deduplicated"
    : "success";
}

function toolLabel(name: string, t: ReturnType<typeof useI18n>["t"]) {
  let key = `agent.toolName.${name}` as TranslationKey;
  let translated = t(key);
  return translated == key ? name.replaceAll("_", " ") : translated;
}
