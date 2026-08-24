import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  CheckIcon,
  CircleAlertIcon,
  KeyRoundIcon,
  PlusIcon,
  SendIcon,
  SparklesIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { TooltipIconButton } from "@/components/workspace/TooltipIconButton";
import type {
  WorkspaceAgentControllerMessage,
  WorkspaceAgentRunStatus,
  WorkspaceAgentToolActivity,
  WorkspaceAgentToolStatus,
} from "@/hooks/agent/useWorkspaceAgent";
import { DEFAULT_WORKSPACE_AGENT_MODEL } from "@/lib/agent/runtime-contracts";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { isMobileSidebarViewport } from "@/lib/workspace/constants";

type WorkspaceAgentPanelProps = {
  error: string | null;
  hasApiKey: boolean;
  messages: readonly WorkspaceAgentControllerMessage[];
  model: string;
  open: boolean;
  runStatus: WorkspaceAgentRunStatus;
  toolActivity: readonly WorkspaceAgentToolActivity[];
  workspaceAvailable: boolean;
  onClose: () => void;
  onConfigure: (input: { apiKey?: string; model?: string }) => void;
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
  toolActivity,
  workspaceAvailable,
  onClose,
  onConfigure,
  onNewChat,
  onSend,
  onStop,
}: WorkspaceAgentPanelProps) {
  let { t } = useI18n();
  let [prompt, setPrompt] = useState("");
  let [mobile, setMobile] = useState(() => isMobileSidebarViewport());
  let keyInputRef = useRef<HTMLInputElement | null>(null);
  let followOutputRef = useRef(true);
  let modelInputRef = useRef<HTMLInputElement | null>(null);
  let promptRef = useRef<HTMLTextAreaElement | null>(null);
  let scrollEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let update = () => setMobile(isMobileSidebarViewport());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (!open) return;
    let focusTarget = hasApiKey
      ? workspaceAvailable
        ? promptRef.current
        : modelInputRef.current
      : keyInputRef.current;
    let frame = requestAnimationFrame(() => focusTarget?.focus());
    return () => cancelAnimationFrame(frame);
  }, [hasApiKey, mobile, open, workspaceAvailable]);

  useEffect(() => {
    if (open) followOutputRef.current = true;
  }, [open]);

  useEffect(() => {
    if (!open || !followOutputRef.current || (!messages.length && !toolActivity.length && !error))
      return;
    scrollEndRef.current?.scrollIntoView({ block: "end" });
  }, [error, messages, open, toolActivity]);

  if (!open) return null;

  let running = runStatus == "running";
  let submitPrompt = async () => {
    let value = prompt.trim();
    if (!value || running || !hasApiKey || !workspaceAvailable) return;
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
                onNewChat();
                setPrompt("");
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
            <div
              aria-label={t("agent.panel.title")}
              className="space-y-5 px-4 py-5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              role="region"
              tabIndex={0}
            >
              {messages.length ? (
                <div className="space-y-4">
                  {messages.map((message) => (
                    <article
                      key={message.id}
                      className={cn(
                        "text-sm leading-6",
                        message.role == "user"
                          ? "ml-7 rounded-lg bg-muted/70 px-3 py-2.5"
                          : "border-l-2 border-primary/30 pl-3",
                      )}
                    >
                      <div className="mb-1 text-[0.68rem] font-medium tracking-wide text-muted-foreground uppercase">
                        {message.role == "user" ? t("agent.message.you") : t("agent.message.agent")}
                      </div>
                      <div className="wrap-break-word whitespace-pre-wrap">{message.content}</div>
                      {running && message.role == "assistant" && !message.content ? (
                        <Spinner aria-hidden className="size-3.5 text-muted-foreground" />
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed px-4 py-6">
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                    <SparklesIcon className="size-4 text-muted-foreground" aria-hidden />
                    {t("agent.empty.title")}
                  </div>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {t("agent.empty.description")}
                  </p>
                </div>
              )}

              {toolActivity.length ? (
                <section aria-label={t("agent.tool.activity")} className="space-y-1.5">
                  {toolActivity.slice(-10).map((activity, index) => (
                    <div
                      key={`${activity.name}:${index}`}
                      className="grid grid-cols-[1rem_1fr_auto] items-center gap-2 border-l pl-2 text-xs"
                    >
                      <ToolStatusIcon status={activity.status} />
                      <span className="truncate font-mono text-[0.7rem]">
                        {toolLabel(activity.name, t)}
                      </span>
                      <span className="text-muted-foreground">
                        {t(`agent.tool.${activity.status}` as TranslationKey)}
                      </span>
                    </div>
                  ))}
                </section>
              ) : null}

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
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <label className="grid gap-1 text-xs font-medium" htmlFor="workspace-agent-model">
                {t("agent.model.label")}
                <Input
                  ref={modelInputRef}
                  id="workspace-agent-model"
                  name="workspace-agent-model"
                  defaultValue={model}
                  disabled={running}
                  autoComplete="off"
                  spellCheck={false}
                  onBlur={(event) => {
                    let nextModel =
                      event.currentTarget.value.trim() || DEFAULT_WORKSPACE_AGENT_MODEL;
                    event.currentTarget.value = nextModel;
                    onConfigure({ model: nextModel });
                  }}
                />
              </label>
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
            </div>

            {hasApiKey ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <KeyRoundIcon className="size-3.5" aria-hidden />
                <span>{t("agent.status.keyReady")}</span>
              </div>
            ) : (
              <form
                className="space-y-2 rounded-lg border bg-background p-3"
                onSubmit={handleKeySubmit}
              >
                <label
                  className="grid gap-1.5 text-xs font-medium"
                  htmlFor="workspace-agent-api-key"
                >
                  {t("agent.apiKey.label")}
                  <Input
                    ref={keyInputRef}
                    id="workspace-agent-api-key"
                    name="workspace-agent-api-key"
                    type="password"
                    aria-describedby="workspace-agent-api-key-description"
                    autoComplete="off"
                    placeholder={t("agent.apiKey.placeholder")}
                    required
                    spellCheck={false}
                  />
                </label>
                <p
                  id="workspace-agent-api-key-description"
                  className="text-xs leading-5 text-muted-foreground"
                >
                  {t("agent.apiKey.description")}
                </p>
                <Button type="submit" className="w-full" size="sm">
                  <KeyRoundIcon data-icon="inline-start" />
                  {t("agent.actions.configureKey")}
                </Button>
              </form>
            )}

            {hasApiKey ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitPrompt();
                }}
              >
                <label className="sr-only" htmlFor="workspace-agent-prompt">
                  {t("agent.prompt.label")}
                </label>
                <textarea
                  ref={promptRef}
                  id="workspace-agent-prompt"
                  name="workspace-agent-prompt"
                  className="min-h-20 max-h-40 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  value={prompt}
                  disabled={!workspaceAvailable || running}
                  placeholder={t("agent.prompt.placeholder")}
                  onChange={(event) => setPrompt(event.currentTarget.value)}
                  onKeyDown={handlePromptKeyDown}
                />
                <div className="flex justify-end">
                  {running ? (
                    <Button type="button" variant="outline" onClick={onStop}>
                      <SquareIcon data-icon="inline-start" />
                      {t("agent.actions.stop")}
                    </Button>
                  ) : (
                    <Button type="submit" disabled={!workspaceAvailable || !prompt.trim()}>
                      <SendIcon data-icon="inline-start" />
                      {t("agent.actions.send")}
                    </Button>
                  )}
                </div>
              </form>
            ) : null}
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

function ToolStatusIcon({ status }: { status: WorkspaceAgentToolStatus }) {
  if (status == "running") return <Spinner aria-hidden className="size-3" />;
  if (status == "error") return <CircleAlertIcon className="size-3 text-destructive" aria-hidden />;
  if (status == "cancelled")
    return <SquareIcon className="size-3 text-muted-foreground" aria-hidden />;
  return <CheckIcon className="size-3 text-muted-foreground" aria-hidden />;
}

function toolLabel(name: string, t: ReturnType<typeof useI18n>["t"]) {
  let key = `agent.toolName.${name}` as TranslationKey;
  let translated = t(key);
  return translated == key ? name.replaceAll("_", " ") : translated;
}
