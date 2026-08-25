import {
  isWorkspaceAgentCredentialVaultError,
  type WorkspaceAgentCredentialVault,
  type WorkspaceAgentCredentialVaultErrorCode,
} from "@/lib/agent/application/credential-vault";

export type WorkspaceAgentCredentialStatus =
  | "checking"
  | "empty"
  | "error"
  | "forgetting"
  | "locked"
  | "saving"
  | "unlocked"
  | "unlocking";

export type WorkspaceAgentCredentialSnapshot = {
  errorCode: WorkspaceAgentCredentialVaultErrorCode | null;
  hasApiKey: boolean;
  hasStoredKey: boolean;
  revision: number;
  status: WorkspaceAgentCredentialStatus;
};

type CredentialBroadcastMessage = {
  revision: string;
  type: "credential-changed";
};

type CredentialBroadcastChannel = Pick<BroadcastChannel, "close" | "onmessage" | "postMessage">;

type WorkspaceAgentCredentialManagerOptions = {
  createBroadcastChannel?: (name: string) => CredentialBroadcastChannel | null;
};

const broadcastChannelName = "grove-agent-credentials";
const credentialRevisionStorageKey = "grove-agent-credentials:revision";

export class WorkspaceAgentCredentialManager {
  #apiKey: string | null = null;
  private broadcastChannel: CredentialBroadcastChannel | null = null;
  private consumerCount = 0;
  private epoch = 0;
  private initializePromise: Promise<void> | null = null;
  private lastRevision: string | null = null;
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private snapshot: WorkspaceAgentCredentialSnapshot = {
    errorCode: null,
    hasApiKey: false,
    hasStoredKey: false,
    revision: 0,
    status: "checking",
  };

