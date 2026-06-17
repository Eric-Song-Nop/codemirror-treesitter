import { CloudIcon, FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { PendingButtonContent } from "./PendingButtonContent";

type WorkspaceLauncherProps = {
  browserSupported: boolean;
  busy: boolean;
  dropboxConnecting: boolean;
  dropboxRestoreAvailable: boolean;
  restoreAvailable: boolean;
  restoreChecking: boolean;
  onOpenDropbox: () => void;
  onOpenFolder: () => void;
  onRestoreDropbox: () => void;
  onRestoreFolder: () => void;
};

export function WorkspaceLauncher({
  browserSupported,
  busy,
  dropboxConnecting,
  dropboxRestoreAvailable,
  restoreAvailable,
  restoreChecking,
  onOpenDropbox,
  onOpenFolder,
  onRestoreDropbox,
  onRestoreFolder,
}: WorkspaceLauncherProps) {
  let { t } = useI18n();
  let hasPrimaryRestore = restoreAvailable || dropboxRestoreAvailable;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      {restoreAvailable && (
        <Button
          className="justify-start"
          disabled={!browserSupported || busy || restoreChecking}
          onClick={onRestoreFolder}
        >
          <PendingButtonContent
            pending={busy || restoreChecking}
            pendingLabel={t("actions.restoring")}
          >
            <FolderOpenIcon data-icon="inline-start" />
            {t("actions.continuePreviousFolder")}
          </PendingButtonContent>
        </Button>
      )}
      {dropboxRestoreAvailable && (
        <Button
          className="justify-start"
          disabled={busy || dropboxConnecting}
          variant={restoreAvailable ? "outline" : "default"}
          onClick={onRestoreDropbox}
        >
          <PendingButtonContent
            pending={busy || dropboxConnecting}
            pendingLabel={t("actions.connecting")}
          >
            <CloudIcon data-icon="inline-start" />
            {t("actions.continueDropbox")}
          </PendingButtonContent>
        </Button>
      )}
      <Button
        className="justify-start"
        disabled={!browserSupported || busy}
        variant={hasPrimaryRestore ? "outline" : "default"}
        onClick={onOpenFolder}
      >
        <PendingButtonContent pending={busy} pendingLabel={t("actions.opening")}>
          <FolderOpenIcon data-icon="inline-start" />
          {t("actions.openFolder")}
        </PendingButtonContent>
      </Button>
      <Button
        className="justify-start"
        disabled={busy || dropboxConnecting}
        variant="outline"
        onClick={onOpenDropbox}
      >
        <PendingButtonContent pending={dropboxConnecting} pendingLabel={t("actions.connecting")}>
          <CloudIcon data-icon="inline-start" />
          {t("actions.connectDropbox")}
        </PendingButtonContent>
      </Button>
    </div>
  );
}
