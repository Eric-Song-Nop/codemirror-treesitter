// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceAgentCredentialSnapshot } from "@/features/workspace-agent/WorkspaceAgentCredentialsProvider";
import { I18nProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/theme";
import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog";

const credentialHook = vi.hoisted(() => ({ useCredentials: vi.fn() }));

vi.mock("@/features/workspace-agent/WorkspaceAgentCredentialsProvider", () => ({
  useWorkspaceAgentCredentials: credentialHook.useCredentials,
}));

type Credentials = WorkspaceAgentCredentialSnapshot & {
  forget: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  lock: ReturnType<typeof vi.fn<() => void>>;
  save: ReturnType<typeof vi.fn<(key: string, passphrase: string) => Promise<boolean>>>;
  unlock: ReturnType<typeof vi.fn<(passphrase: string) => Promise<boolean>>>;
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  credentialHook.useCredentials.mockReset();
});

describe("WorkspaceSettingsDialog", () => {
  it("keeps the body scrollable and exposes accessible secondary controls", async () => {
    await i18next.changeLanguage("en");
    await renderSettings();

    let dialog = document.querySelector<HTMLElement>("#workspace-settings-dialog");
    let scrollRegion = dialog?.querySelector<HTMLElement>(
      '[data-slot="workspace-settings-scroll-region"]',
    );
    expect(dialog?.classList).toContain("h-[min(50rem,calc(100svh-2rem))]");
    expect(dialog?.classList).toContain("max-h-[calc(100svh-2rem)]");
    expect(dialog?.classList).toContain("grid-rows-[auto_minmax(0,1fr)_auto]");
    expect(dialog?.classList).toContain("overflow-clip");
    expect(scrollRegion?.classList).toContain("min-h-0");
    expect(scrollRegion?.classList).toContain("overflow-y-auto");
    expect(scrollRegion?.classList).toContain("overscroll-contain");

    let secondaryText = dialog?.querySelectorAll<HTMLElement>(".text-xs") ?? [];
    expect(secondaryText.length).toBeGreaterThan(0);
    for (let element of secondaryText) {
      expect(element.classList).toContain("text-foreground/80");
      expect(element.classList).not.toContain("text-muted-foreground");
    }

    for (let choice of dialog?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []) {
      let label = choice.closest("label");
      expect(choice.classList).toContain("inset-0");
      expect(choice.classList).toContain("size-full");
      expect(choice.classList).toContain("opacity-0");
      expect(label?.classList).toContain("has-[:focus-visible]:ring-3");
      expect(label?.classList).toContain("has-[:focus-visible]:ring-ring/50");
    }
  });

  it("keeps save, unlock, and delete secrets outside rendered state", async () => {
    await i18next.changeLanguage("en");
    let empty = await renderSettings();
    let saveFields = fill("sk-settings-secret", "a secure passphrase");

    await submit(saveFields.apiKey.form);

    expect(empty.save).toHaveBeenCalledWith("sk-settings-secret", "a secure passphrase");
    expect(Object.values(saveFields).every((field) => field.value == "")).toBe(true);
    expect(document.body.textContent).not.toContain("sk-settings-secret");

    let locked = await renderSettings({ hasStoredKey: true, status: "locked" });
    let unlockInput = input("#settings-unlock-passphrase");
    unlockInput.value = "discard on hide";
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(unlockInput.value).toBe("");

    unlockInput.value = "a secure passphrase";
    await submit(unlockInput.form);
    expect(locked.unlock).toHaveBeenCalledWith("a secure passphrase");
    expect(unlockInput.value).toBe("");

    let unlocked = await renderSettings({
      hasApiKey: true,
      hasStoredKey: true,
      status: "unlocked",
    });
    await click(button("Delete saved key"));
    let confirmation = document.querySelector('[role="alertdialog"]');
    await click(button("Delete saved key", confirmation ?? document));
    expect(unlocked.forget).toHaveBeenCalledOnce();
  });
});

async function renderSettings(overrides: Partial<Credentials> = {}) {
  let credentials: Credentials = {
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
  container ??= document.body.appendChild(document.createElement("div"));
  let settingsRoot = (root ??= createRoot(container));
  await act(async () => {
    settingsRoot.render(
      <I18nProvider>
        <ThemeProvider initialTheme="gruvbox-dark">
          <WorkspaceSettingsDialog open onOpenChange={vi.fn()} />
        </ThemeProvider>
      </I18nProvider>,
    );
  });
  return credentials;
}

function input(selector: string) {
  let field = document.querySelector<HTMLInputElement>(selector);
  if (!field) throw new Error(`Input ${selector} was not found.`);
  return field;
}

function fill(key: string, passphrase: string) {
  let fields = {
    apiKey: input("#settings-save-api-key"),
    passphrase: input("#settings-save-passphrase"),
    confirmation: input("#settings-save-passphrase-confirmation"),
  };
  fields.apiKey.value = key;
  fields.passphrase.value = passphrase;
  fields.confirmation.value = passphrase;
  return fields;
}

function button(label: string, parent: ParentNode = document) {
  let target = Array.from(parent.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() == label,
  );
  if (!target) throw new Error(`Button ${label} was not found.`);
  return target;
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
}

async function submit(form: HTMLFormElement | null) {
  if (!form) throw new Error("Credential form was not found.");
  await act(async () => {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}
