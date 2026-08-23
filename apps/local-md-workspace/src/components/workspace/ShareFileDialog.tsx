import {
  Clock3Icon,
  CopyIcon,
  FileTextIcon,
  LinkIcon,
  RefreshCwIcon,
  Share2Icon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  UserRoundIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ShareExpirationOption } from "@/lib/collaboration/share-identity";
import { translateKnownMessage, useI18n, type Locale, type TFunction } from "@/lib/i18n";
import type { MarkdownFileNode } from "@/lib/workspace-tree";
import type { ActiveOwnerShareRecord } from "@/lib/workspace/types";
import { PendingButtonContent } from "./PendingButtonContent";

type ShareFileDialogProps = {
  activeShare: ActiveOwnerShareRecord | null;
  busy: boolean;
  copied: boolean;
  error: string;
  expiration: ShareExpirationOption;
  file: MarkdownFileNode | null;
  link: string;
  open: boolean;
  shared: boolean;
  onCopyLink: () => Promise<void>;
  onCreateLink: () => Promise<void>;
  onExpirationChange: (value: ShareExpirationOption) => void;
  onOpenChange: (open: boolean) => void;
  onRotateLink: () => Promise<void>;
  onStopSharing: () => Promise<void>;
};

export function ShareFileDialog({
  activeShare,
  busy,
  copied,
  error,
  expiration,
  file,
  link,
  open,
  shared,
  onCopyLink,
  onCreateLink,
  onExpirationChange,
  onOpenChange,
  onRotateLink,
  onStopSharing,
}: ShareFileDialogProps) {
  let { locale, t } = useI18n();
  let expirationId = "shared-file-expiration";
  let linkId = "shared-file-link";
  let filePath = file?.path ?? t("share.noFileSelected");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <div className="flex max-h-[min(720px,calc(100svh-2rem))] flex-col">
          <DialogHeader className="border-b bg-muted/30 px-5 py-4 pr-12">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                <Share2Icon className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-lg">{t("actions.shareFile")}</DialogTitle>
                <DialogDescription className="mt-1 flex min-w-0 items-center gap-1.5">
                  <FileTextIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{filePath}</span>
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                <span>{translateKnownMessage(error, t)}</span>
              </div>
            )}

            {link ? (
              <div className="rounded-lg border bg-card/60 p-3">
                <div className="mb-2 flex min-w-0 items-center gap-2">
                  <LinkIcon className="size-4 shrink-0 text-primary" />
                  <div className="text-sm font-medium">{t("share.editLinkTitle")}</div>
                </div>
                <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
                  {t("share.linkCanEdit")}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id={linkId}
                    readOnly
                    value={link}
                    className="h-8 min-w-0 flex-1 bg-background/70 font-mono text-xs text-muted-foreground"
                  />
                  <Button type="button" disabled={busy} onClick={onCopyLink}>
                    <CopyIcon data-icon="inline-start" />
                    {copied ? t("actions.copied") : t("actions.copyLink")}
                  </Button>
                </div>
              </div>
            ) : shared ? (
              <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3">
                <LinkIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t("share.copyFreshGuestUrl")}
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/10 p-3">
                <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{t("share.createEditLinkTitle")}</div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("share.createEditLinkDescription")}
                  </p>
                </div>
              </div>
            )}

            {shared && (
              <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:gap-4">
                <div className="flex items-center gap-2">
                  <UserRoundIcon className="size-4 shrink-0" />
                  <span>{formatGuestCount(activeShare?.guestCount, t)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock3Icon className="size-4 shrink-0" />
                  <span>{formatCurrentShareExpiration(activeShare?.expiresAt, t, locale)}</span>
                </div>
              </div>
            )}

            <Field className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <FieldLabel htmlFor={expirationId}>
                    {shared ? t("share.rotateExpires") : t("share.expires")}
                  </FieldLabel>
                  <p className="text-xs text-muted-foreground">
                    {shared ? t("share.newGuestLinks") : formatExpirationHint(expiration, t)}
                  </p>
                </div>
                <select
                  id={expirationId}
                  className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy}
                  value={expiration}
                  onChange={(event) =>
                    onExpirationChange(event.currentTarget.value as ShareExpirationOption)
                  }
                >
                  <option value="24h">{t("share.expiration.24h")}</option>
                  <option value="7d">{t("share.expiration.7d")}</option>
                  <option value="30d">{t("share.expiration.30d")}</option>
                </select>
              </div>
            </Field>
          </div>

          <DialogFooter className="mx-0 mb-0 rounded-none bg-muted/30 px-5 py-3 sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("common.close")}
            </Button>
            {shared ? (
              <>
                <Button type="button" variant="destructive" disabled={busy} onClick={onStopSharing}>
                  <PendingButtonContent pending={busy} pendingLabel={t("actions.stopping")}>
                    {t("actions.stopSharing")}
                  </PendingButtonContent>
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={onRotateLink}>
                  <PendingButtonContent pending={busy} pendingLabel={t("actions.rotating")}>
                    <RefreshCwIcon data-icon="inline-start" />
                    {t("actions.rotateLink")}
                  </PendingButtonContent>
                </Button>
              </>
            ) : (
              <Button type="button" disabled={busy || !file} onClick={onCreateLink}>
                <PendingButtonContent pending={busy} pendingLabel={t("actions.creatingLink")}>
                  <Share2Icon data-icon="inline-start" />
                  {t("actions.createLink")}
                </PendingButtonContent>
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatGuestCount(count: number | undefined, t: TFunction) {
  if (count == null) return t("common.unknown");
  return count == 1 ? t("share.guestCount_one") : t("share.guestCount_other", { count });
}

function formatCurrentShareExpiration(
  expiresAt: number | null | undefined,
  t: TFunction,
  locale: Locale,
) {
  if (expiresAt == null) return t("share.currentLinkExpirationUnknown");
  return expiresAt <= Date.now()
    ? t("share.currentLinkExpired", { time: formatTimestamp(expiresAt, locale) })
    : t("share.currentLinkExpires", { time: formatTimestamp(expiresAt, locale) });
}

function formatExpirationHint(expiration: ShareExpirationOption, t: TFunction) {
  switch (expiration) {
    case "24h":
      return t("share.expirationHint.24h");
    case "7d":
      return t("share.expirationHint.7d");
    case "30d":
      return t("share.expirationHint.30d");
  }
}

function formatTimestamp(value: number, locale: Locale) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
