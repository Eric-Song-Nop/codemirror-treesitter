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
import type { FileDialogMode } from "@/lib/workspace/types";

type FileNameDialogProps = {
  busy: boolean;
  error: string;
  mode: FileDialogMode | null;
  open: boolean;
  value: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: string) => Promise<void>;
  onValueChange: (value: string) => void;
};

export function FileNameDialog({
  busy,
  error,
  mode,
  open,
  value,
  onOpenChange,
  onSubmit,
  onValueChange,
}: FileNameDialogProps) {
  let { t } = useI18n();
  let inputId = "markdown-file-name";
  let createMode = mode == "create";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit(value);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {createMode ? t("dialog.file.title.create") : t("dialog.file.title.rename")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {createMode
                ? t("dialog.file.description.create")
                : t("dialog.file.description.rename")}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor={inputId}>
                {createMode ? t("dialog.file.label.path") : t("dialog.file.label.name")}
              </FieldLabel>
              <Input
                id={inputId}
                aria-invalid={Boolean(error)}
                autoFocus
                placeholder={createMode ? t("dialog.file.placeholder.create") : undefined}
                value={value}
                onChange={(event) => onValueChange(event.target.value)}
              />
              <FieldError>{translateKnownMessage(error, t)}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {createMode ? t("common.create") : t("actions.rename")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type SaveAsCloudDialogProps = {
  busy: boolean;
  description: string;
  error: string;
  inputId: string;
  open: boolean;
  placeholder: string;
  title: string;
  value: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: string) => Promise<void>;
  onValueChange: (value: string) => void;
};

function SaveAsCloudDialog({
  busy,
  description,
  error,
  inputId,
  open,
  placeholder,
  title,
  value,
  onOpenChange,
  onSubmit,
  onValueChange,
}: SaveAsCloudDialogProps) {
  let { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit(value);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{description}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor={inputId}>{t("dialog.file.label.path")}</FieldLabel>
              <Input
                id={inputId}
                aria-invalid={Boolean(error)}
                autoFocus
                placeholder={placeholder}
                value={value}
                onChange={(event) => onValueChange(event.target.value)}
              />
              <FieldError>{translateKnownMessage(error, t)}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t("actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type SaveAsProviderDialogProps = Omit<
  SaveAsCloudDialogProps,
  "description" | "inputId" | "placeholder" | "title"
>;

export function SaveAsDropboxDialog(props: SaveAsProviderDialogProps) {
  let { t } = useI18n();
  return (
    <SaveAsCloudDialog
      {...props}
      description={t("dialog.saveAsDropbox.description")}
      inputId="dropbox-save-as-path"
      placeholder={t("dialog.saveAsDropbox.placeholder")}
      title={t("dialog.saveAsDropbox.title")}
    />
  );
}
