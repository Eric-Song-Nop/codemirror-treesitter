import {
  WireKind,
  decodeWireFrame,
  encodeBase64,
  encodeWireBatch,
  hashShareSecret,
  maxDocumentUpdateBytes,
  maxSnapshotBytes,
  type ShareRole,
} from "@codemirror-treesitter/relay-core/client";
import { VersionVector, type LoroDoc } from "loro-crdt";
import type { ShareCredentials } from "./share-link.ts";

export type ConnectionState = "connecting" | "connected" | "offline" | "unavailable";

export type ShareAccess = {
  role: ShareRole;
  secret: string;
  shareId: string;
};

export class ShareUnavailableError extends Error {}

const clientCloseCodeMalformed = 4003;
const clientCloseCodeStale = 4002;
const sessionRefreshCloseCode = 4001;
// The relay refills 120 document updates per minute per socket; flushing a
// merged update at most twice a second stays inside that budget.
const flushIntervalMs = 500;

export async function createRelayShare(
  origin: string,
  credentials: ShareCredentials,
  snapshot: Uint8Array,
  options: { displayName: string; expiresAt: number },
) {
  let [guestSecretHash, hostSecretHash] = await Promise.all([
    hashShareSecret(credentials.guestSecret),
    hashShareSecret(credentials.hostSecret),
  ]);
  let response = await fetch(new URL("/api/shares", origin), {
    body: JSON.stringify({
      displayName: options.displayName,
      expiresAt: options.expiresAt,
      guestSecretHash,
      hostSecretHash,
      shareId: credentials.shareId,
      snapshot: encodeBase64(snapshot),
    }),
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": credentials.shareId,
    },
    method: "POST",
  });
  if (!response.ok) throw new Error(await responseError(response, "Could not create room"));
}

