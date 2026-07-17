import { VersionVector, type LoroDoc } from "loro-crdt";
import {
  RelayWireKind,
  decodeRelayWireFrame,
  encodeRelayWireBatch,
  type RelayWireMessage,
} from "./relay-protocol.ts";
import { shareRelayWebSocketUrl } from "./share-relay-client.ts";

export type ShareRelayConnectionState = "connected" | "connecting" | "offline" | "resync-required";

export type ShareRelayStatus = {
  displayName: string;
  expiresAt: number | null;
  guestCount: number;
  hostOnline: boolean;
  peerCount: number;
  pendingHostSave: boolean;
  revokedAt: number | null;
  shareId: string;
};

export type ShareRelayConnectionOptions = {
  clientId: string;
  doc: LoroDoc;
  relayOrigin: string;
  sessionToken: string;
  shareId: string;
  onConnectionState?: (state: ShareRelayConnectionState) => void;
  onDocumentImported?: () => void;
  onError?: (message: string) => void;
  onHostSaveAck?: (payload: Uint8Array) => void;
  onShareStatus?: (status: ShareRelayStatus) => void;
  refreshSessionToken?: (signal: AbortSignal) => Promise<string>;
};

type QueuedRelayMessage = RelayWireMessage;

type SyncReadyControlMessage = {
  type: "sync-ready";
  versionVector?: unknown;
};

const clientCloseCodeMalformed = 4003;
const clientCloseCodePolicy = 4008;
const clientCloseCodeResyncRequired = 4009;
const clientCloseCodeSessionRefreshRequired = 4001;
const clientCloseCodeStale = 4002;
export const maxQueuedRelayMessages = 512;
export const maxQueuedRelayBytes = 1024 * 1024;
export const maxSingleQueuedDocumentUpdateBytes = 256 * 1024;
export const maxRelayBatchMessages = 64;

export class ShareRelayConnection {
  private activeGeneration = 0;
  private closed = false;
  private flushTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lastMessageAt = 0;
  private offlineBaseVersion: VersionVector | null = null;
  private queue: QueuedRelayMessage[] = [];
  private queuedBytes = 0;
  private queueRequiresResync = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private receivedInitialSync = false;
  private sessionRefreshController: AbortController | null = null;
  private sessionRefreshPromise: Promise<void> | null = null;
  private sessionRefreshRequired = false;
  private sessionToken: string;
  private socket: WebSocket | null = null;

  constructor(private readonly options: ShareRelayConnectionOptions) {
    this.sessionToken = options.sessionToken;
  }

  close() {
    this.flushNow();
    this.closed = true;
    this.activeGeneration++;
    this.cancelSessionRefresh();
    this.sessionRefreshRequired = false;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.socket?.close(1000, "Page closed");
    this.socket = null;
  }

  flushNow() {
    this.clearFlushTimer();
    this.flushQueue();
  }

