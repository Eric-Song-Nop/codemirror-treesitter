// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { I18nProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/theme";
import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog";

const credentialHook = vi.hoisted(() => ({
  useCredentials: vi.fn(),
}));

vi.mock("@/features/workspace-agent/WorkspaceAgentCredentialsProvider", () => ({
  useWorkspaceAgentCredentials: credentialHook.useCredentials,
}));

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type CredentialState = {
  errorCode: string | null;
  forget: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  hasApiKey: boolean;
  hasStoredKey: boolean;
  lock: ReturnType<typeof vi.fn<() => void>>;
  save: ReturnType<typeof vi.fn<(apiKey: string, passphrase: string) => Promise<boolean>>>;
  status:
    | "checking"
    | "empty"
    | "locked"
    | "unlocked"
    | "saving"
    | "unlocking"
    | "forgetting"
    | "error";
  unlock: ReturnType<typeof vi.fn<(passphrase: string) => Promise<boolean>>>;
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let credentials: CredentialState;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  await i18next.changeLanguage("en");
  credentials = createCredentialState();
  credentialHook.useCredentials.mockReturnValue(credentials);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  credentialHook.useCredentials.mockReset();
  vi.restoreAllMocks();
});

describe("WorkspaceSettingsDialog", () => {
  it("renders the credential, appearance, and language sections with semantic choices", async () => {
    await renderSettings();

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Agent credentials");
    expect(document.body.textContent).toContain("Appearance");
    expect(document.body.textContent).toContain("Language");

    let themes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="settings-theme"]'),
    );
    let languages = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="settings-language"]'),
    );
    expect(themes).toHaveLength(5);
    expect(languages).toHaveLength(2);
    expect(document.querySelector<HTMLInputElement>("#settings-theme-gruvbox-dark")?.checked).toBe(
      true,
    );
    expect(document.querySelector<HTMLInputElement>("#settings-language-en")?.checked).toBe(true);

    let apiKey = requiredInput("#settings-save-api-key");
    let passphrase = requiredInput("#settings-save-passphrase");
    let confirmation = requiredInput("#settings-save-passphrase-confirmation");
    expect(apiKey.maxLength).toBe(512);
    expect(apiKey.autocomplete).toBe("off");
    expect(passphrase.minLength).toBe(12);
    expect(passphrase.maxLength).toBe(256);
    expect(passphrase.autocomplete).toBe("new-password");
    expect(confirmation.autocomplete).toBe("new-password");
  });

  it("changes theme and language through native radio controls", async () => {
    await renderSettings();

    await click(document.querySelector("#settings-theme-github-light"));
    expect(document.querySelector<HTMLInputElement>("#settings-theme-github-light")?.checked).toBe(
      true,
    );

    await click(document.querySelector("#settings-language-zh-CN"));
    await waitFor(() => document.documentElement.lang == "zh-CN");
    expect(document.body.textContent).toContain("Agent 凭据");
    expect(document.querySelector<HTMLInputElement>("#settings-language-zh-CN")?.checked).toBe(
      true,
    );
  });

  it("saves an empty credential without putting secrets in React state or leaving them in the DOM", async () => {
    credentials.save.mockResolvedValue(true);
    await renderSettings();
    let apiKey = requiredInput("#settings-save-api-key");
    let passphrase = requiredInput("#settings-save-passphrase");
    let confirmation = requiredInput("#settings-save-passphrase-confirmation");
    apiKey.value = "sk-settings-secret";
    passphrase.value = "a secure passphrase";
    confirmation.value = "a secure passphrase";

    await submit(apiKey.form);
    await waitFor(() => credentials.save.mock.calls.length == 1 && apiKey.value == "");

    expect(credentials.save).toHaveBeenCalledWith("sk-settings-secret", "a secure passphrase");
    expect(apiKey.value).toBe("");
    expect(passphrase.value).toBe("");
    expect(confirmation.value).toBe("");
    expect(document.body.textContent).not.toContain("sk-settings-secret");
    expect(document.body.textContent).not.toContain("a secure passphrase");
  });

  it("rejects a mismatched confirmation without sending either passphrase to the provider", async () => {
    await renderSettings();
    let apiKey = requiredInput("#settings-save-api-key");
    let passphrase = requiredInput("#settings-save-passphrase");
    let confirmation = requiredInput("#settings-save-passphrase-confirmation");
    apiKey.value = "sk-settings-secret";
    passphrase.value = "a secure passphrase";
    confirmation.value = "a different passphrase";

    await submit(apiKey.form);

    expect(credentials.save).not.toHaveBeenCalled();
    expect(confirmation.validationMessage).toBe("The passphrases do not match.");

    passphrase.value = "a different passphrase";
    await submit(apiKey.form);
    await waitFor(() => credentials.save.mock.calls.length == 1);
    expect(credentials.save).toHaveBeenCalledWith("sk-settings-secret", "a different passphrase");
  });

  it("unlocks a stored credential and clears the passphrase after success", async () => {
    credentials = createCredentialState({ hasStoredKey: true, status: "locked" });
    credentials.unlock.mockResolvedValue(true);
    credentialHook.useCredentials.mockReturnValue(credentials);
    await renderSettings();
    let passphrase = requiredInput("#settings-unlock-passphrase");
    passphrase.value = "a secure passphrase";

    await submit(passphrase.form);
    await waitFor(() => credentials.unlock.mock.calls.length == 1 && passphrase.value == "");

    expect(credentials.unlock).toHaveBeenCalledWith("a secure passphrase");
    expect(passphrase.value).toBe("");
  });

  it("locks, replaces, and confirms deletion of an unlocked credential", async () => {
    credentials = createCredentialState({
      hasApiKey: true,
      hasStoredKey: true,
      status: "unlocked",
    });
    credentials.save.mockResolvedValue(true);
    credentials.forget.mockResolvedValue(true);
    credentialHook.useCredentials.mockReturnValue(credentials);
    await renderSettings();

    await click(buttonNamed("Lock"));
    expect(credentials.lock).toHaveBeenCalledOnce();

    await click(buttonNamed("Replace"));
    let apiKey = requiredInput("#settings-replace-api-key");
    let passphrase = requiredInput("#settings-replace-passphrase");
    let confirmation = requiredInput("#settings-replace-passphrase-confirmation");
    apiKey.value = "sk-replacement-secret";
    passphrase.value = "replacement passphrase";
    confirmation.value = "replacement passphrase";
    await submit(apiKey.form);
    await waitFor(() => credentials.save.mock.calls.length == 1);
    expect(credentials.save).toHaveBeenCalledWith(
      "sk-replacement-secret",
      "replacement passphrase",
    );
    expect(document.querySelector("#settings-credentials-replace")).toBeNull();

    await click(buttonNamed("Delete saved key"));
    let alertDialog = document.querySelector('[role="alertdialog"]');
    if (!alertDialog) throw new Error("Delete confirmation was not found.");
    expect(alertDialog.textContent).toContain("Delete the saved API key?");
    await click(buttonNamed("Delete saved key", alertDialog));
    await waitFor(() => credentials.forget.mock.calls.length == 1);
    expect(credentials.forget).toHaveBeenCalledOnce();
  });

  it("translates provider errors only from their stable error code", async () => {
    credentials = createCredentialState({
      errorCode: "unlock-failed",
      hasStoredKey: true,
      status: "error",
    });
    credentialHook.useCredentials.mockReturnValue(credentials);
    await renderSettings();

    let alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      "The key could not be unlocked. Check the passphrase and try again.",
    );
    expect(document.body.textContent).not.toContain("unlock-failed");
  });

  it("clears every mounted credential field when the page is hidden", async () => {
    await renderSettings();
    let apiKey = requiredInput("#settings-save-api-key");
    let passphrase = requiredInput("#settings-save-passphrase");
    let confirmation = requiredInput("#settings-save-passphrase-confirmation");
    apiKey.value = "sk-pagehide-secret";
    passphrase.value = "a pagehide passphrase";
    confirmation.value = "a pagehide passphrase";

    await act(async () => window.dispatchEvent(new Event("pagehide")));

    expect(apiKey.value).toBe("");
    expect(passphrase.value).toBe("");
    expect(confirmation.value).toBe("");
  });
});