export async function createRelaySession(origin: string, access: ShareAccess) {
  let response = await fetch(
    new URL(`/api/shares/${encodeURIComponent(access.shareId)}/session`, origin),
    {
      body: JSON.stringify({ role: access.role, secret: access.secret }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (response.status == 403 || response.status == 404) {
    throw new ShareUnavailableError(await responseError(response, "Room unavailable"));
  }
  if (!response.ok) throw new Error(await responseError(response, "Could not join room"));
  let body = (await response.json()) as { sessionToken?: unknown };
  if (typeof body.sessionToken != "string") throw new Error("Relay returned an invalid session");
  return body.sessionToken;
}

/**
 * Share-room WebSocket client: session issuance, `auth` handshake with the
 * local version vector, catch-up after `sync-ready`, merged-update flushing,
 * session refresh, reconnect/backoff, and heartbeat.
 */
export class ShareRoomConnection {
  private activeGeneration = 0;
  private dirty = false;
  private flushTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lastMessageAt = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private sentVersion: VersionVector | null = null;
  private sessionToken: string | null = null;
  private socket: WebSocket | null = null;
  private stopped = false;

  constructor(
    private readonly options: {
      access: ShareAccess;
      clientId: string;
      doc: LoroDoc;
      onState?: (state: ConnectionState, detail?: string) => void;
      origin: string;
    },
  ) {}

  close() {
    this.stopped = true;
    this.activeGeneration++;
    this.clearReconnectTimer();
    this.clearFlushTimer();
    this.stopHeartbeat();
    this.socket?.close(1000, "Page closed");
    this.socket = null;
    this.releaseSentVersion();
  }

  async connect() {
    if (this.stopped) return;
    if (navigator.onLine === false) {
      this.options.onState?.("offline");
      return;
    }
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.socket?.close(1000, "Reconnecting");
    this.socket = null;
    this.releaseSentVersion();
    let generation = ++this.activeGeneration;
    this.options.onState?.("connecting");

    if (!this.sessionToken) {
      try {
        this.sessionToken = await createRelaySession(this.options.origin, this.options.access);
      } catch (error: unknown) {
        if (generation != this.activeGeneration) return;
        if (error instanceof ShareUnavailableError) {
          this.stopped = true;
          this.options.onState?.("unavailable", error.message);
          return;
        }
        this.options.onState?.("offline", errorMessage(error));
        this.scheduleReconnect();
        return;
      }
      if (generation != this.activeGeneration) return;
    }

    let socket = new WebSocket(this.websocketUrl());
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.lastMessageAt = Date.now();

    socket.addEventListener("open", () => {
      if (!this.isActive(generation, socket)) return;
      this.reconnectAttempt = 0;
      socket.send(
        JSON.stringify({
          clientId: this.options.clientId,
          sessionToken: this.sessionToken,
          type: "auth",
          versionVector: serializeVersion(this.options.doc),
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
      this.releaseSentVersion();
      // Policy closes (expired/rotated sessions, revoked shares) re-request a
      // session; a share that is gone then reports itself as unavailable.
      if (event.code == sessionRefreshCloseCode || event.code == 1008) this.sessionToken = null;
      this.options.onState?.("offline", event.reason || undefined);
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (!this.isActive(generation, socket)) return;
      socket.close();
    });
  }

  /** Marks local edits for the next merged flush. */
  markLocalChange() {
    this.dirty = true;
    this.scheduleFlush();
  }

  pause() {
    this.activeGeneration++;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.socket?.close(1000, "Offline");
    this.socket = null;
    this.releaseSentVersion();
    this.options.onState?.("offline");
  }

  private handleMessage(data: ArrayBuffer | string) {
    if (typeof data == "string") {
      this.handleControlMessage(data);
      return;
    }

    let messages;
    try {
      messages = decodeWireFrame(data);
    } catch {
      this.socket?.close(clientCloseCodeMalformed, "Malformed collaboration frame");
      return;
    }
    for (let message of messages) {
      if (message.kind == WireKind.Doc || message.kind == WireKind.Snapshot) {
        this.options.doc.import(message.payload);
      }
    }
    if (this.sentVersion && !this.dirty) this.advanceSentVersion();
  }

  private handleControlMessage(data: string) {
    let message: { type?: unknown; versionVector?: unknown };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      this.socket?.close(clientCloseCodeMalformed, "Malformed control message");
      return;
    }
    if (message.type == "session-refresh-required") {
      this.sessionToken = null;
    } else if (message.type == "sync-ready") {
      let serverVersion = parseVersion(message.versionVector);
      if (!serverVersion) {
        this.socket?.close(clientCloseCodeMalformed, "Malformed sync metadata");
        return;
      }
      // Catch the relay up on anything it lacks (offline or restored edits).
      this.sentVersion = serverVersion;
      this.dirty = true;
      this.flush();
      this.options.onState?.("connected");
    }
  }

  private flush() {
    this.flushTimer = null;
    let socket = this.socket;
    if (!this.dirty || !this.sentVersion || socket?.readyState != WebSocket.OPEN) return;

    let doc = this.options.doc;
    let update = doc.export({ from: this.sentVersion, mode: "update" });
    let message =
      update.byteLength <= maxDocumentUpdateBytes
        ? { kind: WireKind.Doc, payload: update }
        : { kind: WireKind.Snapshot, payload: doc.export({ mode: "snapshot" }) };
    if (message.payload.byteLength > maxSnapshotBytes) {
      this.options.onState?.("unavailable", "Document is larger than the relay limit");
      this.close();
      return;
    }
    if (update.byteLength) {
      try {
        socket.send(encodeWireBatch([message]));
      } catch {
        socket.close();
        return;
      }
    }
    this.dirty = false;
    this.advanceSentVersion();
  }

  private advanceSentVersion() {
    this.releaseSentVersion();
    this.sentVersion = this.options.doc.oplogVersion();
  }

  private releaseSentVersion() {
    this.sentVersion?.free();
    this.sentVersion = null;
  }

  private scheduleFlush() {
    if (this.flushTimer != null || !this.sentVersion) return;
    this.flushTimer = window.setTimeout(() => this.flush(), flushIntervalMs);
  }

  private clearFlushTimer() {
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private isActive(generation: number, socket: WebSocket) {
    return this.activeGeneration == generation && this.socket == socket;
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer != null || navigator.onLine === false) return;
    let delay = Math.min(250 * 2 ** this.reconnectAttempt, 10_000);
    this.reconnectAttempt++;
    delay += crypto.getRandomValues(new Uint16Array(1))[0]! % 301;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
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

  private websocketUrl() {
    let path = `/api/shares/${encodeURIComponent(this.options.access.shareId)}/ws`;
    let url = new URL(path, this.options.origin);
    url.protocol = url.protocol == "http:" || url.protocol == "ws:" ? "ws:" : "wss:";
    url.search = new URLSearchParams({ clientId: this.options.clientId }).toString();
    return url.toString();
  }
}

function serializeVersion(doc: LoroDoc) {
  let version = doc.oplogVersion();
  try {
    return [...version.toJSON()].map(([peer, counter]) => [String(peer), counter]);
  } finally {
    version.free();
  }
}

function parseVersion(value: unknown) {
  if (!Array.isArray(value)) return null;
  let entries = new Map<`${number}`, number>();
  for (let entry of value) {
    if (!Array.isArray(entry) || entry.length != 2) return null;
    let [peer, counter] = entry as [unknown, unknown];
    if (typeof peer != "string" || !/^\d+$/.test(peer) || typeof counter != "number") return null;
    entries.set(peer as `${number}`, counter);
  }
  try {
    return new VersionVector(entries);
  } catch {
    return null;
  }
}

async function responseError(response: Response, fallback: string) {
  try {
    let body = (await response.json()) as { error?: unknown };
    if (typeof body.error == "string") return `${fallback}: ${body.error}`;
  } catch {
    // Fall through to the status-only message.
  }
  return `${fallback} (HTTP ${response.status})`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
