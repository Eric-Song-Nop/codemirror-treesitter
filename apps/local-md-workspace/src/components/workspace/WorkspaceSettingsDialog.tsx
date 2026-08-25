import { CheckIcon, MoonIcon, SunIcon, Trash2Icon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
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
import { useWorkspaceAgentCredentials } from "@/features/workspace-agent/WorkspaceAgentCredentialsProvider";
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
        className="h-[min(50rem,calc(100svh-2rem))] max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-clip p-0 motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none sm:max-w-lg"
      >
        <DialogHeader className="border-b bg-muted/30 px-5 py-4 pr-12">
          <DialogTitle>{t("settings.title")}</DialogTitle>
          <DialogDescription>{t("settings.description")}</DialogDescription>
        </DialogHeader>

        <div
          data-slot="workspace-settings-scroll-region"
          className="grid min-h-0 gap-5 overflow-y-auto overscroll-contain px-5 py-4"
        >
          <CredentialSettings />
          <SettingsGroup
            description={t("settings.appearance.description")}
            title={t("settings.appearance.title")}
          >
            {themeDefinitions.map((definition) => (
              <SettingsChoice
                key={definition.id}
                active={definition.id == theme}
                description={t(
                  definition.appearance == "dark"
                    ? "settings.appearance.dark"
                    : "settings.appearance.light",
                )}
                icon={definition.appearance == "dark" ? <MoonIcon /> : <SunIcon />}
                id={`settings-theme-${definition.id}`}
                label={definition.label}
                name="settings-theme"
                value={definition.id}
                onChange={() => setTheme(definition.id)}
              />
            ))}
          </SettingsGroup>
          <SettingsGroup
            description={t("settings.language.description")}
            title={t("settings.language.title")}
          >
            <SettingsChoice
              active={locale == "en"}
              description={t("settings.language.englishDescription")}
              id="settings-language-en"
              label="English"
              lang="en"
              name="settings-language"
              value="en"
              onChange={() => setLocale("en")}
            />
            <SettingsChoice
              active={locale == "zh-CN"}
              description={t("settings.language.chineseDescription")}
              id="settings-language-zh-CN"
              label="简体中文"
              lang="zh-CN"
              name="settings-language"
              value="zh-CN"
              onChange={() => setLocale("zh-CN")}
            />
          </SettingsGroup>
        </div>

        <DialogFooter className="mx-0 mb-0 rounded-none bg-muted/30 px-5 py-3">
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {t("common.close")}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CredentialSettings() {
  let { t } = useI18n();
  let credentials = useWorkspaceAgentCredentials();
  let [confirmDelete, setConfirmDelete] = useState(false);
  let [replacing, setReplacing] = useState(false);
  let sectionRef = useRef<HTMLElement>(null);
  let { errorCode, hasApiKey, hasStoredKey, status } = credentials;
  let pending = ["checking", "saving", "unlocking", "forgetting"].includes(status);

  useEffect(() => {
    let clear = () => clearCredentialInputs(sectionRef.current);
    globalThis.addEventListener?.("pagehide", clear);
    return () => globalThis.removeEventListener?.("pagehide", clear);
  }, []);

  let forget = async () => {
    clearCredentialInputs(sectionRef.current);
    try {
      await credentials.forget();
    } finally {
      setConfirmDelete(false);
      setReplacing(false);
    }
  };

  return (
    <section ref={sectionRef} aria-labelledby="settings-credentials-title" className="grid gap-3">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h3 id="settings-credentials-title" className="text-sm font-medium">
            {t("settings.credentials.title")}
          </h3>
          <span
            aria-live="polite"
            className={cn(
              "rounded-full bg-muted px-2 py-1 text-xs text-foreground/80",
              status == "unlocked" && "bg-primary/10 text-primary",
              status == "error" && "bg-destructive/10 text-destructive",
            )}
          >
            {t(`settings.credentials.status.${status}` as TranslationKey)}
          </span>
        </div>
        <p className="mt-1 text-xs text-foreground/80">{t("settings.credentials.description")}</p>
      </div>

      <div aria-busy={pending} className="grid gap-3 rounded-lg border bg-muted/20 p-3">
        {errorCode ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {t(`settings.credentials.error.${errorCode}` as TranslationKey)}
          </p>
        ) : null}

        {status == "checking" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" /> {t("settings.credentials.status.checking")}
          </p>
        ) : hasApiKey ? (
          <>
            <CredentialDescription mode="unlocked" />
            <div className="grid gap-2 sm:grid-cols-3">
              <Button
                disabled={pending}
                type="button"
                variant="outline"
                onClick={() => {
                  clearCredentialInputs(sectionRef.current);
                  setReplacing(false);
                  credentials.lock();
                }}
              >
                {t("settings.credentials.actions.lock")}
              </Button>
              <Button
                aria-expanded={replacing}
                disabled={pending}
                type="button"
                variant="outline"
                onClick={() => setReplacing((value) => !value)}
              >
                {t("settings.credentials.actions.replace")}
              </Button>
              <DeleteCredentialButton disabled={pending} onClick={() => setConfirmDelete(true)} />
            </div>
            {replacing ? (
              <div id="settings-credentials-replace" className="grid gap-3 border-t pt-3">
                <CredentialDescription mode="replace" />
                <CredentialForm
                  mode="replace"
                  pending={status == "saving"}
                  submit={credentials.save}
                  onSuccess={() => setReplacing(false)}
                />
              </div>
            ) : null}
          </>
        ) : hasStoredKey ? (
          <>
            <CredentialDescription mode="locked" />
            <CredentialForm
              mode="unlock"
              pending={status == "unlocking"}
              submit={(_apiKey, passphrase) => credentials.unlock(passphrase)}
            />
            <DeleteCredentialButton disabled={pending} onClick={() => setConfirmDelete(true)} />
          </>
        ) : (
          <>
            <CredentialDescription mode="empty" />
            <CredentialForm mode="save" pending={status == "saving"} submit={credentials.save} />
          </>
        )}
      </div>

      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => status != "forgetting" && setConfirmDelete(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.credentials.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.credentials.delete.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={status == "forgetting"}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={status == "forgetting"}
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                void forget();
              }}
            >
              {status == "forgetting" ? <Spinner aria-hidden="true" /> : <Trash2Icon />}
              {status == "forgetting"
                ? t("settings.credentials.status.forgetting")
                : t("settings.credentials.actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function CredentialDescription({ mode }: { mode: "empty" | "locked" | "replace" | "unlocked" }) {
  let { t } = useI18n();
  return (
    <div>
      <h4 className="text-sm font-medium">
        {t(`settings.credentials.${mode}.title` as TranslationKey)}
      </h4>
      <p className="mt-1 text-xs text-foreground/80">
        {t(`settings.credentials.${mode}.description` as TranslationKey)}
      </p>
    </div>
  );
}

type CredentialFormMode = "replace" | "save" | "unlock";

function CredentialForm({
  mode,
  pending,
  submit,
  onSuccess,
}: {
  mode: CredentialFormMode;
  pending: boolean;
  submit: (apiKey: string, passphrase: string) => Promise<boolean>;
  onSuccess?: () => void;
}) {
  let { t } = useI18n();
  let unlock = mode == "unlock";
  let prefix = unlock
    ? "settings-unlock"
    : mode == "replace"
      ? "settings-replace"
      : "settings-save";

  let handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let form = event.currentTarget;
    if (!form.reportValidity()) return;
    let data = new FormData(form);
    let apiKey = formDataText(data, "deepseek-api-key");
    let passphrase = formDataText(data, "credential-passphrase");
    if (!unlock) {
      let confirmation = form.elements.namedItem("credential-passphrase-confirmation");
      if (!(confirmation instanceof HTMLInputElement)) return;
      confirmation.setCustomValidity("");
      if (passphrase != formDataText(data, "credential-passphrase-confirmation")) {
        confirmation.setCustomValidity(t("settings.credentials.passphrase.mismatch"));
        confirmation.reportValidity();
        return;
      }
    }
    form.reset();
    if (await submit(apiKey, passphrase)) onSuccess?.();
  };

  return (
    <form className="grid gap-3" onSubmit={(event) => void handleSubmit(event)}>
      {unlock ? null : (
        <SecretInput
          autoComplete="off"
          description={t("settings.credentials.apiKey.description")}
          id={`${prefix}-api-key`}
          label={t("settings.credentials.apiKey.label")}
          maxLength={512}
          name="deepseek-api-key"
          placeholder={t("settings.credentials.apiKey.placeholder")}
        />
      )}
      <SecretInput
        autoComplete={unlock ? "current-password" : "new-password"}
        description={t(
          unlock
            ? "settings.credentials.passphrase.unlockDescription"
            : "settings.credentials.passphrase.description",
        )}
        id={`${prefix}-passphrase`}
        label={t("settings.credentials.passphrase.label")}
        maxLength={256}
        minLength={12}
        name="credential-passphrase"
        placeholder={t(
          unlock
            ? "settings.credentials.passphrase.unlockPlaceholder"
            : "settings.credentials.passphrase.createPlaceholder",
        )}
      />
      {unlock ? null : (
        <SecretInput
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
      )}
      <Button disabled={pending} type="submit" className="justify-self-end">
        {pending ? <Spinner aria-hidden="true" /> : null}
        {t(
          (pending
            ? `settings.credentials.status.${unlock ? "unlocking" : "saving"}`
            : `settings.credentials.actions.${unlock ? "unlock" : mode == "replace" ? "saveReplacement" : "save"}`) as TranslationKey,
        )}
      </Button>
    </form>
  );
}

