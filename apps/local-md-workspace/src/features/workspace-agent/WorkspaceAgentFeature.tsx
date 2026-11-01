import { useCallback } from "react";
import { useWorkspaceApplication } from "@/app/WorkspaceApplicationProvider";
import { useI18n } from "@/lib/i18n";
import { useWorkspaceAgentHost, type WorkspaceAgentHostRefs } from "./useWorkspaceAgentHost";
import { WorkspaceAgentPanel } from "./WorkspaceAgentPanel";
import { useWorkspaceAgentCredentials } from "./WorkspaceAgentCredentialsProvider";
import { useWorkspaceAgent } from "./useWorkspaceAgent";

type WorkspaceAgentFeatureProps = WorkspaceAgentHostRefs & {
  open: boolean;
  scopeKey: string;
  workspaceAvailable: boolean;
  workspaceKey: string;
  onClose: () => void;
  onOpenSettings: () => void;
};

export function WorkspaceAgentFeature({
  open,
  scopeKey,
  workspaceAvailable,
  workspaceKey,
  onClose,
  onOpenSettings,
  ...hostRefs
}: WorkspaceAgentFeatureProps) {
  let { t } = useI18n();
  let credentials = useWorkspaceAgentCredentials();
  let createRunHost = useWorkspaceAgentHost(hostRefs);
  let { documentViews } = useWorkspaceApplication();
  let getOpenDocumentPath = useCallback(
    () => documentViews.current()?.file.path ?? null,
    [documentViews],
  );
  let {
    activeSessionId,
    approvals,
    edits,
    error,
    errorCode,
    hasApiKey,
    messages,
    model,
    newChat,
    resolveApproval,
    revertEdit,
    selectSession,
    send,
    sessions,
    setModel,
    stop,
  } = useWorkspaceAgent({
    getApiKey: credentials.getApiKey,
    getOpenDocumentPath,
    scopeKey,
    subscribeToCredentials: credentials.subscribe,
    workspaceKey,
  });
  let displayedError = errorCode ? t(`agent.error.${errorCode}`) : error;

  let sendMessage = useCallback(
    (prompt: string) => send(prompt, createRunHost),
    [createRunHost, send],
  );

  return (
    <WorkspaceAgentPanel
      activeSessionId={activeSessionId}
      approvals={approvals}
      credentialLoading={credentials.status == "checking"}
      credentialStored={credentials.hasStoredKey}
      edits={edits}
      error={displayedError}
      hasApiKey={hasApiKey}
      messages={messages}
      model={model}
      open={open}
      sessions={sessions}
      workspaceAvailable={workspaceAvailable}
      onClose={onClose}
      onModelChange={setModel}
      onNewChat={newChat}
      onOpenSettings={onOpenSettings}
      onResolveApproval={resolveApproval}
      onRevertEdit={revertEdit}
      onSelectSession={selectSession}
      onSend={sendMessage}
      onStop={stop}
    />
  );
}
