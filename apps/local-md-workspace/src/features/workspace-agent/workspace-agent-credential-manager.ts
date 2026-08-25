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
  status: WorkspaceAgentCredentialStatus;
};

type CredentialBroadcastChannel = Pick<BroadcastChannel, "close" | "onmessage" | "postMessage">;

type WorkspaceAgentCredentialManagerOptions = {
  createBroadcastChannel?: (name: string) => CredentialBroadcastChannel | null;
  createRevision?: () => string | null;
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
    this.initializePromise = this.refreshFromVault(this.epoch);
    return this.initializePromise;
  };

  save = (apiKey: string, passphrase: string) => {
    let operationEpoch = ++this.epoch;
    return this.enqueue(async () => {
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
        this.#apiKey = null;
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
    void this.refreshFromVault(operationEpoch, true);
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
      if (typeof event.data == "string") this.receiveExternalRevision(event.data);
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
    void this.refreshFromVault(operationEpoch);
  }

  private broadcastChange() {
    let createRevision = this.options.createRevision ?? createCredentialRevision;
    let revision = createRevision();
    if (!revision) return;
    this.lastRevision = revision;
    try {
      this.broadcastChannel?.postMessage(revision);
    } catch {
      // A broken BroadcastChannel must not block the storage-event fallback.
    }
    publishCredentialRevision(revision);
  }

  private refreshFromVault(operationEpoch: number, preserveStoredKeyOnError = false) {
    return this.enqueue(async () => {
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
          hasStoredKey: preserveStoredKeyOnError
            ? this.snapshot.hasStoredKey
            : errorCode == "invalid-record",
          status: "error",
        });
      }
    });
  }

  private publish(
    update: Pick<WorkspaceAgentCredentialSnapshot, "status"> &
      Partial<Omit<WorkspaceAgentCredentialSnapshot, "hasApiKey" | "status">>,
  ) {
    this.snapshot = {
      ...this.snapshot,
      ...update,
      hasApiKey: Boolean(this.#apiKey),
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

function createCredentialRevision() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    if (!globalThis.crypto?.getRandomValues) return null;
    let bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}
