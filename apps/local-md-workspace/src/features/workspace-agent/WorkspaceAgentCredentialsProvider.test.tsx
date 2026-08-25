// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceAgentCredentialVault } from "@/lib/agent/application/credential-vault";
import {
  useWorkspaceAgentCredentials,
  WorkspaceAgentCredentialsProvider,
} from "./WorkspaceAgentCredentialsProvider";
import { WorkspaceAgentCredentialManager } from "./workspace-agent-credential-manager";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let container: HTMLDivElement | null = null;
let currentCredentials: ReturnType<typeof useWorkspaceAgentCredentials> | null = null;
let root: Root | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  currentCredentials = null;
  vi.restoreAllMocks();
});

describe("WorkspaceAgentCredentialsProvider", () => {
  it("initializes an injected manager and locks secrets on pagehide and unmount", async () => {
    let secret = "sk-provider-secret";
    let passphrase = "correct horse battery staple";
    let probe = vi.fn(async () => ({ status: "locked" }) as const);
    let vault: WorkspaceAgentCredentialVault = {
      delete: vi.fn(async () => {}),
      probe,
      save: vi.fn(async () => {}),
      unlock: vi.fn(async () => secret),
    };
    let manager = new WorkspaceAgentCredentialManager(vault, {
      createBroadcastChannel: () => null,
    });
    let revisionStorage = createMemoryStorage();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: revisionStorage,
    });
    let start = vi.spyOn(manager, "start");

    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <StrictMode>
          <WorkspaceAgentCredentialsProvider manager={manager}>
            <CredentialConsumer />
          </WorkspaceAgentCredentialsProvider>
        </StrictMode>,
      );
    });
    await waitUntil(() => currentCredentials?.status == "locked");

    expect(start).toHaveBeenCalled();
    expect(probe).toHaveBeenCalled();
    expect(currentCredentials).toMatchObject({
      errorCode: null,
      hasApiKey: false,
      hasStoredKey: true,
      status: "locked",
    });
    expect(currentCredentials).toEqual(
      expect.objectContaining({
        forget: expect.any(Function),
        getApiKey: expect.any(Function),
        lock: expect.any(Function),
        save: expect.any(Function),
        subscribe: expect.any(Function),
        unlock: expect.any(Function),
      }),
    );

    await act(async () => {
      expect(await currentCredentials!.unlock(passphrase)).toBe(true);
    });
    expect(currentCredentials?.hasApiKey).toBe(true);
    expect(currentCredentials?.getApiKey()).toBe(secret);
    expect(Object.hasOwn(currentCredentials!, "apiKey")).toBe(false);
    expect(JSON.stringify(currentCredentials)).not.toContain(secret);
    expect(JSON.stringify(currentCredentials)).not.toContain(passphrase);
    expect(document.body.textContent).not.toContain(secret);

    await act(async () => {
      expect(await currentCredentials!.save(secret, passphrase)).toBe(true);
    });
    let revision = revisionStorage.getItem("grove-agent-credentials:revision");
    expect(revision).toEqual(expect.any(String));
    expect(revision).not.toContain(secret);
    expect(revision).not.toContain(passphrase);

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "grove-agent-credentials:revision",
          newValue: "external-safe-revision",
        }),
      );
      await Promise.resolve();
    });
    await waitUntil(() => currentCredentials?.status == "locked");
    expect(currentCredentials?.getApiKey()).toBeNull();

    await act(async () => {
      expect(await currentCredentials!.unlock(passphrase)).toBe(true);
    });
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await Promise.resolve();
    });
    await waitUntil(() => currentCredentials?.status == "locked");
    expect(currentCredentials?.hasApiKey).toBe(false);
    expect(currentCredentials?.getApiKey()).toBeNull();

    await act(async () => {
      expect(await currentCredentials!.unlock(passphrase)).toBe(true);
    });
    expect(manager.getApiKey()).toBe(secret);

    await act(async () => {
      root?.unmount();
      root = null;
      await Promise.resolve();
    });
    await waitUntil(() => manager.getSnapshot().status == "locked");
    expect(manager.getApiKey()).toBeNull();
    expect(manager.getSnapshot().hasApiKey).toBe(false);
  });
});

function CredentialConsumer() {
  currentCredentials = useWorkspaceAgentCredentials();
  return null;
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error("Timed out waiting for a credential-provider snapshot.");
}

function createMemoryStorage() {
  let values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  } as Storage;
}