function createCredentialState(overrides: Partial<CredentialState> = {}): CredentialState {
  return {
    errorCode: null,
    forget: vi.fn(async () => true),
    hasApiKey: false,
    hasStoredKey: false,
    lock: vi.fn(),
    save: vi.fn(async () => true),
    status: "empty",
    unlock: vi.fn(async () => true),
    ...overrides,
  };
}

async function renderSettings() {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <I18nProvider>
        <ThemeProvider initialTheme="gruvbox-dark">
          <WorkspaceSettingsDialog open onOpenChange={vi.fn()} />
        </ThemeProvider>
      </I18nProvider>,
    );
  });
}

function requiredInput(selector: string) {
  let input = document.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Input ${selector} was not found.`);
  return input;
}

function buttonNamed(name: string, parent: ParentNode = document) {
  let button = Array.from(parent.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() == name,
  );
  if (!button) throw new Error(`Button ${name} was not found.`);
  return button;
}

async function click(target: Element | null) {
  if (!target) throw new Error("Click target was not found.");
  await act(async () => {
    (target as HTMLElement).click();
  });
}

async function submit(form: HTMLFormElement | null) {
  if (!form) throw new Error("Form was not found.");
  await act(async () => {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempts = 0; attempts < 20; attempts++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for the Settings UI.");
}