  constructor(
    private readonly vault: WorkspaceAgentCredentialVault,
    private readonly options: WorkspaceAgentCredentialManagerOptions = {},
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  getApiKey = () => this.#apiKey;

  start = () => {
    this.consumerCount += 1;
    if (this.consumerCount == 1) {
      this.openBroadcastChannel();
      browserWindow()?.addEventListener("storage", this.handleStorageEvent);
      void this.initialize();
    }
    return () => {
      this.consumerCount = Math.max(0, this.consumerCount - 1);
      if (this.consumerCount == 0) {
        this.broadcastChannel?.close();
        this.broadcastChannel = null;
        browserWindow()?.removeEventListener("storage", this.handleStorageEvent);
        this.initializePromise = null;
        this.lock();
      }
    };
  };

  initialize = () => {
    if (this.initializePromise) return this.initializePromise;
    let operationEpoch = this.epoch;
    this.initializePromise = this.enqueue(async () => {
      try {
        let result = await this.vault.probe();
        if (operationEpoch != this.epoch) return;
        this.#apiKey = null;
        this.publish({
          errorCode: null,
          hasStoredKey: result.status == "locked",
          status: result.status,
        });
      } catch (error) {
        if (operationEpoch != this.epoch) return;
        let errorCode = credentialErrorCode(error);
        this.#apiKey = null;
        this.publish({
          errorCode,
          hasStoredKey: errorCode == "invalid-record",
          status: "error",
        });
      }
    });
    return this.initializePromise;
  };

  save = (apiKey: string, passphrase: string) => {
    let operationEpoch = ++this.epoch;
    return this.enqueue(async () => {
      let previousApiKey = this.#apiKey;
      let previousStored = this.snapshot.hasStoredKey;
      this.publish({ errorCode: null, status: "saving" });
      try {
        await this.vault.save(apiKey, passphrase);
        let stale = operationEpoch != this.epoch;
        if (!stale) {
          this.#apiKey = apiKey.trim();
          this.publish({ errorCode: null, hasStoredKey: true, status: "unlocked" });
        }
        this.broadcastChange();
        return !stale;
      } catch (error) {
        if (operationEpoch != this.epoch) return false;
        this.#apiKey = previousApiKey;
        this.publish({
          errorCode: credentialErrorCode(error),
          hasStoredKey: previousStored,
          status: "error",
        });
        return false;
      }
    });
  };

  unlock = (passphrase: string) => {
    let operationEpoch = ++this.epoch;
    return this.enqueue(async () => {
      this.publish({ errorCode: null, status: "unlocking" });
      try {
        let apiKey = await this.vault.unlock(passphrase);
        if (operationEpoch != this.epoch) return false;
        this.#apiKey = apiKey;
        this.publish({ errorCode: null, hasStoredKey: true, status: "unlocked" });
        return true;
      } catch (error) {
        if (operationEpoch != this.epoch) return false;
        this.#apiKey = null;
        this.publish({
          errorCode: credentialErrorCode(error),
          hasStoredKey: true,
          status: "error",
        });
        return false;
      }
    });
  };

  lock = () => {
    let operationEpoch = ++this.epoch;
    this.#apiKey = null;
    this.publish({
      errorCode: null,
      status: this.snapshot.hasStoredKey ? "locked" : "empty",
    });
    void this.enqueue(async () => {
      try {
        let result = await this.vault.probe();
        if (operationEpoch != this.epoch) return;
        this.publish({
          errorCode: null,
          hasStoredKey: result.status == "locked",
          status: result.status,
        });
      } catch (error) {
        if (operationEpoch != this.epoch) return;
        this.publish({
          errorCode: credentialErrorCode(error),
          hasStoredKey: this.snapshot.hasStoredKey,
          status: "error",
        });
      }
    });
  };

  forget = () => {
    let operationEpoch = ++this.epoch;
    this.#apiKey = null;
    this.publish({ errorCode: null, status: "forgetting" });
    return this.enqueue(async () => {
      try {
        await this.vault.delete();
        let current = operationEpoch == this.epoch;
        if (current) {
          this.publish({ errorCode: null, hasStoredKey: false, status: "empty" });
        }
        this.broadcastChange();
        return current;
      } catch (error) {
        if (operationEpoch != this.epoch) return false;
        this.publish({
          errorCode: credentialErrorCode(error),
          hasStoredKey: true,
          status: "error",
        });
        return false;
      }
    });
  };

  private enqueue<T>(operation: () => Promise<T>) {
    let result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private openBroadcastChannel() {
    if (this.broadcastChannel) return;
    let createChannel = this.options.createBroadcastChannel ?? defaultBroadcastChannel;
    this.broadcastChannel = createChannel(broadcastChannelName);
    if (!this.broadcastChannel) return;
    this.broadcastChannel.onmessage = (event: MessageEvent<unknown>) => {
      if (!isCredentialBroadcastMessage(event.data)) return;
      this.receiveExternalRevision(event.data.revision);
    };
  }

  private handleStorageEvent = (event: StorageEvent) => {
    if (event.key != credentialRevisionStorageKey || typeof event.newValue != "string") return;
    this.receiveExternalRevision(event.newValue);
  };

  private receiveExternalRevision(revision: string) {
    if (revision == this.lastRevision) return;
    this.lastRevision = revision;
    this.invalidateFromAnotherContext();
  }

  private invalidateFromAnotherContext() {
    let operationEpoch = ++this.epoch;
    this.#apiKey = null;
    this.publish({ errorCode: null, status: "checking" });
    void this.enqueue(async () => {
      try {
        let result = await this.vault.probe();
        if (operationEpoch != this.epoch) return;
        this.publish({
          errorCode: null,
          hasStoredKey: result.status == "locked",
          status: result.status,
        });
      } catch (error) {
        if (operationEpoch != this.epoch) return;
        let errorCode = credentialErrorCode(error);
        this.publish({
          errorCode,
          hasStoredKey: errorCode == "invalid-record",
          status: "error",
        });
      }
    });
  }

  private broadcastChange() {
    let message: CredentialBroadcastMessage = {
      revision: globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36),
      type: "credential-changed",
    };
    this.lastRevision = message.revision;
    try {
      this.broadcastChannel?.postMessage(message);
    } catch {
      // A broken BroadcastChannel must not block the storage-event fallback.
    }
    publishCredentialRevision(message.revision);
  }

  private publish(
    update: Pick<WorkspaceAgentCredentialSnapshot, "status"> &
      Partial<Omit<WorkspaceAgentCredentialSnapshot, "hasApiKey" | "revision" | "status">>,
  ) {
    this.snapshot = {
      ...this.snapshot,
      ...update,
      hasApiKey: Boolean(this.#apiKey),
      revision: this.snapshot.revision + 1,
    };
    for (let listener of this.listeners) {
      try {
        listener();
      } catch {
        // One observer must not block later credential-revocation observers.
      }
    }
  }
}

function credentialErrorCode(error: unknown): WorkspaceAgentCredentialVaultErrorCode {
  return isWorkspaceAgentCredentialVaultError(error) ? error.code : "storage-unavailable";
}

function defaultBroadcastChannel(name: string) {
  try {
    return typeof BroadcastChannel == "function" ? new BroadcastChannel(name) : null;
  } catch {
    return null;
  }
}

function browserWindow() {
  return typeof window == "undefined" ? null : window;
}

function publishCredentialRevision(revision: string) {
  try {
    browserWindow()?.localStorage.setItem(credentialRevisionStorageKey, revision);
  } catch {
    // BroadcastChannel remains the primary path when storage is unavailable.
  }
}

function isCredentialBroadcastMessage(value: unknown): value is CredentialBroadcastMessage {
  if (!value || typeof value != "object") return false;
  let message = value as Partial<CredentialBroadcastMessage>;
  return message.type == "credential-changed" && typeof message.revision == "string";
}
