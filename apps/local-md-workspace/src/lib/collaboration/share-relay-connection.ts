import { Duration, Effect, Random, Schedule, type Fiber } from "effect";
import { VersionVector, type LoroDoc } from "loro-crdt";
import {
  ShareRelayConnectionLost,
  ShareRelayProtocolError,
  ShareRelayResyncRequired,
  ShareRelaySessionExpired,
  ShareRelaySessionRefreshFailed,
  ShareRelaySessionRefreshRequired,
  ShareRelayUnauthorized,
} from "./relay-errors.ts";
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

/**
 * Delay between reconnect attempts: 250ms doubling to at most 10s, plus up to
 * 300ms of random jitter. The attempt count restarts once a socket opens.
 */
export const shareRelayReconnectSchedule = Schedule.min([
  Schedule.exponential("250 millis"),
  Schedule.spaced("10 seconds"),
]).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.map(Random.nextIntBetween(0, 300), (jitter) =>
      Duration.sum(duration, Duration.millis(jitter)),
    ),
  ),
);

/** Why one WebSocket session ended. */
type SocketEnd =
  | ShareRelayConnectionLost
  | ShareRelayProtocolError
  | ShareRelayResyncRequired
  | ShareRelaySessionRefreshRequired
  | ShareRelayUnauthorized;

type SocketClose = { code: number; reason: string };

/**
 * One shared-file relay connection.
 *
 * The public API is synchronous (the editor enqueues updates from Loro
 * callbacks), and frame handling stays synchronous so imports and sends keep
 * their order. The connection's lifetime is an Effect fiber: each WebSocket is
 * a scoped resource whose release closes it and removes its listeners;
 * reconnects wait on {@link shareRelayReconnectSchedule}; session refresh is
 * an interruptible Effect. `close()`, `pause()`, and a new `connect()`
 * interrupt the fiber, which aborts an in-flight refresh and closes the socket.
 */
export class ShareRelayConnection {
  private closed = false;
  private endSocket: ((end: SocketEnd) => void) | null = null;
  private flushTimer: number | null = null;
  private lastMessageAt = 0;
  private offlineBaseVersion: VersionVector | null = null;
  private queue: QueuedRelayMessage[] = [];
  private queuedBytes = 0;
  private queueRequiresResync = false;
  private receivedInitialSync = false;
  private session: Fiber.Fiber<void> | null = null;
  private sessionRefreshRequired = false;
  private sessionToken: string;
  private socket: WebSocket | null = null;
  private socketClose: SocketClose = { code: 1000, reason: "Reconnecting" };

  constructor(private readonly options: ShareRelayConnectionOptions) {
    this.sessionToken = options.sessionToken;
  }

  close() {
    this.flushNow();
    this.closed = true;
    this.sessionRefreshRequired = false;
    this.stopSession({ code: 1000, reason: "Page closed" });
    this.releaseOfflineBaseVersion();
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

    this.stopSession({ code: 1000, reason: "Reconnecting" });
    this.session = Effect.runFork(this.runSession());
  }

  private stopSession(close: SocketClose) {
    let session = this.session;
    this.session = null;
    if (!session) return;
    this.socketClose = close;
    session.interruptUnsafe();
  }

