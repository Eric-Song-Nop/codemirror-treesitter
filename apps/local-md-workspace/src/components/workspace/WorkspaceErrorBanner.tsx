import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { translateKnownMessage, useI18n } from "@/lib/i18n";

type WorkspaceErrorBannerProps = {
  busy: boolean;
  message: string;
  retryPath: string | null;
  onRetry: () => void;
};

export function WorkspaceErrorBanner({
  busy,
  message,
  retryPath,
  onRetry,
}: WorkspaceErrorBannerProps) {
  let { t } = useI18n();

  if (!message) return null;

  return (
    <div className="flex items-center gap-2 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <div className="min-w-0 flex-1">{translateKnownMessage(message, t)}</div>
      {retryPath && (
        <Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>
          <RefreshCwIcon data-icon="inline-start" />
          {t("actions.retry")}
        </Button>
      )}
    </div>
  );
}
