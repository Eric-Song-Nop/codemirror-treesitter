import { describe, expect, it, vi } from "vite-plus/test";
import {
  WorkspaceAgentCredentialVaultError,
  type WorkspaceAgentCredentialVault,
} from "@/lib/agent/application/credential-vault";
import { WorkspaceAgentCredentialManager } from "./workspace-agent-credential-manager";

const apiKey = "sk-manager-secret";
const passphrase = "correct horse battery staple";

describe("WorkspaceAgentCredentialManager", () => {
  it("publishes only opaque revisions and locks on another context's revision", async () => {
    let memory = createMemoryVault();
    let channel = createChannel();
    let manager = new WorkspaceAgentCredentialManager(memory.vault, {
      createBroadcastChannel: () => channel,
      createRevision: () => "opaque-revision",
    });
    manager.start();
    await manager.initialize();

    expect(await manager.save(apiKey, passphrase)).toBe(true);
    expect(channel.postMessage).toHaveBeenCalledWith("opaque-revision");
    expect(JSON.stringify(channel.postMessage.mock.calls)).not.toContain(apiKey);

    channel.onmessage?.call(
      channel as unknown as BroadcastChannel,
      new MessageEvent("message", { data: "external-revision" }),
    );

    expect(manager.getApiKey()).toBeNull();
    await waitUntil(() => manager.getSnapshot().status == "locked");
    expect(manager.getSnapshot()).toMatchObject({ hasApiKey: false, hasStoredKey: true });
  });

  it("lets an explicit lock win over a stale unlock", async () => {
    let memory = createMemoryVault({ apiKey, passphrase });
    let deferred = createDeferred<string>();
    memory.vault.unlock = vi.fn(() => deferred.promise);
    let manager = new WorkspaceAgentCredentialManager(memory.vault);
    await manager.initialize();

    let unlocking = manager.unlock(passphrase);
    await waitUntil(() => manager.getSnapshot().status == "unlocking");
    manager.lock();
    deferred.resolve(apiKey);

    expect(await unlocking).toBe(false);
    expect(manager.getApiKey()).toBeNull();
    expect(manager.getSnapshot().status).toBe("locked");
  });

  it("fails closed when replacing an unlocked credential fails", async () => {
    let memory = createMemoryVault({ apiKey, passphrase });
    let manager = new WorkspaceAgentCredentialManager(memory.vault);
    await manager.initialize();
    expect(await manager.unlock(passphrase)).toBe(true);
    memory.vault.save = vi.fn(async () => {
      throw new WorkspaceAgentCredentialVaultError("storage-unavailable");
    });

    expect(await manager.save("sk-replacement", passphrase)).toBe(false);
    expect(manager.getApiKey()).toBeNull();
    expect(manager.getSnapshot()).toMatchObject({
      errorCode: "storage-unavailable",
      hasApiKey: false,
      hasStoredKey: true,
      status: "error",
    });
  });
});

function createMemoryVault(initial?: { apiKey: string; passphrase: string }) {
  let stored = initial ?? null;
  let vault: WorkspaceAgentCredentialVault = {
    delete: vi.fn(async () => {
      stored = null;
    }),
    probe: vi.fn(async () =>
      stored ? ({ status: "locked" } as const) : ({ status: "empty" } as const),
    ),
    save: vi.fn(async (nextApiKey, nextPassphrase) => {
      stored = { apiKey: nextApiKey.trim(), passphrase: nextPassphrase };
    }),
    unlock: vi.fn(async (nextPassphrase) => {
      if (!stored) throw new WorkspaceAgentCredentialVaultError("credential-not-found");
      if (stored.passphrase != nextPassphrase) {
        throw new WorkspaceAgentCredentialVaultError("unlock-failed");
      }
      return stored.apiKey;
    }),
  };
  return { vault };
}

function createChannel() {
  return {
    close: vi.fn(),
    onmessage: null as BroadcastChannel["onmessage"],
    postMessage: vi.fn<(message: unknown) => void>(),
  };
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for a credential state.");
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
