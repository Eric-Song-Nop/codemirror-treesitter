import {
  CheckIcon,
  KeyRoundIcon,
  LanguagesIcon,
  LockKeyholeIcon,
  MoonIcon,
  PaletteIcon,
  ReplaceIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SunIcon,
  Trash2Icon,
  UnlockIcon,
  type LucideProps,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentType, type FormEvent } from "react";
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
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  useWorkspaceAgentCredentials,
  type WorkspaceAgentCredentialSnapshot,
} from "@/features/workspace-agent/WorkspaceAgentCredentialsProvider";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { themeDefinitions, useTheme } from "@/theme";

type WorkspaceSettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function WorkspaceSettingsDialog({ open, onOpenChange }: WorkspaceSettingsDialogProps) {
  let { locale, setLocale, t } = useI18n();
  let { setTheme, theme } = useTheme();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        id="workspace-settings-dialog"
        className="overflow-hidden p-0 motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none sm:max-w-lg"
      >
        <div className="flex max-h-[min(760px,calc(100svh-2rem))] min-h-0 flex-col">
          <DialogHeader className="border-b bg-muted/30 px-5 py-4 pr-12">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                <Settings2Icon aria-hidden="true" className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-lg text-balance">{t("settings.title")}</DialogTitle>
                <DialogDescription className="mt-1 text-pretty">
                  {t("settings.description")}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="flex min-h-0 flex-col gap-5 overflow-x-hidden overflow-y-auto overscroll-contain px-5 py-4">
            <CredentialSettings />

            <PreferenceFieldset
              description={t("settings.appearance.description")}
              icon={PaletteIcon}
              title={t("settings.appearance.title")}
            >
              {themeDefinitions.map((definition) => {
                let active = definition.id == theme;
                return (
                  <PreferenceChoice
                    key={definition.id}
                    active={active}
                    description={
                      definition.appearance == "dark"
                        ? t("settings.appearance.dark")
                        : t("settings.appearance.light")
                    }
                    icon={definition.appearance == "dark" ? MoonIcon : SunIcon}
                    id={`settings-theme-${definition.id}`}
                    label={definition.label}
                    name="settings-theme"
                    translate="no"
                    value={definition.id}
                    onChange={() => setTheme(definition.id)}
                  />
                );
              })}
            </PreferenceFieldset>

            <PreferenceFieldset
              description={t("settings.language.description")}
              icon={LanguagesIcon}
              title={t("settings.language.title")}
            >
              <PreferenceChoice
                active={locale == "en"}
                description={t("settings.language.englishDescription")}
                icon={LanguagesIcon}
                id="settings-language-en"
                label="English"
                lang="en"
                name="settings-language"
                value="en"
                onChange={() => setLocale("en")}
              />
              <PreferenceChoice
                active={locale == "zh-CN"}
                description={t("settings.language.chineseDescription")}
                icon={LanguagesIcon}
                id="settings-language-zh-CN"
                label="简体中文"
                lang="zh-CN"
                name="settings-language"
                value="zh-CN"
                onChange={() => setLocale("zh-CN")}
              />
            </PreferenceFieldset>
          </div>

          <DialogFooter className="mx-0 mb-0 rounded-none bg-muted/30 px-5 py-3">
            <DialogClose asChild>
              <Button
                className="min-h-11 touch-manipulation sm:min-h-8"
                type="button"
                variant="ghost"
              >
                {t("common.close")}
              </Button>
            </DialogClose>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CredentialSettings() {
  let { t } = useI18n();
  let { errorCode, forget, hasApiKey, hasStoredKey, lock, save, status, unlock } =
    useWorkspaceAgentCredentials();
  let [forgetOpen, setForgetOpen] = useState(false);
  let [replaceOpen, setReplaceOpen] = useState(false);
  let credentialSectionRef = useRef<HTMLElement>(null);
  let replaceFormRef = useRef<HTMLFormElement>(null);
  let pending =
    status == "checking" || status == "saving" || status == "unlocking" || status == "forgetting";
  let mode = hasApiKey ? "unlocked" : hasStoredKey ? "locked" : "empty";

  let toggleReplace = () => {
    setReplaceOpen((current) => {
      if (current) replaceFormRef.current?.reset();
      return !current;
    });
  };

  let deleteSavedKey = async () => {
    clearCredentialInputs(credentialSectionRef.current);
    try {
      await forget();
    } catch {
      // The provider publishes a stable errorCode; raw errors never enter the UI.
    } finally {
      replaceFormRef.current?.reset();
      setForgetOpen(false);
      setReplaceOpen(false);
    }
  };

  useEffect(() => {
    let clear = () => clearCredentialInputs(credentialSectionRef.current);
    globalThis.addEventListener?.("pagehide", clear);
    return () => globalThis.removeEventListener?.("pagehide", clear);
  }, []);

  return (
    <section
      ref={credentialSectionRef}
      aria-labelledby="settings-credentials-title"
      className="grid gap-3"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <KeyRoundIcon aria-hidden="true" className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="settings-credentials-title" className="text-sm font-medium">
              {t("settings.credentials.title")}
            </h3>
            <CredentialStatus status={status} />
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
            {t("settings.credentials.description")}
          </p>
        </div>
      </div>

      <div aria-busy={pending} className="rounded-lg border bg-muted/20 p-3">
        {errorCode && (
          <div
            aria-live="polite"
            className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive text-pretty"
            role="alert"
          >
            {credentialErrorMessage(errorCode, t)}
          </div>
        )}

        {status == "checking" ? (
          <div className="flex min-h-20 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" className="motion-reduce:animate-none" />
            <span>{t("settings.credentials.status.checking")}</span>
          </div>
        ) : mode == "empty" ? (
          <div className="grid gap-3">
            <CredentialLead
              description={t("settings.credentials.empty.description")}
              icon={ShieldCheckIcon}
              title={t("settings.credentials.empty.title")}
            />
            <CredentialSaveForm pending={status == "saving"} save={save} />
          </div>
        ) : mode == "locked" ? (
          <div className="grid gap-3">
            <CredentialLead
              description={t("settings.credentials.locked.description")}
              icon={LockKeyholeIcon}
              title={t("settings.credentials.locked.title")}
            />
            <CredentialUnlockForm pending={status == "unlocking"} unlock={unlock} />
            <Button
              className="min-h-11 touch-manipulation sm:min-h-8"
              disabled={pending}
              type="button"
              variant="destructive"
              onClick={() => setForgetOpen(true)}
            >
              <Trash2Icon aria-hidden="true" data-icon="inline-start" />
              {t("settings.credentials.actions.delete")}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <CredentialLead
              description={t("settings.credentials.unlocked.description")}
              icon={UnlockIcon}
              title={t("settings.credentials.unlocked.title")}
            />
            <div className="grid gap-2 sm:grid-cols-3">
              <Button
                className="min-h-11 touch-manipulation sm:min-h-8"
                disabled={pending}
                type="button"
                variant="outline"
                onClick={() => {
                  clearCredentialInputs(credentialSectionRef.current);
                  replaceFormRef.current?.reset();
                  setReplaceOpen(false);
                  lock();
                }}
              >
                <LockKeyholeIcon aria-hidden="true" data-icon="inline-start" />
                {t("settings.credentials.actions.lock")}
              </Button>
              <Button
                aria-controls="settings-credentials-replace"
                aria-expanded={replaceOpen}
                className="min-h-11 touch-manipulation sm:min-h-8"
                disabled={pending}
                type="button"
                variant="outline"
                onClick={toggleReplace}
              >
                <ReplaceIcon aria-hidden="true" data-icon="inline-start" />
                {t("settings.credentials.actions.replace")}
              </Button>
              <Button
                className="min-h-11 touch-manipulation sm:min-h-8"
                disabled={pending}
                type="button"
                variant="destructive"
                onClick={() => setForgetOpen(true)}
              >
                <Trash2Icon aria-hidden="true" data-icon="inline-start" />
                {t("settings.credentials.actions.delete")}
              </Button>
            </div>

            {replaceOpen && (
              <div id="settings-credentials-replace" className="border-t pt-3">
                <div className="mb-3">
                  <h4 className="text-sm font-medium">{t("settings.credentials.replace.title")}</h4>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
                    {t("settings.credentials.replace.description")}
                  </p>
                </div>
                <CredentialSaveForm
                  ref={replaceFormRef}
                  pending={status == "saving"}
                  replace
                  save={save}
                  onSaved={() => setReplaceOpen(false)}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <AlertDialog
        open={forgetOpen}
        onOpenChange={(nextOpen) => {
          if (status != "forgetting") setForgetOpen(nextOpen);
        }}
      >
        <AlertDialogContent className="max-w-[calc(100%-2rem)] motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2Icon aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t("settings.credentials.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.credentials.delete.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="min-h-11 touch-manipulation sm:min-h-8"
              disabled={status == "forgetting"}
            >
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 touch-manipulation sm:min-h-8"
              disabled={status == "forgetting"}
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                void deleteSavedKey();
              }}
            >
              <SettingsPendingContent
                pending={status == "forgetting"}
                pendingLabel={t("settings.credentials.status.forgetting")}
              >
                {t("settings.credentials.actions.delete")}
              </SettingsPendingContent>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

type CredentialSaveFormProps = {
  pending: boolean;
  replace?: boolean;
  save: (apiKey: string, passphrase: string) => Promise<boolean>;
  onSaved?: () => void;
};

function CredentialSaveForm({
  pending,
  replace = false,
  save,
  onSaved,
  ref,
}: CredentialSaveFormProps & { ref?: React.Ref<HTMLFormElement> }) {
  let { t } = useI18n();
  let prefix = replace ? "settings-replace" : "settings-save";

  let submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let form = event.currentTarget;
    let confirmationInput = form.elements.namedItem("credential-passphrase-confirmation");
    if (!(confirmationInput instanceof HTMLInputElement)) return;
    confirmationInput.setCustomValidity("");
    if (!form.reportValidity()) return;

    let formData = new FormData(form);
    let apiKey = formDataText(formData, "deepseek-api-key");
    let passphrase = formDataText(formData, "credential-passphrase");
    let confirmation = formDataText(formData, "credential-passphrase-confirmation");
    if (passphrase != confirmation) {
      confirmationInput.setCustomValidity(t("settings.credentials.passphrase.mismatch"));
      confirmationInput.reportValidity();
      return;
    }
    form.reset();
    let saved = await save(apiKey, passphrase);
    if (!saved) return;
    onSaved?.();
  };

  return (
    <form ref={ref} className="grid gap-3" onSubmit={(event) => void submit(event)}>
      <SecretField
        autoComplete="off"
        description={t("settings.credentials.apiKey.description")}
        id={`${prefix}-api-key`}
        label={t("settings.credentials.apiKey.label")}
        maxLength={512}
        name="deepseek-api-key"
        placeholder={t("settings.credentials.apiKey.placeholder")}
      />
      <SecretField
        autoComplete="new-password"
        description={t("settings.credentials.passphrase.description")}
        id={`${prefix}-passphrase`}
        label={t("settings.credentials.passphrase.label")}
        maxLength={256}
        minLength={12}
        name="credential-passphrase"
        placeholder={t("settings.credentials.passphrase.createPlaceholder")}
      />
      <SecretField
        autoComplete="new-password"
        description={t("settings.credentials.passphrase.confirmDescription")}
        id={`${prefix}-passphrase-confirmation`}
        label={t("settings.credentials.passphrase.confirmLabel")}
        maxLength={256}
        minLength={12}
        name="credential-passphrase-confirmation"
        placeholder={t("settings.credentials.passphrase.createPlaceholder")}
        onInput={(event) => event.currentTarget.setCustomValidity("")}
      />
      <Button
        className="min-h-11 touch-manipulation sm:min-h-8 sm:justify-self-end"
        disabled={pending}
        type="submit"
      >
        <SettingsPendingContent
          pending={pending}
          pendingLabel={t("settings.credentials.status.saving")}
        >
          {replace
            ? t("settings.credentials.actions.saveReplacement")
            : t("settings.credentials.actions.save")}
        </SettingsPendingContent>
      </Button>
    </form>
  );
}

function CredentialUnlockForm({
  pending,
  unlock,
}: {
  pending: boolean;
  unlock: (passphrase: string) => Promise<boolean>;
}) {
  let { t } = useI18n();

  let submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let form = event.currentTarget;
    if (!form.reportValidity()) return;

    let passphrase = formDataText(new FormData(form), "credential-passphrase");
    form.reset();
    await unlock(passphrase);
  };

  return (
    <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
      <SecretField
        autoComplete="current-password"
        description={t("settings.credentials.passphrase.unlockDescription")}
        id="settings-unlock-passphrase"
        label={t("settings.credentials.passphrase.label")}
        maxLength={256}
        minLength={12}
        name="credential-passphrase"
        placeholder={t("settings.credentials.passphrase.unlockPlaceholder")}
      />
      <Button
        className="min-h-11 touch-manipulation sm:min-h-8 sm:justify-self-end"
        disabled={pending}
        type="submit"
      >
        <SettingsPendingContent
          pending={pending}
          pendingLabel={t("settings.credentials.status.unlocking")}
        >
          {t("settings.credentials.actions.unlock")}
        </SettingsPendingContent>
      </Button>
    </form>
  );
}

function SecretField({
  autoComplete,
  description,
  id,
  label,
  maxLength,
  minLength,
  name,
  placeholder,
  onInput,
}: {
  autoComplete: "current-password" | "new-password" | "off";
  description: string;
  id: string;
  label: string;
  maxLength: number;
  minLength?: number;
  name: string;
  placeholder: string;
  onInput?: React.FormEventHandler<HTMLInputElement>;
}) {
  let descriptionId = `${id}-description`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        aria-describedby={descriptionId}
        autoCapitalize="none"
        autoComplete={autoComplete}
        autoCorrect="off"
        className="h-11 font-mono sm:h-8"
        id={id}
        maxLength={maxLength}
        minLength={minLength}
        name={name}
        placeholder={placeholder}
        required
        spellCheck={false}
        type="password"
        onInput={onInput}
      />
      <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground text-pretty">
        {description}
      </p>
    </div>
  );
}

function CredentialLead({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: ComponentType<LucideProps>;
  title: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground text-pretty">
          {description}
        </p>
      </div>
    </div>
  );
}

function CredentialStatus({ status }: { status: WorkspaceAgentCredentialSnapshot["status"] }) {
  let { t } = useI18n();
  let label = credentialStatusLabel(status, t);
  let positive = status == "unlocked";
  let failed = status == "error";
  return (
    <span
      aria-live="polite"
      className={cn(
        "inline-flex min-h-6 items-center rounded-full px-2 text-xs font-medium",
        positive && "bg-primary/10 text-primary",
        failed && "bg-destructive/10 text-destructive",
        !positive && !failed && "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function PreferenceFieldset({
  children,
  description,
  icon: Icon,
  title,
}: {
  children: React.ReactNode;
  description: string;
  icon: ComponentType<LucideProps>;
  title: string;
}) {
  return (
    <fieldset className="grid gap-3 border-t pt-5">
      <legend className="w-full">
        <span className="flex min-w-0 items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon aria-hidden="true" className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{title}</span>
            <span className="mt-1 block text-xs leading-relaxed font-normal text-muted-foreground text-pretty">
              {description}
            </span>
          </span>
        </span>
      </legend>
      <div className="grid gap-2">{children}</div>
    </fieldset>
  );
}

function PreferenceChoice({
  active,
  description,
  icon: Icon,
  id,
  label,
  lang,
  name,
  translate,
  value,
  onChange,
}: {
  active: boolean;
  description: string;
  icon: ComponentType<LucideProps>;
  id: string;
  label: string;
  lang?: string;
  name: string;
  translate?: "no";
  value: string;
  onChange: () => void;
}) {
  return (
    <label
      className={cn(
        "relative flex min-h-11 cursor-pointer touch-manipulation items-center gap-3 overflow-hidden rounded-lg border py-2 pr-3 pl-4 before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:content-[''] hover:bg-muted/50",
        active
          ? "border-primary/30 bg-primary/5 before:bg-primary dark:bg-primary/10"
          : "before:bg-transparent",
      )}
      htmlFor={id}
    >
      <input
        checked={active}
        className="peer sr-only"
        id={id}
        name={name}
        type="radio"
        value={value}
        onChange={onChange}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit] peer-focus-visible:ring-3 peer-focus-visible:ring-inset peer-focus-visible:ring-ring/50"
      />
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" lang={lang} translate={translate}>
          {label}
        </span>
        <span className="line-clamp-2 text-xs text-muted-foreground">{description}</span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border",
          active ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {active && <CheckIcon className="size-3" />}
      </span>
    </label>
  );
}

function SettingsPendingContent({
  children,
  pending,
  pendingLabel,
}: {
  children: React.ReactNode;
  pending: boolean;
  pendingLabel: string;
}) {
  if (!pending) return children;
  return (
    <>
      <Spinner aria-hidden="true" className="motion-reduce:animate-none" data-icon="inline-start" />
      <span className="truncate">{pendingLabel}</span>
    </>
  );
}

function credentialStatusLabel(
  status: WorkspaceAgentCredentialSnapshot["status"],
  t: ReturnType<typeof useI18n>["t"],
) {
  return t(`settings.credentials.status.${status}` as TranslationKey);
}

function credentialErrorMessage(
  errorCode: NonNullable<WorkspaceAgentCredentialSnapshot["errorCode"]>,
  t: ReturnType<typeof useI18n>["t"],
) {
  return t(`settings.credentials.error.${errorCode}` as TranslationKey);
}

function clearCredentialInputs(container: HTMLElement | null) {
  for (let input of container?.querySelectorAll<HTMLInputElement>('input[type="password"]') ?? []) {
    input.value = "";
    input.setCustomValidity("");
  }
}

function formDataText(formData: FormData, name: string) {
  let value = formData.get(name);
  return typeof value == "string" ? value : "";
}
