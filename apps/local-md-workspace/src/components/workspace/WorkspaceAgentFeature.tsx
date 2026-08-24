import { useCallback, useEffect } from "react";
import { useI18n } from "@/lib/i18n";
import { useWorkspaceAgent } from "@/hooks/agent/useWorkspaceAgent";
import {
  useWorkspaceAgentHost,
  type WorkspaceAgentHostRefs,
} from "@/hooks/agent/useWorkspaceAgentHost";
import { WorkspaceAgentPanel } from "./WorkspaceAgentPanel";

type WorkspaceAgentFeatureProps = WorkspaceAgentHostRefs & {
  open: boolean;
  scopeKey: string;
  workspaceAvailable: boolean;
  workspaceKey: string;
  onClose: () => void;
};

export function WorkspaceAgentFeature({
  open,
  scopeKey,
  workspaceAvailable,
  workspaceKey,
  onClose,
  ...hostRefs
}: WorkspaceAgentFeatureProps) {
  let { t } = useI18n();
  let createRunHost = useWorkspaceAgentHost(hostRefs);
  let {
    configure,
    error,
    errorCode,
    hasApiKey,
    messages,
    model,
    newChat,
    send,
    stop,
    status,
    toolActivity,
  } = useWorkspaceAgent({ scopeKey, workspaceKey });
  let displayedError = errorCode ? t(`agent.error.${errorCode}`) : error;

  useEffect(() => {
    if (!open) stop();
  }, [open, stop]);

  let close = useCallback(() => {
    stop();
    onClose();
  }, [onClose, stop]);

  let sendMessage = useCallback(
    (prompt: string) => send(prompt, createRunHost),
    [createRunHost, send],
  );

  return (
    <WorkspaceAgentPanel
      error={displayedError}
      hasApiKey={hasApiKey}
      messages={messages}
      model={model}
      open={open}
      runStatus={status}
      toolActivity={toolActivity}
      workspaceAvailable={workspaceAvailable}
      onClose={close}
      onConfigure={configure}
      onNewChat={newChat}
      onSend={sendMessage}
      onStop={stop}
    />
  );
}