function SecretInput({
  description,
  id,
  label,
  ...input
}: Omit<ComponentProps<typeof Input>, "id" | "type"> & {
  description: string;
  id: string;
  label: string;
}) {
  let descriptionId = `${id}-description`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        {...input}
        aria-describedby={descriptionId}
        autoCapitalize="none"
        autoCorrect="off"
        id={id}
        required
        spellCheck={false}
        type="password"
      />
      <p id={descriptionId} className="text-xs text-foreground/80">
        {description}
      </p>
    </div>
  );
}

function DeleteCredentialButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  let { t } = useI18n();
  return (
    <Button disabled={disabled} type="button" variant="destructive" onClick={onClick}>
      <Trash2Icon aria-hidden="true" /> {t("settings.credentials.actions.delete")}
    </Button>
  );
}

function SettingsGroup({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <fieldset className="grid gap-2 border-t pt-5">
      <legend className="text-sm font-medium">{title}</legend>
      <p className="text-xs text-foreground/80">{description}</p>
      {children}
    </fieldset>
  );
}

function SettingsChoice({
  active,
  description,
  icon,
  id,
  label,
  lang,
  name,
  value,
  onChange,
}: {
  active: boolean;
  description: string;
  icon?: ReactNode;
  id: string;
  label: string;
  lang?: string;
  name: string;
  value: string;
  onChange: () => void;
}) {
  return (
    <Label
      className={cn(
        "relative flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-[border-color,background-color,box-shadow] has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
        active && "border-primary/40 bg-primary/5",
      )}
      htmlFor={id}
    >
      <input
        checked={active}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
        id={id}
        name={name}
        type="radio"
        value={value}
        onChange={onChange}
      />
      {icon ? <span className="[&>svg]:size-4">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium" lang={lang}>
          {label}
        </span>
        <span className="block text-xs text-foreground/80">{description}</span>
      </span>
      {active ? <CheckIcon aria-hidden="true" className="size-4 text-primary" /> : null}
    </Label>
  );
}

function clearCredentialInputs(container: HTMLElement | null) {
  for (let input of container?.querySelectorAll<HTMLInputElement>('input[type="password"]') ?? []) {
    input.value = "";
    input.setCustomValidity("");
  }
}

function formDataText(data: FormData, name: string) {
  let value = data.get(name);
  return typeof value == "string" ? value : "";
}
