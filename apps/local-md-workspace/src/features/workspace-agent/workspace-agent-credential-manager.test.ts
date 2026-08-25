import { describe, expect, it, vi } from "vite-plus/test";
import {
  WorkspaceAgentCredentialVaultError,
  type WorkspaceAgentCredentialVault,
} from "@/lib/agent/application/credential-vault";
import { WorkspaceAgentCredentialManager } from "./workspace-agent-credential-manager";

const apiKey = "sk-manager-secret";
const replacementApiKey = "sk-manager-replacement";
const passphrase = "correct horse battery staple";

describe("WorkspaceAgentCredentialManager", () => {
  it("initializes to a locked, secret-free snapshot and owns its broadcast lifecycle", async () => {
    let memory = createMemoryVault({ apiKey, passphrase });
    let channel = createTestBroadcastChannel();
    let createBroadcastChannel = vi.fn(() => channel);
    let manager = new WorkspaceAgentCredentialManager(memory.vault, { createBroadcastChannel });
    let listener = vi.fn();
    let unsubscribe = manager.subscribe(listener);

    expect(manager.getSnapshot()).toEqual({
      errorCode: null,
      hasApiKey: false,
      hasStoredKey: false,
      revision: 0,
      status: "checking",
    });

    let stopFirstConsumer = manager.start();
    let stopSecondConsumer = manager.start();
    await manager.initialize();

    expect(createBroadcastChannel).toHaveBeenCalledOnce();
    expect(createBroadcastChannel).toHaveBeenCalledWith("grove-agent-credentials");
    expect(memory.probe).toHaveBeenCalledOnce();
    expect(manager.getApiKey()).toBeNull();
    expect(manager.getSnapshot()).toMatchObject({
      errorCode: null,
      hasApiKey: false,
      hasStoredKey: true,
      status: "locked",
    });
    expect(JSON.stringify(manager.getSnapshot())).not.toContain(apiKey);
    expect(listener).toHaveBeenCalledOnce();

    stopFirstConsumer();
    expect(channel.close).not.toHaveBeenCalled();
    stopSecondConsumer();
    expect(channel.close).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("saves, locks, unlocks, and forgets without publishing credential material", async () => {
    let memory = createMemoryVault();
    let channel = createTestBroadcastChannel();
    let manager = new WorkspaceAgentCredentialManager(memory.vault, {
      createBroadcastChannel: () => channel,
    });
    manager.start();
    await manager.initialize();

    await expect(manager.save(`  ${apiKey}  `, passphrase)).resolves.toBe(true);
    expect(memory.save).toHaveBeenCalledWith(`  ${apiKey}  `, passphrase);
    expect(manager.getApiKey()).toBe(apiKey);
    expect(manager.getSnapshot()).toMatchObject({
      errorCode: null,
      hasApiKey: true,
      hasStoredKey: true,
      status: "unlocked",
    });
    expect(JSON.stringify(manager)).not.toContain(apiKey);
    expect(JSON.stringify(manager)).not.toContain(passphrase);

    manager.lock();
    expect(manager.getApiKey()).toBeNull();
    expect(manager.getSnapshot()).toMatchObject({
      errorCode: null,
      hasApiKey: false,
      hasStoredKey: true,
      status: "locked",
    });

    await expect(manager.unlock(passphrase)).resolves.toBe(true);
    expect(manager.getApiKey()).toBe(apiKey);
    expect(manager.getSnapshot()).toMatchObject({
      errorCode: null,
      hasApiKey: true,
      hasStoredKey: true,
      status: "unlocked",
    });

    let forgetting = manager.forget();
    expect(manager.getApiKey()).toBeNull();
    expect(manager.getSnapshot()).toMatchObject({
      errorCode: null,
      hasApiKey: false,
      status: "forgetting",
    });
    await expect(forgetting).resolves.toBe(true);
    expect(manager.getSnapshot()).toMatchObject({
      errorCode: null,
      hasApiKey: false,
      hasStoredKey: false,
      status: "empty",
    });

    expect(channel.postMessage).toHaveBeenCalledTimes(2);
    for (let [message] of channel.postMessage.mock.calls) {
      expect(message).toEqual({
        revision: expect.any(String),
        type: "credential-changed",
      });
      expect(JSON.stringify(message)).not.toContain(apiKey);
      expect(JSON.stringify(message)).not.toContain(passphrase);
    }
    expect(JSON.stringify(manager.getSnapshot())).not.toContain(apiKey);
    expect(JSON.stringify(manager.getSnapshot())).not.toContain(passphrase);
  });

  it("lets lock win over a stale successful or failed unlock", async () => {
    let successfulUnlock = createDeferred<string>();
    let successfulVault = createMemoryVault({ apiKey, passphrase });
    successfulVault.vault.unlock = vi.fn(() => successfulUnlock.promise);
    let successfulManager = new WorkspaceAgentCredentialManager(successfulVault.vault);
    await successfulManager.initialize();

    let staleSuccess = successfulManager.unlock(passphrase);
    await waitForSnapshot(successfulManager, (snapshot) => snapshot.status == "unlocking");
    successfulManager.lock();
    successfulUnlock.resolve(apiKey);

    await expect(staleSuccess).resolves.toBe(false);
    expect(successfulManager.getApiKey()).toBeNull();
    expect(successfulManager.getSnapshot()).toMatchObject({
      errorCode: null,
      hasApiKey: false,
      hasStoredKey: true,
      status: "locked",
    });

    let failedUnlock = createDeferred<string>();
    let failedVault = createMemoryVault({ apiKey, passphrase });
    failedVault.vault.unlock = vi.fn(() => failedUnlock.promise);
    let failedManager = new WorkspaceAgentCredentialManager(failedVault.vault);
    await failedManager.initialize();

    let staleFailure = failedManager.unlock("wrong passphrase");
    await waitForSnapshot(failedManager, (snapshot) => snapshot.status == "unlocking");
    failedManager.lock();
    failedUnlock.reject(new WorkspaceAgentCredentialVaultError("unlock-failed"));

    await expect(staleFailure).resolves.toBe(false);
    expect(failedManager.getApiKey()).toBeNull();
    expect(failedManager.getSnapshot()).toMatchObject({
      errorCode: null,
      hasApiKey: false,
      hasStoredKey: true,
      status: "locked",
    });
  });

  it("lets forget invalidate an in-flight save and leaves no usable credential", async () => {
    let save = createDeferred<void>();
    let memory = createMemoryVault();
    memory.vault.save = vi.fn(async (nextApiKey, nextPassphrase) => {
      await save.promise;
      memory.seed(nextApiKey.trim(), nextPassphrase);
    });
    let manager = new WorkspaceAgentCredentialManager(memory.vault);
    await manager.initialize();

    let staleSave = manager.save(apiKey, passphrase);
    await waitForSnapshot(manager, (snapshot) => snapshot.status == "saving");
    let forgetting = manager.forget();
    expect(manager.getApiKey()).toBeNull();
    save.resolve();

    await expect(staleSave).resolves.toBe(false);
    await expect(forgetting).resolves.toBe(true);
    expect(memory.deleteCredential).toHaveBeenCalledOnce();
    expect(manager.getApiKey()).toBeNull();
    expect(manager.getSnapshot()).toMatchObject({
      errorCode: null,
      hasApiKey: false,
      hasStoredKey: false,
      status: "empty",
    });
  });

  it("invalidates an unlocked key on another context's safe broadcast", async () => {
    let memory = createMemoryVault();
    let firstChannel = createTestBroadcastChannel();
    let secondChannel = createTestBroadcastChannel();
    let first = new WorkspaceAgentCredentialManager(memory.vault, {
      createBroadcastChannel: () => firstChannel,
    });
    let second = new WorkspaceAgentCredentialManager(memory.vault, {
      createBroadcastChannel: () => secondChannel,
    });
    first.start();
    second.start();
    await Promise.all([first.initialize(), second.initialize()]);

    await expect(first.save(apiKey, passphrase)).resolves.toBe(true);
    let savedMessage = firstChannel.postMessage.mock.calls[0]?.[0];
    expect(JSON.stringify(savedMessage)).not.toContain(apiKey);
    expect(JSON.stringify(savedMessage)).not.toContain(passphrase);
    dispatchBroadcast(secondChannel, savedMessage);
    await waitForSnapshot(second, (snapshot) => snapshot.status == "locked");
    expect(second.getApiKey()).toBeNull();
    expect(second.getSnapshot().hasStoredKey).toBe(true);

    await expect(second.unlock(passphrase)).resolves.toBe(true);
    expect(second.getApiKey()).toBe(apiKey);

    await expect(first.save(replacementApiKey, passphrase)).resolves.toBe(true);
    let replacementMessage = firstChannel.postMessage.mock.calls.at(-1)?.[0];
    dispatchBroadcast(secondChannel, replacementMessage);
    expect(second.getApiKey()).toBeNull();
    expect(second.getSnapshot().status).toBe("checking");
    await waitForSnapshot(second, (snapshot) => snapshot.status == "locked");

    expect(JSON.stringify(firstChannel.postMessage.mock.calls)).not.toContain(apiKey);
    expect(JSON.stringify(firstChannel.postMessage.mock.calls)).not.toContain(replacementApiKey);
    expect(JSON.stringify(firstChannel.postMessage.mock.calls)).not.toContain(passphrase);
    expect(JSON.stringify(second.getSnapshot())).not.toContain(apiKey);
    expect(JSON.stringify(second.getSnapshot())).not.toContain(replacementApiKey);
  });

  it("maps initialization failures to stable error codes without retaining details", async () => {
    let vault = createMemoryVault().vault;
    vault.probe = vi.fn(async () => {
      throw new WorkspaceAgentCredentialVaultError("invalid-record");
    });
    let manager = new WorkspaceAgentCredentialManager(vault);

    await manager.initialize();

    expect(manager.getApiKey()).toBeNull();
    expect(manager.getSnapshot()).toMatchObject({
      errorCode: "invalid-record",
      hasApiKey: false,
      hasStoredKey: true,
      status: "error",
    });
  });

  it("continues credential revocation when an earlier observer throws", async () => {
    let memory = createMemoryVault({ apiKey, passphrase });
    let manager = new WorkspaceAgentCredentialManager(memory.vault);
    await manager.initialize();
    await expect(manager.unlock(passphrase)).resolves.toBe(true);
    manager.subscribe(() => {
      throw new Error("broken observer");
    });
    let revocationObserver = vi.fn();
    manager.subscribe(revocationObserver);

    expect(() => manager.lock()).not.toThrow();

    expect(manager.getApiKey()).toBeNull();
    expect(revocationObserver).toHaveBeenCalled();
  });

  it("keeps a completed save usable when BroadcastChannel notification throws", async () => {
    let memory = createMemoryVault();
    let channel = createTestBroadcastChannel();
    channel.postMessage.mockImplementation(() => {
      throw new Error("broken channel");
    });
    let manager = new WorkspaceAgentCredentialManager(memory.vault, {
      createBroadcastChannel: () => channel,
    });
    manager.start();
    await manager.initialize();

    await expect(manager.save(apiKey, passphrase)).resolves.toBe(true);

    expect(manager.getApiKey()).toBe(apiKey);
    expect(manager.getSnapshot()).toMatchObject({
      errorCode: null,
      hasApiKey: true,
      hasStoredKey: true,
      status: "unlocked",
    });
  });
});

function createMemoryVault(initial?: { apiKey: string; passphrase: string }) {
  let stored = initial ?? null;
  let deleteCredential = vi.fn(async () => {
    stored = null;
  });
  let probe = vi.fn(async () =>
    stored ? ({ status: "locked" } as const) : ({ status: "empty" } as const),
  );
  let save = vi.fn(async (nextApiKey: string, nextPassphrase: string) => {
    stored = { apiKey: nextApiKey.trim(), passphrase: nextPassphrase };
  });
  let unlock = vi.fn(async (nextPassphrase: string) => {
    if (!stored) throw new WorkspaceAgentCredentialVaultError("credential-not-found");
    if (stored.passphrase != nextPassphrase) {
      throw new WorkspaceAgentCredentialVaultError("unlock-failed");
    }
    return stored.apiKey;
  });
  let vault: WorkspaceAgentCredentialVault = {
    delete: deleteCredential,
    probe,
    save,
    unlock,
  };
  return {
    deleteCredential,
    probe,
    save,
    seed(nextApiKey: string, nextPassphrase: string) {
      stored = { apiKey: nextApiKey, passphrase: nextPassphrase };
    },
    unlock,
    vault,
  };
}

function createTestBroadcastChannel() {
  return {
    close: vi.fn(),
    onmessage: null as BroadcastChannel["onmessage"],
    postMessage: vi.fn<(message: unknown) => void>(),
  };
}

function dispatchBroadcast(channel: ReturnType<typeof createTestBroadcastChannel>, data: unknown) {
  channel.onmessage?.call(
    channel as unknown as BroadcastChannel,
    new MessageEvent("message", { data }),
  );
}

async function waitForSnapshot(
  manager: WorkspaceAgentCredentialManager,
  predicate: (snapshot: ReturnType<WorkspaceAgentCredentialManager["getSnapshot"]>) => boolean,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate(manager.getSnapshot())) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for a credential-manager snapshot.");
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  let promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
