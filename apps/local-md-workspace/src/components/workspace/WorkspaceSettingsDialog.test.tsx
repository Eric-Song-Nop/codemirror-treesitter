// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceAgentCredentialSnapshot } from "@/features/workspace-agent/WorkspaceAgentCredentialsProvider";
import { I18nProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/theme";
import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog";

const credentialHook = vi.hoisted(() => ({
  useCredentials: vi.fn(),
}));

vi.mock("@/features/workspace-agent/WorkspaceAgentCredentialsProvider", () => ({
  useWorkspaceAgentCredentials: credentialHook.useCredentials,
}));

type CredentialState = WorkspaceAgentCredentialSnapshot & {
  forget: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  lock: ReturnType<typeof vi.fn<() => void>>;
  save: ReturnType<typeof vi.fn<(apiKey: string, passphrase: string) => Promise<boolean>>>;
  unlock: ReturnType<typeof vi.fn<(passphrase: string) => Promise<boolean>>>;
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let credentials: CredentialState;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  await i18next.changeLanguage("en");
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

    expect(document.querySelectorAll('input[name="settings-theme"]')).toHaveLength(5);
    expect(document.querySelectorAll('input[name="settings-language"]')).toHaveLength(2);
    expect(document.querySelector<HTMLInputElement>("#settings-theme-gruvbox-dark")?.checked).toBe(
      true,
    );
    expect(document.querySelector<HTMLInputElement>("#settings-language-en")?.checked).toBe(true);

    let { apiKey, passphrase, confirmation } = credentialFields("save");
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
    await renderSettings();
    let fields = credentialFields("save", "sk-settings-secret", "a secure passphrase");

    await submit(fields.apiKey.form);
    await waitFor(() => credentials.save.mock.calls.length == 1 && fields.apiKey.value == "");

    expect(credentials.save).toHaveBeenCalledWith("sk-settings-secret", "a secure passphrase");
    expectFieldsCleared(fields);
    expect(document.body.textContent).not.toContain("sk-settings-secret");
    expect(document.body.textContent).not.toContain("a secure passphrase");
  });

  it("rejects a mismatched confirmation without sending either passphrase to the provider", async () => {
    await renderSettings();
    let { apiKey, passphrase, confirmation } = credentialFields(
      "save",
      "sk-settings-secret",
      "a secure passphrase",
      "a different passphrase",
    );

    await submit(apiKey.form);

    expect(credentials.save).not.toHaveBeenCalled();
    expect(confirmation.validationMessage).toBe("The passphrases do not match.");

    passphrase.value = "a different passphrase";
    await submit(apiKey.form);
    await waitFor(() => credentials.save.mock.calls.length == 1);
    expect(credentials.save).toHaveBeenCalledWith("sk-settings-secret", "a different passphrase");
  });

  it("unlocks a stored credential and clears the passphrase after success", async () => {
    await renderSettings({ hasStoredKey: true, status: "locked" });
    let passphrase = requiredInput("#settings-unlock-passphrase");
    passphrase.value = "a secure passphrase";

    await submit(passphrase.form);
    await waitFor(() => credentials.unlock.mock.calls.length == 1 && passphrase.value == "");

    expect(credentials.unlock).toHaveBeenCalledWith("a secure passphrase");
    expect(passphrase.value).toBe("");
  });

  it("locks, replaces, and confirms deletion of an unlocked credential", async () => {
    await renderSettings({
      hasApiKey: true,
      hasStoredKey: true,
      status: "unlocked",
    });

    await click(buttonNamed("Lock"));
    expect(credentials.lock).toHaveBeenCalledOnce();

    await click(buttonNamed("Replace"));
    let fields = credentialFields("replace", "sk-replacement-secret", "replacement passphrase");
    await submit(fields.apiKey.form);
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
    await renderSettings({
      errorCode: "unlock-failed",
      hasStoredKey: true,
      status: "error",
    });

    let alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      "The key could not be unlocked. Check the passphrase and try again.",
    );
    expect(document.body.textContent).not.toContain("unlock-failed");
  });

  it("clears every mounted credential field when the page is hidden", async () => {
    await renderSettings();
    let fields = credentialFields("save", "sk-pagehide-secret", "a pagehide passphrase");

    await act(async () => window.dispatchEvent(new Event("pagehide")));

    expectFieldsCleared(fields);
  });
});

function mockCredentials(overrides: Partial<CredentialState> = {}) {
  credentials = {
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
  credentialHook.useCredentials.mockReturnValue(credentials);
}

async function renderSettings(overrides: Partial<CredentialState> = {}) {
  mockCredentials(overrides);
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

function credentialFields(
  action: "save" | "replace",
  apiKeyValue = "",
  passphraseValue = "",
  confirmationValue = passphraseValue,
) {
  let fields = {
    apiKey: requiredInput(`#settings-${action}-api-key`),
    passphrase: requiredInput(`#settings-${action}-passphrase`),
    confirmation: requiredInput(`#settings-${action}-passphrase-confirmation`),
  };
  fields.apiKey.value = apiKeyValue;
  fields.passphrase.value = passphraseValue;
  fields.confirmation.value = confirmationValue;
  return fields;
}

function expectFieldsCleared(fields: ReturnType<typeof credentialFields>) {
  for (let field of Object.values(fields)) expect(field.value).toBe("");
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