  /**
   * The connection's lifetime: refresh the session token when required, run one
   * socket until it ends, then decide whether and when to try again.
   */
  private runSession(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      let backoff = yield* Schedule.toStepWithSleep(shareRelayReconnectSchedule);
      let reconnectLater = Effect.gen({ self: this }, function* () {
        this.captureOfflineBaseVersion();
        this.options.onConnectionState?.("offline");
        if (navigator.onLine === false) return false;
        // The schedule never ends, so its step cannot report completion.
        yield* Effect.orDie(backoff(undefined));
        return true;
      });

      while (true) {
        if (this.sessionRefreshRequired) {
          let refreshed = yield* Effect.result(this.refreshSessionToken());
          if (refreshed._tag == "Failure") {
            this.options.onError?.(refreshed.failure.message);
            if (refreshed.failure._tag == "ShareRelaySessionExpired") {
              this.options.onConnectionState?.("offline");
              return;
            }
            if (!(yield* reconnectLater)) return;
            continue;
          }
          this.sessionToken = refreshed.success;
          this.sessionRefreshRequired = false;
          backoff = yield* Schedule.toStepWithSleep(shareRelayReconnectSchedule);
        }

        this.options.onConnectionState?.("connecting");
        let end = yield* Effect.flip(this.runSocket());
        switch (end._tag) {
          case "ShareRelaySessionRefreshRequired":
            this.sessionRefreshRequired = true;
            this.captureOfflineBaseVersion();
            this.options.onConnectionState?.("connecting");
            continue;
          case "ShareRelayUnauthorized":
            this.options.onError?.(end.message);
            this.options.onConnectionState?.("offline");
            return;
          case "ShareRelayResyncRequired":
            this.options.onConnectionState?.("resync-required");
            return;
          case "ShareRelayProtocolError":
            this.options.onError?.(end.message);
            return;
          case "ShareRelayConnectionLost":
            if (end.opened) backoff = yield* Schedule.toStepWithSleep(shareRelayReconnectSchedule);
            if (!(yield* reconnectLater)) return;
            continue;
        }
      }
    });
  }

  private refreshSessionToken(): Effect.Effect<
    string,
    ShareRelaySessionExpired | ShareRelaySessionRefreshFailed
  > {
    let refresh = this.options.refreshSessionToken;
    if (!refresh) {
      return Effect.fail(
        new ShareRelaySessionExpired({
          message: "Shared file access expired. Request a new session to reconnect.",
        }),
      );
    }
    return Effect.tryPromise({
      catch: (cause) =>
        new ShareRelaySessionRefreshFailed({ cause, message: errorToMessage(cause) }),
      try: (signal) => refresh(signal),
    });
  }

  /**
   * Runs one WebSocket as a scoped resource. It fails with why the socket ended;
   * releasing it removes its listeners, stops its heartbeat, and closes it.
   */
  private runSocket(): Effect.Effect<never, SocketEnd> {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        let socket = yield* Effect.acquireRelease(
          Effect.try({
            catch: (cause) => new ShareRelayProtocolError({ message: errorToMessage(cause) }),
            try: () =>
              new WebSocket(
                shareRelayWebSocketUrl(
                  this.options.relayOrigin,
                  this.options.shareId,
                  this.options.clientId,
                ),
              ),
          }),
          (socket) =>
            Effect.sync(() => {
              if (this.socket === socket) this.socket = null;
              let { code, reason } = this.socketClose;
              this.socketClose = { code: 1000, reason: "Reconnecting" };
              if (socket.readyState != WebSocket.CLOSED) socket.close(code, reason);
            }),
        );
        socket.binaryType = "arraybuffer";
        this.socket = socket;
        this.receivedInitialSync = false;
        this.lastMessageAt = Date.now();
        return yield* this.awaitSocketEnd(socket);
      }),
    );
  }

  private awaitSocketEnd(socket: WebSocket) {
    return Effect.callback<never, SocketEnd>((resume) => {
      let opened = false;
      let heartbeat: number | null = null;
      let end = (reason: SocketEnd) => resume(Effect.fail(reason));
      this.endSocket = end;

      let handleOpen = () => {
        opened = true;
        socket.send(
          JSON.stringify({
            clientId: this.options.clientId,
            sessionToken: this.sessionToken,
            type: "auth",
            versionVector: serializeDocVersionVector(this.options.doc),
          }),
        );
        heartbeat = window.setInterval(() => {
          if (Date.now() - this.lastMessageAt > 60_000) {
            socket.close(clientCloseCodeStale, "Stale connection");
            return;
          }
          if (socket.readyState == WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
        }, 25_000);
      };
      let handleMessage = (event: MessageEvent<ArrayBuffer | string>) => {
        if (this.socket !== socket) return;
        this.lastMessageAt = Date.now();
        this.handleMessage(event.data);
      };
      let handleClose = (event: CloseEvent) => {
        if (this.socket === socket) this.socket = null;
        end(socketEndFromClose(event, opened));
      };
      let handleError = () => socket.close();

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("close", handleClose);
      socket.addEventListener("error", handleError);

      return Effect.sync(() => {
        if (this.endSocket === end) this.endSocket = null;
        if (heartbeat != null) clearInterval(heartbeat);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("message", handleMessage);
        socket.removeEventListener("close", handleClose);
        socket.removeEventListener("error", handleError);
      });
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
    this.stopSession({ code: 1000, reason: "Offline" });
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
      this.releaseOfflineBaseVersion();
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

  private releaseOfflineBaseVersion() {
    this.offlineBaseVersion?.free();
    this.offlineBaseVersion = null;
  }

  private enterResyncRequired(message: string) {
    this.queue = [];
    this.queuedBytes = 0;
    this.queueRequiresResync = true;
    this.releaseOfflineBaseVersion();
    this.clearFlushTimer();
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
    try {
      this.completeInitialSync(serverVersion);
    } finally {
      serverVersion.free();
    }
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
    this.releaseOfflineBaseVersion();
    return true;
  }

  private discardQueuedDocumentUpdates() {
    if (!this.queue.some((message) => message.kind == RelayWireKind.Doc)) return;
    let retained = this.queue.filter((message) => message.kind != RelayWireKind.Doc);
    this.queuedBytes = queuedMessagesBytes(retained);
    this.queue = retained;
  }

  private scheduleFlush() {
    if (!this.readyToSend() || this.flushTimer != null) return;
    this.flushTimer = window.setTimeout(() => this.flushQueue(), 50);
  }

  /** Ends the current socket so the session loop refreshes the token first. */
  private requireSessionRefresh() {
    if (this.closed) return;
    this.endSocket?.(new ShareRelaySessionRefreshRequired());
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
  let version = doc.oplogVersion();
  try {
    return serializeVersionVector(version);
  } finally {
    version.free();
  }
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

function socketEndFromClose(event: CloseEvent, opened: boolean): SocketEnd {
  if (event.code == clientCloseCodeSessionRefreshRequired) {
    return new ShareRelaySessionRefreshRequired();
  }
  if (event.code == 1008 || event.code == clientCloseCodePolicy) {
    return new ShareRelayUnauthorized({ message: policyCloseMessage(event.reason) });
  }
  if (event.code == clientCloseCodeResyncRequired) return new ShareRelayResyncRequired();
  return new ShareRelayConnectionLost({ code: event.code, opened });
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
