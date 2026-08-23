import { FileOutputIcon, FilePlus2Icon, RefreshCcwIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { translateKnownMessage, useI18n } from "@/lib/i18n";

type WorkspaceErrorBannerProps = {
  busy: boolean;
  message: string;
  recoveryKind?: "missing" | "recovery-required";
  retryPath: string | null;
  onRetry: () => void;
  onKeepLocalAs?: () => void;
  onRecreate?: () => void;
  onUseExternal?: () => void;
};

export function WorkspaceErrorBanner({
  busy,
  message,
  recoveryKind,
  onKeepLocalAs,
  onRecreate,
  retryPath,
  onRetry,
  onUseExternal,
}: WorkspaceErrorBannerProps) {
  let { t } = useI18n();

  if (!message) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <div className="min-w-0 flex-1">{translateKnownMessage(message, t)}</div>
      {recoveryKind && onKeepLocalAs && (
        <Button size="sm" variant="outline" disabled={busy} onClick={onKeepLocalAs}>
          <FileOutputIcon data-icon="inline-start" />
          {t("recovery.keepLocalAs.action")}
        </Button>
      )}
      {recoveryKind == "missing" && onRecreate && (
        <Button size="sm" variant="outline" disabled={busy} onClick={onRecreate}>
          <FilePlus2Icon data-icon="inline-start" />
          {t("recovery.recreate.action")}
        </Button>
      )}
      {recoveryKind == "recovery-required" && onUseExternal && (
        <Button size="sm" variant="outline" disabled={busy} onClick={onUseExternal}>
          <RefreshCcwIcon data-icon="inline-start" />
          {t("recovery.useExternal.action")}
        </Button>
      )}
      {retryPath && (
        <Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>
          <RefreshCwIcon data-icon="inline-start" />
          {t("actions.retry")}
        </Button>
      )}
    </div>
  );
}
