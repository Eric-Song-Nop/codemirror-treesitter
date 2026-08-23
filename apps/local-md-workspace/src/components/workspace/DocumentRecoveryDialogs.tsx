import { FilePlus2Icon, RefreshCcwIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { translateKnownMessage, useI18n } from "@/lib/i18n";
import { PendingButtonContent } from "./PendingButtonContent";

export type DocumentRecoveryAction = "keep-local-as" | "recreate" | "use-external";

type DocumentRecoveryDialogsProps = {
  action: DocumentRecoveryAction | null;
  busy: boolean;
  copyPath: string;
  error: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  onCopyPathChange: (value: string) => void;
  onKeepLocalAs: (path: string) => Promise<void>;
};

export function DocumentRecoveryDialogs({
  action,
  busy,
  copyPath,
  error,
  onClose,
  onConfirm,
  onCopyPathChange,
  onKeepLocalAs,
}: DocumentRecoveryDialogsProps) {
  let { t } = useI18n();
  let keepLocalAs = action == "keep-local-as";
  let useExternal = action == "use-external";

  return (
    <>
      <Dialog open={keepLocalAs} onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void onKeepLocalAs(copyPath);
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("recovery.keepLocalAs.title")}</DialogTitle>
              <DialogDescription>{t("recovery.keepLocalAs.description")}</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="recovery-copy-path">{t("dialog.file.label.path")}</FieldLabel>
                <Input
                  id="recovery-copy-path"
                  aria-invalid={Boolean(error)}
                  autoFocus
                  value={copyPath}
                  onChange={(event) => onCopyPathChange(event.target.value)}
                />
                <FieldError>{translateKnownMessage(error, t)}</FieldError>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                <PendingButtonContent pending={busy} pendingLabel={t("actions.saving")}>
                  {t("recovery.keepLocalAs.action")}
                </PendingButtonContent>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={action == "recreate" || useExternal}
        onOpenChange={(open) => !open && onClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              {useExternal ? <RefreshCcwIcon /> : <FilePlus2Icon />}
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t(useExternal ? "recovery.useExternal.title" : "recovery.recreate.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                useExternal ? "recovery.useExternal.description" : "recovery.recreate.description",
              )}
              {error && (
                <span className="mt-2 block text-destructive">
                  {translateKnownMessage(error, t)}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant={useExternal ? "destructive" : "default"}
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void onConfirm();
              }}
            >
              <PendingButtonContent pending={busy} pendingLabel={t("actions.saving")}>
                {t(useExternal ? "recovery.useExternal.action" : "recovery.recreate.action")}
              </PendingButtonContent>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
