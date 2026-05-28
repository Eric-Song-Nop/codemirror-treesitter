import { DurableObject } from "cloudflare:workers";
import { LoroDoc } from "loro-crdt";
import {
  WireKind,
  decodeWireFrame,
  encodeWireBatch,
  encodeWireMessage,
  toUint8Array,
  type WireMessage,
} from "./protocol.ts";

type ConnectionAttachment = {
  clientId: string;
  joinedAt: number;
};

type ControlMessage = {
  type?: string;
};

const roomPattern = /^\/api\/doc\/([^/]+)\/ws$/;
const validRoomIdPattern = /^[A-Za-z0-9_-]{8,96}$/;
const validClientIdPattern = /^[A-Za-z0-9_-]{8,96}$/;
const snapshotKey = "snapshot";
const updatedAtKey = "updatedAt";
const schemaVersionKey = "schemaVersion";
const schemaVersion = 1;
const saveDebounceMs = 750;
const saveMaxWaitMs = 5000;
const maxRetryDelayMs = 30_000;

export class CollabRoom extends DurableObject<Env> {
  private dirty = false;
  private doc = new LoroDoc();
  private firstDirtyAt = 0;
  private maxSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 1000;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      let snapshot = await this.ctx.storage.get<Uint8Array | ArrayBuffer>(snapshotKey);
      if (snapshot) this.doc.import(toUint8Array(snapshot));
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    let url = new URL(request.url);
    let clientId = normalizeClientId(url.searchParams.get("clientId"));
    let pair = new WebSocketPair();
    let [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    let attachment: ConnectionAttachment = { clientId, joinedAt: Date.now() };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    server.send(encodeWireMessage(WireKind.Snapshot, this.doc.export({ mode: "snapshot" })));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message == "string") {
      this.handleControlMessage(ws, message);
      return;
    }

    let relay: WireMessage[] = [];
    let messages: WireMessage[];

    try {
      messages = decodeWireFrame(message);
    } catch (error: unknown) {
      console.warn("Dropping malformed collaboration frame", error);
      ws.close(1003, "Malformed collaboration frame");
      return;
    }

    for (let item of messages) {
      if (item.kind == WireKind.Doc || item.kind == WireKind.Snapshot) {
        this.doc.import(item.payload);
        this.markDirty();
        relay.push(item);
      } else if (item.kind == WireKind.Presence) {
        relay.push(item);
      }
    }

    if (relay.length) this.broadcast(ws, encodeWireBatch(relay));
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.flushSnapshot();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.flushSnapshot();
    ws.close(1011, "WebSocket error");
  }

  private broadcast(sender: WebSocket, frame: Uint8Array) {
    for (let socket of this.ctx.getWebSockets()) {
      if (socket == sender || socket.readyState != WebSocket.OPEN) continue;
      socket.send(frame);
    }
  }

  private clearSaveTimers() {
    if (this.saveTimer != null) clearTimeout(this.saveTimer);
    if (this.maxSaveTimer != null) clearTimeout(this.maxSaveTimer);
    this.saveTimer = null;
    this.maxSaveTimer = null;
  }

  private async flushSnapshot(): Promise<void> {
    if (this.saving) return;
    this.clearSaveTimers();
    if (!this.dirty) return;

    this.saving = true;
    this.dirty = false;

    try {
      let snapshot = this.doc.export({ mode: "snapshot" });
      await Promise.all([
        this.ctx.storage.put(snapshotKey, snapshot),
        this.ctx.storage.put(updatedAtKey, Date.now()),
        this.ctx.storage.put(schemaVersionKey, schemaVersion),
      ]);
      this.firstDirtyAt = 0;
      this.retryDelayMs = 1000;
    } catch (error: unknown) {
      console.error("Failed to persist collaboration snapshot", error);
      this.dirty = true;
      this.scheduleRetrySave();
    } finally {
      this.saving = false;
      if (this.dirty && this.saveTimer == null && this.maxSaveTimer == null) {
        this.scheduleSave();
      }
    }
  }

  private handleControlMessage(ws: WebSocket, message: string) {
    let control: ControlMessage;
    try {
      control = JSON.parse(message) as ControlMessage;
    } catch {
      ws.close(1003, "Malformed control message");
      return;
    }

    if (control.type == "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }

  private markDirty() {
    this.dirty = true;
    this.scheduleSave();
  }

  private scheduleRetrySave() {
    let delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, maxRetryDelayMs);
    this.saveTimer = setTimeout(() => void this.flushSnapshot(), delay);
  }

  private scheduleSave() {
    let now = Date.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = now;

    if (this.saveTimer != null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flushSnapshot(), saveDebounceMs);

    if (this.maxSaveTimer == null) {
      let elapsed = now - this.firstDirtyAt;
      let maxDelay = Math.max(0, saveMaxWaitMs - elapsed);
      this.maxSaveTimer = setTimeout(() => void this.flushSnapshot(), maxDelay);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let url = new URL(request.url);
    let match = roomPattern.exec(url.pathname);

    if (!match) return new Response("Not Found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    let roomId = decodeURIComponent(match[1]!);
    if (!validRoomIdPattern.test(roomId)) return new Response("Invalid room id", { status: 400 });

    return env.COLLAB_ROOMS.getByName(roomId).fetch(request);
  },
};

function normalizeClientId(value: string | null): string {
  if (value && validClientIdPattern.test(value)) return value;
  return crypto.randomUUID();
}
