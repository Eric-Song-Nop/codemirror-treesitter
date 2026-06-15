import { CloudIcon, FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

type WorkspaceLauncherProps = {
  browserSupported: boolean;
  busy: boolean;
  dropboxConnecting: boolean;
  dropboxRestoreAvailable: boolean;
  oneDriveConnecting: boolean;
  oneDriveRestoreAvailable: boolean;
  restoreAvailable: boolean;
  restoreChecking: boolean;
  onOpenDropbox: () => void;
  onOpenOneDrive: () => void;
  onOpenFolder: () => void;
  onRestoreDropbox: () => void;
  onRestoreOneDrive: () => void;
  onRestoreFolder: () => void;
};

export function WorkspaceLauncher({
  browserSupported,
  busy,
  dropboxConnecting,
  dropboxRestoreAvailable,
  oneDriveConnecting,
  oneDriveRestoreAvailable,
  restoreAvailable,
  restoreChecking,
  onOpenDropbox,
  onOpenOneDrive,
  onOpenFolder,
  onRestoreDropbox,
  onRestoreOneDrive,
  onRestoreFolder,
}: WorkspaceLauncherProps) {
  let { t } = useI18n();
  let hasPrimaryRestore = restoreAvailable || dropboxRestoreAvailable || oneDriveRestoreAvailable;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      {restoreAvailable && (
        <Button
          className="justify-start"
          disabled={!browserSupported || busy || restoreChecking}
          onClick={onRestoreFolder}
        >
          <FolderOpenIcon data-icon="inline-start" />
          {t("actions.continuePreviousFolder")}
        </Button>
      )}
      {dropboxRestoreAvailable && (
        <Button
          className="justify-start"
          disabled={busy || dropboxConnecting}
          variant={restoreAvailable ? "outline" : "default"}
          onClick={onRestoreDropbox}
        >
          <CloudIcon data-icon="inline-start" />
          {t("actions.continueDropbox")}
        </Button>
      )}
      {oneDriveRestoreAvailable && (
        <Button
          className="justify-start"
          disabled={busy || oneDriveConnecting}
          variant={restoreAvailable || dropboxRestoreAvailable ? "outline" : "default"}
          onClick={onRestoreOneDrive}
        >
          <CloudIcon data-icon="inline-start" />
          {t("actions.continueOneDrive")}
        </Button>
      )}
      <Button
        className="justify-start"
        disabled={!browserSupported || busy}
        variant={hasPrimaryRestore ? "outline" : "default"}
        onClick={onOpenFolder}
      >
        <FolderOpenIcon data-icon="inline-start" />
        {t("actions.openFolder")}
      </Button>
      <Button
        className="justify-start"
        disabled={busy || dropboxConnecting}
        variant="outline"
        onClick={onOpenDropbox}
      >
        <CloudIcon data-icon="inline-start" />
        {t("actions.connectDropbox")}
      </Button>
      <Button
        className="justify-start"
        disabled={busy || oneDriveConnecting}
        variant="outline"
        onClick={onOpenOneDrive}
      >
        <CloudIcon data-icon="inline-start" />
        {t("actions.connectOneDrive")}
      </Button>
    </div>
  );
}
