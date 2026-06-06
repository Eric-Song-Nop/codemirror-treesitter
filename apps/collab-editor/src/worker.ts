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
import { createInitialDocument, shouldSeedInitialDocument } from "./initial-document.ts";
import {
  createSessionToken,
  decodeBase64,
  hashShareSecret,
  isShareActive,
  isShareCleanupDue,
  isValidShareId,
  parseCreateSessionRequest,
  parseCreateShareRequest,
  parseRevokeShareRequest,
  parseRotateShareRequest,
  shareCleanupDueAt,
  shareSchemaVersion,
  shareSessionTtlMs,
  timingSafeEqualString,
  type ShareRecord,
  type ShareRole,
  type ShareSessionRecord,
} from "./share.ts";
import {
  maxCreateShareBodyBytes,
  maxShareControlBodyBytes,
  maxShareGuestPeers,
  maxShareSessions,
  maxSnapshotBytes,
  maxUpdateFrameBurst,
  maxUpdateFramesPerMinute,
  validateWireFrameLimits,
} from "./share-limits.ts";

type ConnectionAttachment = {
  clientId: string;
  joinedAt: number;
  role?: ShareRole;
  secretHash?: string;
  updateTokens?: number;
  updateTokensAt?: number;
};

type ControlMessage = {
  type?: string;
};

const roomPattern = /^\/api\/doc\/([^/]+)\/ws$/;
const createSharePattern = /^\/api\/shares\/?$/;
const sharePattern = /^\/api\/shares\/([^/]+)(?:\/(session|rotate|revoke|ws))?\/?$/;
const validRoomIdPattern = /^[A-Za-z0-9_-]{8,96}$/;
const validClientIdPattern = /^[A-Za-z0-9_-]{8,96}$/;
const snapshotKey = "snapshot";
const shareRecordKey = "share";
const pendingHostSaveKey = "pendingHostSave";
const updatedAtKey = "updatedAt";
const initializedAtKey = "initializedAt";
const schemaVersionKey = "schemaVersion";
const sessionKeyPrefix = "session:";
const schemaVersion = 1;
const saveDebounceMs = 750;
const saveMaxWaitMs = 5000;
const maxRetryDelayMs = 30_000;
const markdownTextKey = "markdown";
const shareSocketTag = "share";
const requestBodyTooLarge = Symbol("requestBodyTooLarge");