  connect() {
    if (this.closed) return;
    if (this.queueRequiresResync) {
      this.options.onConnectionState?.("resync-required");
      return;
    }

    if (navigator.onLine === false) {
      this.pause();
      return;
    }
    if (this.sessionRefreshRequired) {
      this.startSessionRefresh();
      return;
    }

    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.socket?.close(1000, "Reconnecting");
    this.options.onConnectionState?.("connecting");

    let generation = ++this.activeGeneration;
    let socket: WebSocket;
    try {
      socket = new WebSocket(
        shareRelayWebSocketUrl(
          this.options.relayOrigin,
          this.options.shareId,
          this.options.clientId,
        ),
      );
    } catch (error) {
      this.options.onError?.(errorToMessage(error));
      return;
    }

    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.receivedInitialSync = false;
    this.lastMessageAt = Date.now();

    socket.addEventListener("open", () => {
      if (!this.isActive(generation, socket)) return;
      this.reconnectAttempt = 0;
      socket.send(
        JSON.stringify({
          clientId: this.options.clientId,
          sessionToken: this.sessionToken,
          type: "auth",
          versionVector: serializeDocVersionVector(this.options.doc),
        }),
      );
      this.startHeartbeat(generation, socket);
    });

    socket.addEventListener("message", (event: MessageEvent<ArrayBuffer | string>) => {
      if (!this.isActive(generation, socket)) return;
      this.lastMessageAt = Date.now();
      this.handleMessage(event.data);
    });

    socket.addEventListener("close", (event) => {
      if (!this.isActive(generation, socket)) return;
      this.socket = null;
      this.stopHeartbeat();
      if (event.code == clientCloseCodeSessionRefreshRequired) {
        this.requireSessionRefresh();
        return;
      }
      if (event.code == 1008 || event.code == clientCloseCodePolicy) {
        this.options.onError?.(policyCloseMessage(event.reason));
        this.options.onConnectionState?.("offline");
        return;
      }
      if (event.code == clientCloseCodeResyncRequired) {
        this.options.onConnectionState?.("resync-required");
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (!this.isActive(generation, socket)) return;
      socket.close();
    });
  }

  enqueueDocumentUpdate(payload: Uint8Array) {
    if (payload.byteLength > maxSingleQueuedDocumentUpdateBytes) {
      this.enterResyncRequired("Shared file update is too large to send through the relay.");
      return null;
    }
    if (this.offlineBaseVersion) {
      this.scheduleFlush();
      return true;
    }
    if (!this.canQueueMessage(payload)) {
      this.enterResyncRequired("Shared file edits exceeded the offline queue limit.");
      return null;
    }

    let message = {
      kind: RelayWireKind.Doc,
      payload: new Uint8Array(payload),
    };
    this.queue.push(message);
    this.queuedBytes += queuedMessageBytes(message);
    this.scheduleFlush();
    return true;
  }

  enqueueHostSaveAck(payload: Uint8Array = new Uint8Array()) {
    if (!this.canQueueMessage(payload)) {
      this.enterResyncRequired("Shared file host acknowledgements exceeded the queue limit.");
      return;
    }

    let message = { kind: RelayWireKind.HostSaveAck, payload: new Uint8Array(payload) };
    this.queue.push(message);
    this.queuedBytes += queuedMessageBytes(message);
    this.scheduleFlush();
  }

  pause() {
    this.captureOfflineBaseVersion();
    this.cancelSessionRefresh();
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.socket?.close(1000, "Offline");
    this.socket = null;
    if (this.queueRequiresResync) {
      this.options.onConnectionState?.("resync-required");
      return;
    }
    this.options.onConnectionState?.("offline");
  }

  private clearFlushTimer() {
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private flushQueue() {
    this.flushTimer = null;
    if (!this.hasQueuedMessages() || !this.readyToSend()) return;

    if (this.offlineBaseVersion) {
      let mergedUpdate = this.options.doc.export({
        from: this.offlineBaseVersion,
        mode: "update",
      });
      if (mergedUpdate.byteLength > maxQueuedRelayBytes) {
        this.enterResyncRequired("Shared file edits exceeded the offline queue limit.");
        return;
      }
      if (mergedUpdate.byteLength > maxSingleQueuedDocumentUpdateBytes) {
        this.enterResyncRequired("Shared file update is too large to send through the relay.");
        return;
      }
      if (mergedUpdate.byteLength) {
        try {
          this.socket!.send(
            encodeRelayWireBatch([{ kind: RelayWireKind.Doc, payload: mergedUpdate }]),
          );
        } catch {
          this.socket?.close();
          return;
        }
      }
      this.offlineBaseVersion = null;
    }

    while (this.queue.length && this.readyToSend()) {
      let messages = this.queue.slice(0, maxRelayBatchMessages);
      try {
        this.socket!.send(encodeRelayWireBatch(messages));
      } catch {
        this.socket?.close();
        return;
      }
      this.queue.splice(0, messages.length);
      this.queuedBytes -= queuedMessagesBytes(messages);
    }
  }

  private canQueueMessage(payload: Uint8Array) {
    return (
      !this.queueRequiresResync &&
      this.queue.length < maxQueuedRelayMessages &&
      this.queuedBytes + payload.byteLength <= maxQueuedRelayBytes
    );
  }

  private captureOfflineBaseVersion() {
    if (this.offlineBaseVersion || this.queueRequiresResync) return;
    this.offlineBaseVersion = this.options.doc.oplogVersion();
  }

  private enterResyncRequired(message: string) {
    this.queue = [];
    this.queuedBytes = 0;
    this.queueRequiresResync = true;
    this.clearFlushTimer();
    this.clearReconnectTimer();
    this.options.onError?.(message);
    this.options.onConnectionState?.("resync-required");
    this.socket?.close(clientCloseCodeResyncRequired, "Resync required");
  }

  private handleMessage(data: ArrayBuffer | string) {
    if (typeof data == "string") {
      this.handleControlMessage(data);
      return;
    }

    let messages: RelayWireMessage[];
    try {
      messages = decodeRelayWireFrame(data);
    } catch {
      this.options.onError?.("Shared file relay sent an invalid message.");
      this.socket?.close(clientCloseCodeMalformed, "Malformed relay frame");
      return;
    }

    for (let message of messages) {
      if (message.kind == RelayWireKind.Doc || message.kind == RelayWireKind.Snapshot) {
        try {
          this.options.doc.import(message.payload);
          this.options.onDocumentImported?.();
        } catch {
          this.options.onError?.("Shared file relay sent invalid document data.");
          this.socket?.close(clientCloseCodeMalformed, "Malformed document payload");
          return;
        }
      } else if (message.kind == RelayWireKind.ShareStatus) {
        this.handleShareStatus(message.payload);
      } else if (message.kind == RelayWireKind.HostSaveAck) {
        this.options.onHostSaveAck?.(message.payload);
      }
    }
  }

  private handleControlMessage(data: string) {
    let message: { type?: unknown };
    try {
      message = JSON.parse(data) as { type?: unknown };
    } catch {
      this.socket?.close(clientCloseCodeMalformed, "Malformed control message");
      return;
    }
    if (message.type == "sync-ready") {
      this.handleSyncReady(message as SyncReadyControlMessage);
    } else if (message.type == "session-refresh-required") {
      this.requireSessionRefresh();
    }
  }

  private handleShareStatus(payload: Uint8Array) {
    try {
      let status = parseShareRelayStatus(payload);
      this.options.onShareStatus?.(status);
      if (status.revokedAt != null) {
        this.options.onError?.("Sharing has been stopped by the owner.");
        this.socket?.close(clientCloseCodePolicy, "Sharing stopped");
      }
    } catch {
      this.options.onError?.("Shared file relay sent invalid status.");
      this.socket?.close(clientCloseCodeMalformed, "Malformed share status");
    }
  }

  private isActive(generation: number, socket: WebSocket) {
    return this.activeGeneration == generation && this.socket == socket;
  }

  private readyToSend() {
    return this.socket?.readyState == WebSocket.OPEN && this.receivedInitialSync;
  }

  private completeInitialSync(serverVersion: VersionVector) {
    if (this.receivedInitialSync) return;
    if (!this.sendClientCatchUp(serverVersion)) return;
    this.receivedInitialSync = true;
    this.options.onConnectionState?.("connected");
    this.scheduleFlush();
  }

  private handleSyncReady(message: SyncReadyControlMessage) {
    let serverVersion = parseVersionVector(message.versionVector);
    if (!serverVersion) {
      this.options.onError?.("Shared file relay sent invalid sync metadata.");
      this.socket?.close(clientCloseCodeMalformed, "Malformed sync metadata");
      return;
    }
    this.completeInitialSync(serverVersion);
  }

  private sendClientCatchUp(serverVersion: VersionVector) {
    if (this.socket?.readyState != WebSocket.OPEN) return false;

    let update: Uint8Array;
    try {
      update = this.options.doc.export({ from: serverVersion, mode: "update" });
    } catch {
      this.enterResyncRequired("Shared file sync metadata is no longer compatible.");
      return false;
    }

    if (update.byteLength > maxQueuedRelayBytes) {
      this.enterResyncRequired("Shared file edits exceeded the offline queue limit.");
      return false;
    }
    if (update.byteLength > maxSingleQueuedDocumentUpdateBytes) {
      this.enterResyncRequired("Shared file update is too large to send through the relay.");
      return false;
    }
    if (update.byteLength) {
      try {
        this.socket.send(encodeRelayWireBatch([{ kind: RelayWireKind.Doc, payload: update }]));
      } catch {
        this.socket.close();
        return false;
      }
    }
    this.discardQueuedDocumentUpdates();
    this.offlineBaseVersion = null;
    return true;
  }

  private discardQueuedDocumentUpdates() {
    if (!this.queue.some((message) => message.kind == RelayWireKind.Doc)) return;
    let retained = this.queue.filter((message) => message.kind != RelayWireKind.Doc);
    this.queuedBytes = queuedMessagesBytes(retained);
    this.queue = retained;
  }

  private reconnectDelay() {
    let base = Math.min(250 * 2 ** this.reconnectAttempt, 10_000);
    this.reconnectAttempt++;
    return base + (crypto.getRandomValues(new Uint16Array(1))[0]! % 301);
  }

  private scheduleFlush() {
    if (!this.readyToSend() || this.flushTimer != null) return;
    this.flushTimer = window.setTimeout(() => this.flushQueue(), 50);
  }

  private scheduleReconnect() {
    this.captureOfflineBaseVersion();
    if (this.reconnectTimer != null || navigator.onLine === false) {
      this.options.onConnectionState?.("offline");
      return;
    }

    this.options.onConnectionState?.("offline");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay());
  }

  private requireSessionRefresh() {
    if (this.closed) return;
    this.sessionRefreshRequired = true;
    this.captureOfflineBaseVersion();
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.options.onConnectionState?.("connecting");
    this.startSessionRefresh();
  }

  private startSessionRefresh() {
    if (this.closed || this.sessionRefreshPromise) return;
    let refreshSessionToken = this.options.refreshSessionToken;
    if (!refreshSessionToken) {
      this.options.onError?.("Shared file access expired. Request a new session to reconnect.");
      this.options.onConnectionState?.("offline");
      return;
    }

    let controller = new AbortController();
    this.sessionRefreshController = controller;
    let task = Promise.resolve().then(async () => {
      try {
        let sessionToken = await refreshSessionToken(controller.signal);
        if (controller.signal.aborted || this.closed || !this.sessionRefreshRequired) return;
        this.sessionToken = sessionToken;
        this.sessionRefreshRequired = false;
        this.reconnectAttempt = 0;
        this.connect();
      } catch (error) {
        if (controller.signal.aborted || this.closed) return;
        this.options.onError?.(errorToMessage(error));
        this.scheduleReconnect();
      } finally {
        if (this.sessionRefreshController == controller) {
          this.sessionRefreshController = null;
          this.sessionRefreshPromise = null;
        }
      }
    });
    this.sessionRefreshPromise = task;
  }

  private cancelSessionRefresh() {
    this.sessionRefreshController?.abort();
    this.sessionRefreshController = null;
    this.sessionRefreshPromise = null;
  }

  private startHeartbeat(generation: number, socket: WebSocket) {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.isActive(generation, socket)) return;
      if (Date.now() - this.lastMessageAt > 60_000) {
        socket.close(clientCloseCodeStale, "Stale connection");
        return;
      }
      if (socket.readyState == WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }, 25_000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer != null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private hasQueuedMessages() {
    return this.queue.length > 0 || this.offlineBaseVersion != null;
  }
}

export function parseShareRelayStatus(payload: Uint8Array): ShareRelayStatus {
  let value = JSON.parse(new TextDecoder().decode(payload)) as Partial<ShareRelayStatus>;
  if (
    typeof value.displayName != "string" ||
    (value.expiresAt != null && typeof value.expiresAt != "number") ||
    (value.guestCount != null && typeof value.guestCount != "number") ||
    typeof value.hostOnline != "boolean" ||
    (value.peerCount != null && typeof value.peerCount != "number") ||
    (value.pendingHostSave != null && typeof value.pendingHostSave != "boolean") ||
    (value.revokedAt != null && typeof value.revokedAt != "number") ||
    typeof value.shareId != "string"
  ) {
    throw new Error("Invalid share status.");
  }

  return {
    displayName: value.displayName,
    expiresAt: value.expiresAt ?? null,
    guestCount: value.guestCount ?? 0,
    hostOnline: value.hostOnline,
    peerCount: value.peerCount ?? 0,
    pendingHostSave: value.pendingHostSave ?? false,
    revokedAt: value.revokedAt ?? null,
    shareId: value.shareId,
  };
}

function queuedMessageBytes(message: QueuedRelayMessage) {
  return message.payload.byteLength;
}

function queuedMessagesBytes(messages: readonly QueuedRelayMessage[]) {
  let byteLength = 0;
  for (let message of messages) byteLength += queuedMessageBytes(message);
  return byteLength;
}

function serializeDocVersionVector(doc: LoroDoc) {
  return serializeVersionVector(doc.oplogVersion());
}

function serializeVersionVector(version: VersionVector) {
  return [...version.toJSON()].map(([peer, counter]) => [String(peer), counter]);
}

function parseVersionVector(value: unknown) {
  if (!Array.isArray(value)) return null;
  let version = new Map<`${number}`, number>();
  for (let entry of value) {
    if (!Array.isArray(entry) || entry.length != 2) return null;
    let [peer, counter] = entry;
    if (
      typeof peer != "string" ||
      !/^\d+$/.test(peer) ||
      typeof counter != "number" ||
      !Number.isSafeInteger(counter) ||
      counter < 0
    ) {
      return null;
    }
    version.set(peer as `${number}`, counter);
  }
  return new VersionVector(version);
}

function policyCloseMessage(reason: string) {
  if (!reason || reason == "Share session is no longer valid") {
    return "Shared file access was rejected.";
  }
  return reason;
}

function errorToMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
