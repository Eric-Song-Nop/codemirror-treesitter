import type { LoroDoc } from "loro-crdt";
import {
  RelayWireKind,
  decodeRelayWireFrame,
  encodeRelayWireBatch,
  type RelayWireMessage,
} from "./relay-protocol.ts";
import { shareRelayWebSocketUrl } from "./share-relay-client.ts";

export type ShareRelayConnectionState = "connected" | "connecting" | "offline";

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

export type ShareRelayAck = {
  acceptedAt: number;
  sequence: number;
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
  onRelayAck?: (ack: ShareRelayAck) => void;
  onShareStatus?: (status: ShareRelayStatus) => void;
};

type QueuedRelayMessage = RelayWireMessage & {
  localSequence?: number;
};

const clientCloseCodeMalformed = 4003;
const clientCloseCodePolicy = 4008;
const clientCloseCodeStale = 4001;

export class ShareRelayConnection {
  private activeGeneration = 0;
  private flushTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lastMessageAt = 0;
  private latestLocalDocumentSequence = 0;
  private queue: QueuedRelayMessage[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private receivedServerSnapshot = false;
  private socket: WebSocket | null = null;

  constructor(private readonly options: ShareRelayConnectionOptions) {}

  close() {
    this.activeGeneration++;
    this.clearReconnectTimer();
    this.clearFlushTimer();
    this.stopHeartbeat();
    this.socket?.close(1000, "Page closed");
    this.socket = null;
  }

  connect() {
    if (navigator.onLine === false) {
      this.pause();
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
          this.options.sessionToken,
          this.options.clientId,
        ),
      );
    } catch (error) {
      this.options.onError?.(errorToMessage(error));
      return;
    }

    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.receivedServerSnapshot = false;
    this.lastMessageAt = Date.now();

    socket.addEventListener("open", () => {
      if (!this.isActive(generation, socket)) return;
      this.reconnectAttempt = 0;
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
      if (event.code == 1008 || event.code == clientCloseCodePolicy) {
        this.options.onError?.(event.reason || "Shared file access was rejected.");
        this.options.onConnectionState?.("offline");
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
    let localSequence = ++this.latestLocalDocumentSequence;
    this.queue.push({
      kind: RelayWireKind.Doc,
      localSequence,
      payload: new Uint8Array(payload),
    });
    this.scheduleFlush();
    return localSequence;
  }

  enqueueHostSaveAck(payload: Uint8Array = new Uint8Array()) {
    this.queue.push({ kind: RelayWireKind.HostSaveAck, payload: new Uint8Array(payload) });
    this.scheduleFlush();
  }

  pause() {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.socket?.close(1000, "Offline");
    this.socket = null;
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
    if (!this.queue.length || !this.readyToSend()) return;

    let messages = this.queue.splice(0);
    let latestLocalSequence = latestQueuedLocalSequence(messages);
    let frameMessages: RelayWireMessage[] = messages.map(({ kind, payload }) => ({
      kind,
      payload,
    }));
    if (latestLocalSequence != null) {
      frameMessages.push({
        kind: RelayWireKind.RelayAckRequest,
        payload: relayAckRequestPayload(latestLocalSequence),
      });
    }
    let frame = encodeRelayWireBatch(frameMessages);

    try {
      this.socket!.send(frame);
    } catch {
      this.queue.unshift(...messages);
      this.socket?.close();
    }
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
      } else if (message.kind == RelayWireKind.RelayAck) {
        this.handleRelayAck(message.payload);
      }

      if (message.kind == RelayWireKind.Snapshot && !this.receivedServerSnapshot) {
        this.receivedServerSnapshot = true;
        this.options.onConnectionState?.("connected");
        this.scheduleFlush();
      }
    }
  }

  private handleControlMessage(data: string) {
    try {
      JSON.parse(data);
    } catch {
      this.socket?.close(clientCloseCodeMalformed, "Malformed control message");
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

  private handleRelayAck(payload: Uint8Array) {
    try {
      this.options.onRelayAck?.(parseShareRelayAck(payload));
    } catch {
      this.options.onError?.("Shared file relay sent invalid acknowledgement.");
      this.socket?.close(clientCloseCodeMalformed, "Malformed relay acknowledgement");
    }
  }

  private isActive(generation: number, socket: WebSocket) {
    return this.activeGeneration == generation && this.socket == socket;
  }

  private readyToSend() {
    return this.socket?.readyState == WebSocket.OPEN && this.receivedServerSnapshot;
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

export function parseShareRelayAck(payload: Uint8Array): ShareRelayAck {
  let value = JSON.parse(new TextDecoder().decode(payload)) as Partial<ShareRelayAck>;
  if (
    typeof value.acceptedAt != "number" ||
    typeof value.sequence != "number" ||
    !Number.isFinite(value.acceptedAt) ||
    !Number.isFinite(value.sequence) ||
    value.sequence < 1 ||
    typeof value.shareId != "string"
  ) {
    throw new Error("Invalid relay ack.");
  }

  return {
    acceptedAt: value.acceptedAt,
    sequence: value.sequence,
    shareId: value.shareId,
  };
}

function latestQueuedLocalSequence(messages: readonly QueuedRelayMessage[]) {
  let latest: number | null = null;
  for (let message of messages) {
    if (message.localSequence == null) continue;
    latest = Math.max(latest ?? 0, message.localSequence);
  }
  return latest;
}

function relayAckRequestPayload(sequence: number) {
  return new TextEncoder().encode(JSON.stringify({ sequence }));
}

function errorToMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