export class CollabRoom extends DurableObject<Env> {
  private dirty = false;
  private doc = new LoroDoc();
  private firstDirtyAt = 0;
  private initialized = false;
  private maxSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 1000;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private pendingHostSave = false;
  private shareRecord: ShareRecord | null = null;
  private sockets = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      let [snapshot, initializedAt, shareRecord, pendingHostSave] = await Promise.all([
        this.ctx.storage.get<Uint8Array | ArrayBuffer>(snapshotKey),
        this.ctx.storage.get<number>(initializedAtKey),
        this.ctx.storage.get<ShareRecord>(shareRecordKey),
        this.ctx.storage.get<boolean>(pendingHostSaveKey),
      ]);
      if (snapshot) this.doc.import(toUint8Array(snapshot));
      this.initialized = initializedAt != null || snapshot != null;
      this.shareRecord = shareRecord ?? null;
      this.pendingHostSave = pendingHostSave ?? false;
      await this.scheduleShareMaintenance();
    });
  }

  async alarm(): Promise<void> {
    await this.refreshShareRecord();
    let share = this.shareRecord;
    if (!share) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (!isShareCleanupDue(share)) {
      if (!isShareActive(share)) {
        this.broadcastShareStatus();
        this.enforceShareSocketAuthorization();
      }
      await this.scheduleShareMaintenance();
      return;
    }

    await this.cleanupShareState();
  }

  async fetch(request: Request): Promise<Response> {
    let url = new URL(request.url);
    if (url.pathname.startsWith("/api/shares/")) return this.fetchShare(request, url);

    if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    let clientId = normalizeClientId(url.searchParams.get("clientId"));
    let roomId = roomIdFromRequestPath(url.pathname);
    if (!roomId) return new Response("Invalid room id", { status: 400 });
    if (this.shareRecord) return new Response("Share session required", { status: 403 });
    await this.ensureInitialized(request, roomId, url.searchParams.get("hasLocalSnapshot") == "1");

    let pair = new WebSocketPair();
    let [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    let attachment: ConnectionAttachment = { clientId, joinedAt: Date.now() };

    this.ctx.acceptWebSocket(server);
    this.sockets.add(server);
    server.serializeAttachment(attachment);
    server.send(encodeWireMessage(WireKind.Snapshot, this.doc.export({ mode: "snapshot" })));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async fetchShare(request: Request, url: URL): Promise<Response> {
    let share = shareFromPath(url.pathname);
    if (!share) return jsonResponse({ error: "Invalid share id" }, 400, request);

    if (!share.action && request.method == "POST") {
      return this.handleCreateShare(request, share.shareId);
    }
    if (share.action == "session" && request.method == "POST") {
      return this.handleCreateShareSession(request, share.shareId);
    }
    if (share.action == "rotate" && request.method == "POST") {
      return this.handleRotateShare(request);
    }
    if (share.action == "revoke" && request.method == "POST") {
      return this.handleRevokeShare(request);
    }
    if (share.action == "ws") return this.handleShareWebSocket(request, url);

    return jsonResponse({ error: "Not found" }, 404, request);
  }

  private async handleCreateShare(request: Request, shareId: string): Promise<Response> {
    let json = await readJson(request, maxCreateShareBodyBytes);
    if (json === requestBodyTooLarge)
      return jsonResponse({ error: "Request too large" }, 413, request);

    let body = parseCreateShareRequest(json);
    if (!body || body.shareId != shareId)
      return jsonResponse({ error: "Invalid share" }, 400, request);
    if (this.shareRecord || this.initialized) {
      return jsonResponse({ error: "Share already exists" }, 409, request);
    }

    let snapshot = decodeBase64(body.snapshot);
    if (!snapshot) return jsonResponse({ error: "Invalid snapshot" }, 400, request);
    if (snapshot.byteLength > maxSnapshotBytes) {
      return jsonResponse({ error: "Snapshot too large" }, 413, request);
    }

    let nextDoc = new LoroDoc();
    try {
      nextDoc.import(snapshot);
    } catch {
      return jsonResponse({ error: "Invalid snapshot" }, 400, request);
    }

    let now = Date.now();
    let record: ShareRecord = {
      createdAt: now,
      displayName: body.displayName,
      expiresAt: body.expiresAt,
      guestSecretHash: body.guestSecretHash,
      hostSecretHash: body.hostSecretHash,
      schemaVersion: shareSchemaVersion,
      shareId,
    };

    this.doc = nextDoc;
    this.shareRecord = record;
    this.initialized = true;
    this.pendingHostSave = false;

    await Promise.all([
      this.ctx.storage.put(shareRecordKey, record),
      this.ctx.storage.put(pendingHostSaveKey, false),
      this.ctx.storage.put(snapshotKey, snapshot),
      this.ctx.storage.put(updatedAtKey, now),
      this.ctx.storage.put(initializedAtKey, now),
      this.ctx.storage.put(schemaVersionKey, schemaVersion),
    ]);
    await this.scheduleShareMaintenance();

    return jsonResponse(
      {
        displayName: record.displayName,
        expiresAt: record.expiresAt,
        shareId: record.shareId,
      },
      201,
      request,
    );
  }

  private async handleCreateShareSession(request: Request, shareId: string): Promise<Response> {
    let share = this.activeShareRecord();
    if (!share || share.shareId != shareId)
      return jsonResponse({ error: "Share unavailable" }, 404, request);

    let json = await readJson(request, maxShareControlBodyBytes);
    if (json === requestBodyTooLarge)
      return jsonResponse({ error: "Request too large" }, 413, request);

    let body = parseCreateSessionRequest(json);
    if (!body) return jsonResponse({ error: "Invalid session" }, 400, request);

    let secretHash = await hashShareSecret(body.secret);
    let expectedHash = body.role == "host" ? share.hostSecretHash : share.guestSecretHash;
    if (!timingSafeEqualString(secretHash, expectedHash)) {
      return jsonResponse({ error: "Invalid session" }, 403, request);
    }
    if (body.role == "guest" && this.shareSocketCount("guest") >= maxShareGuestPeers) {
      return jsonResponse({ error: "Share is full" }, 429, request);
    }
    if ((await this.activeShareSessionCount()) >= maxShareSessions) {
      return jsonResponse({ error: "Too many active sessions" }, 429, request);
    }

    let sessionToken = createSessionToken();
    let expiresAt = Date.now() + shareSessionTtlMs;
    let session: ShareSessionRecord = {
      clientId: normalizeClientId(null),
      expiresAt,
      role: body.role,
      secretHash,
    };
    await this.ctx.storage.put(sessionKey(await hashShareSecret(sessionToken)), session);

    return jsonResponse(
      {
        displayName: share.displayName,
        expiresAt,
        guestCount: this.shareSocketCount("guest"),
        hostOnline: this.hasHostSocket(),
        peerCount: this.shareSocketCount(),
        pendingHostSave: this.pendingHostSave,
        role: body.role,
        sessionToken,
        shareExpiresAt: share.expiresAt,
        shareId: share.shareId,
      },
      201,
      request,
    );
  }

  private async handleRotateShare(request: Request): Promise<Response> {
    let share = this.activeShareRecord();
    if (!share) return jsonResponse({ error: "Share unavailable" }, 404, request);

    let json = await readJson(request, maxShareControlBodyBytes);
    if (json === requestBodyTooLarge)
      return jsonResponse({ error: "Request too large" }, 413, request);

    let body = parseRotateShareRequest(json);
    if (!body) return jsonResponse({ error: "Invalid rotate request" }, 400, request);
    if (!(await this.verifyHostSecret(share, body.hostSecret))) {
      return jsonResponse({ error: "Invalid host secret" }, 403, request);
    }

    let next: ShareRecord = {
      ...share,
      expiresAt: body.expiresAt === undefined ? share.expiresAt : body.expiresAt,
      guestSecretHash: body.nextGuestSecretHash,
    };
    this.shareRecord = next;
    await this.ctx.storage.put(shareRecordKey, next);
    await this.scheduleShareMaintenance();
    this.broadcastShareStatus();
    this.closeShareSockets(1008, "Share link rotated");

    return jsonResponse({ expiresAt: next.expiresAt, shareId: next.shareId }, 200, request);
  }

  private async handleRevokeShare(request: Request): Promise<Response> {
    let share = this.shareRecord;
    if (!share) return jsonResponse({ error: "Share unavailable" }, 404, request);

    let json = await readJson(request, maxShareControlBodyBytes);
    if (json === requestBodyTooLarge)
      return jsonResponse({ error: "Request too large" }, 413, request);

    let body = parseRevokeShareRequest(json);
    if (!body) return jsonResponse({ error: "Invalid revoke request" }, 400, request);
    if (!(await this.verifyHostSecret(share, body.hostSecret))) {
      return jsonResponse({ error: "Invalid host secret" }, 403, request);
    }

    let next: ShareRecord = { ...share, revokedAt: Date.now() };
    this.shareRecord = next;
    await this.ctx.storage.put(shareRecordKey, next);
    await this.scheduleShareMaintenance();
    this.broadcastShareStatus();
    this.closeShareSockets(1008, "Sharing stopped");

    return jsonResponse({ revokedAt: next.revokedAt, shareId: next.shareId }, 200, request);
  }

  private async handleShareWebSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    let share = this.activeShareRecord();
    if (!share) return new Response("Share unavailable", { status: 404 });

    let session = await this.validateShareSession(url.searchParams.get("sessionToken"));
    if (!session) return new Response("Invalid session", { status: 403 });
    if (session.role == "guest" && this.shareSocketCount("guest") >= maxShareGuestPeers) {
      return new Response("Share is full", { status: 429 });
    }

    let pair = new WebSocketPair();
    let [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    let attachment: ConnectionAttachment = {
      clientId: normalizeClientId(url.searchParams.get("clientId")),
      joinedAt: Date.now(),
      role: session.role,
      secretHash: session.secretHash,
      updateTokens: maxUpdateFrameBurst,
      updateTokensAt: Date.now(),
    };

    this.ctx.acceptWebSocket(server, [shareSocketTag, session.role]);
    this.sockets.add(server);
    server.serializeAttachment(attachment);
    server.send(encodeWireMessage(WireKind.ShareStatus, this.shareStatusPayload()));
    server.send(encodeWireMessage(WireKind.Snapshot, this.doc.export({ mode: "snapshot" })));
    this.broadcastShareStatus(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message == "string") {
      this.handleControlMessage(ws, message);
      return;
    }
    if (this.socketRole(ws)) await this.refreshShareRecord();
    if (!this.ensureSocketShareAuthorization(ws)) return;

    let relay: WireMessage[] = [];
    let documentChanged = false;
    let hostSaveAcked = false;
    let relayAckSequence: number | null = null;
    let messages: WireMessage[];

    let frame = toUint8Array(message);
    try {
      messages = decodeWireFrame(frame);
    } catch (error: unknown) {
      console.warn("Dropping malformed collaboration frame", error);
      ws.close(1003, "Malformed collaboration frame");
      return;
    }
    let limits = validateWireFrameLimits(frame.byteLength, messages);
    if (!limits.ok) {
      ws.close(limits.closeCode, limits.reason);
      return;
    }

    for (let item of messages) {
      if (item.kind == WireKind.Doc || item.kind == WireKind.Snapshot) {
        if (item.kind == WireKind.Doc && !this.consumeUpdateToken(ws)) {
          ws.close(1008, "Document update rate limit exceeded");
          return;
        }
        try {
          this.doc.import(item.payload);
        } catch (error: unknown) {
          console.warn("Dropping malformed Loro payload", error);
          ws.close(1003, "Malformed collaboration payload");
          return;
        }
        this.initialized = true;
        documentChanged = this.shareRecord != null;
        this.markDirty();
        relay.push(item);
      } else if (item.kind == WireKind.Presence) {
        relay.push(item);
      } else if (item.kind == WireKind.HostSaveAck) {
        if (this.socketRole(ws) != "host") {
          ws.close(1008, "Host authorization required");
          return;
        }
        hostSaveAcked = true;
        relay.push(item);
      } else if (item.kind == WireKind.RelayAckRequest) {
        let sequence = parseRelayAckRequest(item.payload);
        if (sequence == null) {
          ws.close(1003, "Malformed relay ack request");
          return;
        }
        relayAckSequence = Math.max(relayAckSequence ?? 0, sequence);
      }
    }

    if (relay.length) this.broadcast(ws, encodeWireBatch(relay));
    if (this.shareRecord && (documentChanged || hostSaveAcked)) {
      await this.setPendingHostSave(documentChanged && !hostSaveAcked);
      this.broadcastShareStatus();
    }
    if (relayAckSequence != null) this.sendRelayAck(ws, relayAckSequence);
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.sockets.delete(ws);
    await this.flushSnapshot();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.sockets.delete(ws);
    await this.flushSnapshot();
    ws.close(1011, "WebSocket error");
  }

  private broadcast(sender: WebSocket, frame: Uint8Array) {
    let sockets = this.shareRecord ? this.shareSockets() : this.ctx.getWebSockets();
    for (let socket of sockets) {
      if (socket == sender || socket.readyState != WebSocket.OPEN) continue;
      if (!this.ensureSocketShareAuthorization(socket)) continue;
      socket.send(frame);
    }
  }

  private broadcastShareStatus(sender?: WebSocket) {
    if (!this.shareRecord) return;
    let frame = encodeWireMessage(WireKind.ShareStatus, this.shareStatusPayload());
    for (let socket of this.shareSockets()) {
      if (socket == sender || socket.readyState != WebSocket.OPEN) continue;
      if (!this.ensureSocketShareAuthorization(socket)) continue;
      socket.send(frame);
    }
  }

  private sendRelayAck(socket: WebSocket, sequence: number) {
    if (socket.readyState != WebSocket.OPEN) return;
    socket.send(
      encodeWireMessage(
        WireKind.RelayAck,
        new TextEncoder().encode(
          JSON.stringify({
            acceptedAt: Date.now(),
            sequence,
            shareId: this.shareRecord?.shareId ?? "",
          }),
        ),
      ),
    );
  }

  private activeShareRecord() {
    return this.shareRecord && isShareActive(this.shareRecord) ? this.shareRecord : null;
  }

  private async refreshShareRecord() {
    this.shareRecord = (await this.ctx.storage.get<ShareRecord>(shareRecordKey)) ?? null;
  }

  private async scheduleShareMaintenance() {
    if (!this.shareRecord) {
      return;
    }

    let alarmAt = this.nextShareMaintenanceAt();
    if (alarmAt == null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(Math.max(Date.now(), alarmAt));
  }

  private nextShareMaintenanceAt() {
    let share = this.shareRecord;
    if (!share) return null;
    let now = Date.now();
    if (share.revokedAt == null && share.expiresAt != null && share.expiresAt > now) {
      return share.expiresAt;
    }
    return shareCleanupDueAt(share);
  }

  private async cleanupShareState() {
    this.clearSaveTimers();
    this.closeShareSockets(1008, "Share retention expired");

    let sessionRecords = await this.ctx.storage.list({ prefix: sessionKeyPrefix });
    await this.ctx.storage.delete([
      shareRecordKey,
      pendingHostSaveKey,
      snapshotKey,
      updatedAtKey,
      initializedAtKey,
      schemaVersionKey,
      ...sessionRecords.keys(),
    ]);
    await this.ctx.storage.deleteAlarm();

    this.dirty = false;
    this.doc = new LoroDoc();
    this.firstDirtyAt = 0;
    this.initialized = false;
    this.pendingHostSave = false;
    this.retryDelayMs = 1000;
    this.saving = false;
    this.shareRecord = null;
  }

  private closeShareSockets(code: number, reason: string) {
    for (let socket of this.shareSockets()) {
      socket.close(code, reason);
    }
    for (let socket of this.shareSockets()) this.sockets.delete(socket);
  }

  private shareSockets() {
    return new Set(
      [...this.ctx.getWebSockets(shareSocketTag), ...this.sockets].filter((socket) =>
        Boolean(this.socketRole(socket)),
      ),
    );
  }

  private hasHostSocket() {
    return this.shareSocketCount("host") > 0;
  }

  private shareSocketCount(role?: ShareRole) {
    let count = 0;
    for (let socket of this.shareSockets()) {
      if (socket.readyState != WebSocket.OPEN) continue;
      let socketRole = this.socketRole(socket);
      if (!socketRole) continue;
      if (role == null || socketRole == role) count++;
    }
    return count;
  }

  private shareStatusPayload(overrides: { revokedAt?: number | null } = {}) {
    let share = this.shareRecord;
    let guestCount = this.shareSocketCount("guest");
    let hostOnline = this.hasHostSocket();
    return new TextEncoder().encode(
      JSON.stringify({
        displayName: share?.displayName ?? "",
        expiresAt: share?.expiresAt ?? null,
        guestCount,
        hostOnline,
        peerCount: guestCount + (hostOnline ? 1 : 0),
        pendingHostSave: this.pendingHostSave,
        revokedAt: overrides.revokedAt ?? share?.revokedAt ?? null,
        shareId: share?.shareId ?? "",
      }),
    );
  }

  private async setPendingHostSave(value: boolean) {
    if (this.pendingHostSave == value) return;
    await this.ctx.storage.put(pendingHostSaveKey, value);
    this.pendingHostSave = value;
  }

  private socketRole(socket: WebSocket) {
    return (socket.deserializeAttachment() as ConnectionAttachment | undefined)?.role;
  }

  private enforceShareSocketAuthorization() {
    for (let socket of this.shareSockets()) {
      if (socket.readyState != WebSocket.OPEN) continue;
      this.ensureSocketShareAuthorization(socket);
    }
  }

  private ensureSocketShareAuthorization(socket: WebSocket) {
    let attachment = socket.deserializeAttachment() as ConnectionAttachment | undefined;
    if (!this.shareRecord) return true;
    if (!attachment?.role || !attachment.secretHash) {
      socket.close(1008, "Share session required");
      return false;
    }

    let share = this.shareRecord;
    let expectedHash =
      attachment.role == "host" ? share?.hostSecretHash : this.activeShareRecord()?.guestSecretHash;
    if (
      attachment.secretHash &&
      expectedHash &&
      timingSafeEqualString(attachment.secretHash, expectedHash)
    ) {
      return true;
    }

    if (socket.readyState == WebSocket.OPEN) {
      socket.send(
        encodeWireMessage(WireKind.ShareStatus, this.shareStatusPayload({ revokedAt: Date.now() })),
      );
    }
    socket.close(1008, "Share session is no longer valid");
    return false;
  }

  private async validateShareSession(sessionToken: string | null) {
    let share = this.activeShareRecord();
    if (!share || !sessionToken) return null;

    let session = await this.ctx.storage.get<ShareSessionRecord>(
      sessionKey(await hashShareSecret(sessionToken)),
    );
    if (!session || session.expiresAt <= Date.now()) return null;

    let expectedHash = session.role == "host" ? share.hostSecretHash : share.guestSecretHash;
    if (!timingSafeEqualString(session.secretHash, expectedHash)) return null;
    return session;
  }

  private async activeShareSessionCount() {
    let now = Date.now();
    let sessions = await this.ctx.storage.list<ShareSessionRecord>({ prefix: sessionKeyPrefix });
    let expiredKeys: string[] = [];
    let count = 0;

    for (let [key, session] of sessions) {
      if (session.expiresAt <= now) expiredKeys.push(key);
      else count++;
    }
    if (expiredKeys.length) await this.ctx.storage.delete(expiredKeys);
    return count;
  }

  private consumeUpdateToken(socket: WebSocket) {
    let attachment = socket.deserializeAttachment() as ConnectionAttachment | undefined;
    if (!attachment) return false;

    let now = Date.now();
    let previousTokens = attachment.updateTokens ?? maxUpdateFrameBurst;
    let previousAt = attachment.updateTokensAt ?? now;
    let refill = ((now - previousAt) / 60_000) * maxUpdateFramesPerMinute;
    let nextTokens = Math.min(maxUpdateFrameBurst, previousTokens + refill);
    if (nextTokens < 1) {
      socket.serializeAttachment({ ...attachment, updateTokens: nextTokens, updateTokensAt: now });
      return false;
    }

    socket.serializeAttachment({
      ...attachment,
      updateTokens: nextTokens - 1,
      updateTokensAt: now,
    });
    return true;
  }

  private async verifyHostSecret(share: ShareRecord, hostSecret: string) {
    return timingSafeEqualString(await hashShareSecret(hostSecret), share.hostSecretHash);
  }

  private clearSaveTimers() {
    if (this.saveTimer != null) clearTimeout(this.saveTimer);
    if (this.maxSaveTimer != null) clearTimeout(this.maxSaveTimer);
    this.saveTimer = null;
    this.maxSaveTimer = null;
  }

  private async ensureInitialized(
    request: Request,
    roomId: string,
    hasLocalSnapshot: boolean,
  ): Promise<void> {
    if (this.initialized) return;
    let markdown = this.doc.getText(markdownTextKey);
    let shouldSeed = shouldSeedInitialDocument({
      docValue: markdown.toString(),
      editorValue: "",
      generatedRoom: true,
      hasLocalSnapshot,
    });
    if (!shouldSeed && hasLocalSnapshot) return;

    this.initialized = true;
    if (shouldSeed) {
      markdown.insert(0, createInitialDocument(roomShareUrl(request, roomId)));
      this.doc.commit();
    }

    let now = Date.now();
    try {
      await Promise.all([
        this.ctx.storage.put(initializedAtKey, now),
        this.ctx.storage.put(snapshotKey, this.doc.export({ mode: "snapshot" })),
        this.ctx.storage.put(updatedAtKey, now),
        this.ctx.storage.put(schemaVersionKey, schemaVersion),
      ]);
      this.dirty = false;
      this.firstDirtyAt = 0;
      this.retryDelayMs = 1000;
    } catch (error: unknown) {
      console.error("Failed to persist initial collaboration snapshot", error);
      this.dirty = true;
      this.scheduleRetrySave();
    }
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
        this.ctx.storage.put(initializedAtKey, Date.now()),
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
    if (request.method == "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { headers: corsHeaders(request) });
    }

    if (createSharePattern.test(url.pathname) && request.method == "POST") {
      let json = await readJson(request, maxCreateShareBodyBytes);
      if (json === requestBodyTooLarge)
        return jsonResponse({ error: "Request too large" }, 413, request);

      let body = parseCreateShareRequest(json);
      if (!body) return jsonResponse({ error: "Invalid share" }, 400, request);

      let shareUrl = new URL(`/api/shares/${encodeURIComponent(body.shareId)}`, url);
      return env.COLLAB_ROOMS.getByName(body.shareId).fetch(
        new Request(shareUrl, {
          body: JSON.stringify(body),
          headers: forwardedJsonHeaders(request),
          method: "POST",
        }),
      );
    }

    let share = shareFromPath(url.pathname);
    if (share) return env.COLLAB_ROOMS.getByName(share.shareId).fetch(request);

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

function shareFromPath(pathname: string) {
  let match = sharePattern.exec(pathname);
  if (!match) return null;

  let shareId = decodeURIComponent(match[1]!);
  if (!isValidShareId(shareId)) return null;
  return {
    action: match[2] as "revoke" | "rotate" | "session" | "ws" | undefined,
    shareId,
  };
}

function sessionKey(tokenHash: string) {
  return `${sessionKeyPrefix}${tokenHash}`;
}

function parseRelayAckRequest(payload: Uint8Array) {
  try {
    let value = JSON.parse(new TextDecoder().decode(payload)) as { sequence?: unknown };
    if (
      typeof value.sequence != "number" ||
      !Number.isFinite(value.sequence) ||
      value.sequence < 1
    ) {
      return null;
    }
    return Math.trunc(value.sequence);
  } catch {
    return null;
  }
}

async function readJson(request: Request, maxBytes: number) {
  let declaredLength = request.headers.get("Content-Length");
  if (declaredLength != null && Number(declaredLength) > maxBytes) return requestBodyTooLarge;

  let body = await readTextBody(request, maxBytes);
  if (body === requestBodyTooLarge) return requestBodyTooLarge;

  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function readTextBody(request: Request, maxBytes: number) {
  if (!request.body) return "";

  let reader = request.body.getReader();
  let decoder = new TextDecoder();
  let byteLength = 0;
  let chunks = "";

  for (;;) {
    let { done, value } = await reader.read();
    if (done) break;

    let chunk = value!;
    byteLength += chunk.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      return requestBodyTooLarge;
    }
    chunks += decoder.decode(chunk, { stream: true });
  }

  chunks += decoder.decode();
  return chunks;
}

function forwardedJsonHeaders(request: Request) {
  let headers = new Headers({ "Content-Type": "application/json" });
  let origin = request.headers.get("Origin");
  if (origin) headers.set("Origin", origin);
  return headers;
}

function jsonResponse(value: unknown, status: number, request: Request) {
  return Response.json(value, {
    headers: corsHeaders(request),
    status,
  });
}

function corsHeaders(request: Request) {
  let origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": origin || "*",
    Vary: "Origin",
  };
}

function roomIdFromRequestPath(pathname: string): string | null {
  let match = roomPattern.exec(pathname);
  if (!match) return null;

  let roomId = decodeURIComponent(match[1]!);
  return validRoomIdPattern.test(roomId) ? roomId : null;
}

function roomShareUrl(request: Request, roomId: string): string {
  let url = publicAppUrlFromRequest(request);
  url.pathname = "/";
  url.search = "";
  url.hash = roomId;
  return url.toString();
}

function publicAppUrlFromRequest(request: Request): URL {
  let origin = request.headers.get("Origin");
  if (origin != null) {
    try {
      let url = new URL(origin);
      if (url.protocol == "http:" || url.protocol == "https:") return url;
    } catch {
      // Fall through to the request URL.
    }
  }

  return new URL(request.url);
}
