import { Trash2Icon } from "lucide-react";
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
import type { FileTreeDeleteTarget } from "@/components/FileTree";
import { useI18n } from "@/lib/i18n";
import { PendingButtonContent } from "./PendingButtonContent";

type DeleteEntryDialogProps = {
  busy: boolean;
  target: FileTreeDeleteTarget | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
};

export function DeleteEntryDialog({
  busy,
  target,
  onConfirm,
  onOpenChange,
}: DeleteEntryDialogProps) {
  let { t } = useI18n();

  return (
    <AlertDialog open={target != null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {target?.kind == "directory" ? t("delete.title.folder") : t("delete.title.file")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? target.kind == "directory"
                ? t("delete.description.folder", { path: target.path })
                : t("delete.description.file", { path: target.path })
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            <PendingButtonContent pending={busy} pendingLabel={t("actions.deleting")}>
              {t("actions.delete")}
            </PendingButtonContent>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
