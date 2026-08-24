import { getToolName, isToolUIPart, type UIMessage } from "ai";
import {
  CircleAlertIcon,
  KeyRoundIcon,
  PlusIcon,
  SendIcon,
  SparklesIcon,
  SquareIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { TooltipIconButton } from "@/components/workspace/TooltipIconButton";
import {
  WORKSPACE_AGENT_MODEL_OPTIONS,
  type WorkspaceAgentModel,
} from "@/lib/agent/providers/deepseek/config";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { isMobileSidebarViewport } from "@/lib/workspace/constants";
import type { WorkspaceAgentRunStatus } from "./useWorkspaceAgent";

type WorkspaceAgentPanelProps = {
  error: string | null;
  hasApiKey: boolean;
  messages: readonly UIMessage[];
  model: WorkspaceAgentModel;
  open: boolean;
  runStatus: WorkspaceAgentRunStatus;
  workspaceAvailable: boolean;
  onClose: () => void;
  onConfigure: (input: { apiKey?: string; model?: WorkspaceAgentModel }) => void;
  onNewChat: () => void;
  onSend: (prompt: string) => Promise<boolean>;
  onStop: () => void;
};

export function WorkspaceAgentPanel({
  error,
  hasApiKey,
  messages,
  model,
  open,
  runStatus,
  workspaceAvailable,
  onClose,
  onConfigure,
  onNewChat,
  onSend,
  onStop,
}: WorkspaceAgentPanelProps) {
  let { t } = useI18n();
  let [mobile, setMobile] = useState(() => isMobileSidebarViewport());
  let [prompt, setPrompt] = useState("");
  let followOutputRef = useRef(true);
  let keyInputRef = useRef<HTMLInputElement | null>(null);
  let modelSelectRef = useRef<HTMLSelectElement | null>(null);
  let promptRef = useRef<HTMLTextAreaElement | null>(null);
  let scrollEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let update = () => setMobile(isMobileSidebarViewport());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (!open) return;
    followOutputRef.current = true;
    let focusTarget = hasApiKey
      ? workspaceAvailable
        ? promptRef.current
        : modelSelectRef.current
      : keyInputRef.current;
    let frame = requestAnimationFrame(() => focusTarget?.focus());
    return () => cancelAnimationFrame(frame);
  }, [hasApiKey, mobile, open, workspaceAvailable]);

  useEffect(() => {
    if (!open || !followOutputRef.current || (!messages.length && !error)) return;
    scrollEndRef.current?.scrollIntoView({ block: "end" });
  }, [error, messages, open]);

  if (!open) return null;

  let running = runStatus == "running";
  let submitPrompt = async () => {
    let value = prompt.trim();
    if (!value || running || !workspaceAvailable) return;
    setPrompt("");
    await onSend(value);
  };
  let handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key != "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitPrompt();
  };
  let handleKeySubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let input = keyInputRef.current;
    let apiKey = input?.value.trim() ?? "";
    if (!apiKey) return;
    onConfigure({ apiKey });
    if (input) input.value = "";
    requestAnimationFrame(() => promptRef.current?.focus());
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
          className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[28rem] flex-col border-l bg-background shadow-xl outline-none md:static md:z-auto md:w-[22.5rem] md:max-w-none md:shrink-0 md:shadow-none"
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
              label={t("agent.actions.newChat")}
              size="icon-sm"
              variant="ghost"
              onClick={() => {
                followOutputRef.current = true;
                setPrompt("");
                onNewChat();
              }}
            >
              <PlusIcon />
            </TooltipIconButton>
            <TooltipIconButton
              label={t("agent.actions.hide")}
              size="icon-sm"
              variant="ghost"
              onClick={onClose}
            >
              <XIcon />
            </TooltipIconButton>
          </header>

          <ScrollArea
            className="min-h-0 flex-1"
            onScrollCapture={(event) => {
              let viewport = event.target;
              if (!(viewport instanceof HTMLElement)) return;
              followOutputRef.current =
                viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
            }}
          >
            <div aria-label={t("agent.panel.title")} className="space-y-5 px-4 py-5" role="log">
              {messages.length ? (
                <div className="space-y-4">
                  {messages.map((message, index) => (
                    <WorkspaceAgentMessage
                      key={message.id}
                      message={message}
                      status={index == messages.length - 1 ? runStatus : "success"}
                    />
                  ))}
                </div>
              ) : (
                <Empty className="min-h-56 border">
                  <SparklesIcon className="size-5" />
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
            <Field orientation="horizontal" className="items-end">
              <div className="min-w-0 flex-1 space-y-1">
                <FieldLabel htmlFor="workspace-agent-model">{t("agent.model.label")}</FieldLabel>
                <select
                  ref={modelSelectRef}
                  id="workspace-agent-model"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
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
              {hasApiKey ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={running}
                  onClick={() => onConfigure({ apiKey: "" })}
                >
                  {t("agent.actions.forgetKey")}
                </Button>
              ) : null}
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
                    className="max-h-40 min-h-20 resize-y border-0 bg-transparent shadow-none focus-visible:ring-0"
                    value={prompt}
                    disabled={!workspaceAvailable || running}
                    placeholder={t("agent.prompt.placeholder")}
                    onChange={(event) => setPrompt(event.currentTarget.value)}
                    onKeyDown={handlePromptKeyDown}
                  />
                </Field>
                <div className="flex items-center justify-between gap-2 px-1">
                  <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <KeyRoundIcon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{t("agent.status.keyReady")}</span>
                  </div>
                  <Button
                    type={running ? "button" : "submit"}
                    size="icon-sm"
                    variant={running ? "outline" : "default"}
                    aria-label={running ? t("agent.actions.stop") : t("agent.actions.send")}
                    disabled={!running && (!workspaceAvailable || !prompt.trim())}
                    onClick={running ? onStop : undefined}
                  >
                    {running ? <SquareIcon /> : <SendIcon />}
                  </Button>
                </div>
              </form>
            ) : (
              <form
                className="space-y-3 rounded-lg border bg-background p-3"
                onSubmit={handleKeySubmit}
              >
                <Field>
                  <FieldLabel htmlFor="workspace-agent-api-key">
                    {t("agent.apiKey.label")}
                  </FieldLabel>
                  <Input
                    ref={keyInputRef}
                    id="workspace-agent-api-key"
                    type="password"
                    aria-describedby="workspace-agent-api-key-description"
                    autoComplete="off"
                    placeholder={t("agent.apiKey.placeholder")}
                    required
                    spellCheck={false}
                  />
                  <FieldDescription id="workspace-agent-api-key-description" className="text-xs">
                    {t("agent.apiKey.description")}
                  </FieldDescription>
                </Field>
                <Button type="submit" className="w-full" size="sm">
                  <KeyRoundIcon data-icon="inline-start" />
                  {t("agent.actions.configureKey")}
                </Button>
              </form>
            )}
          </div>

          <div className="sr-only" role="status" aria-live="polite">
            {runStatus == "running"
              ? t("agent.status.running")
              : runStatus == "success"
                ? t("agent.status.complete")
                : runStatus == "cancelled"
                  ? t("agent.status.stopped")
                  : runStatus == "error"
                    ? error
                    : null}
          </div>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  );
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
          <Spinner aria-label={t("agent.status.running")} className="size-3.5" />
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
