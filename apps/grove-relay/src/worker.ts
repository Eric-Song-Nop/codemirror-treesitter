import { DurableObject } from "cloudflare:workers";
import { LoroDoc, VersionVector } from "loro-crdt";
import {
  WireKind,
  decodeWireFrame,
  encodeWireBatch,
  encodeWireMessage,
  toUint8Array,
  type WireMessage,
} from "./protocol.ts";
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
  maxDocumentUpdateBytes,
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
  pendingShareAuth?: boolean;
  role?: ShareRole;
  secretHash?: string;
  updateTokens?: number;
  updateTokensAt?: number;
};

type ControlMessage = {
  clientId?: unknown;
  sessionToken?: unknown;
  type?: string;
  versionVector?: unknown;
};

type GroveMetricEvent =
  | "frame_limit"
  | "loro_update"
  | "malformed_control"
  | "malformed_frame"
  | "malformed_loro_payload"
  | "pending_host_save"
  | "persist_failure"
  | "rate_limit"
  | "session_create"
  | "share_cleanup"
  | "share_create"
  | "share_revoke"
  | "share_rotate"
  | "snapshot_too_large"
  | "snapshot_update"
  | "ws_accept"
  | "ws_auth_failed"
  | "ws_close"
  | "ws_error"
  | "ws_join";

type GroveMetricValues = {
  bytes?: number;
  closeCode?: number;
  count?: number;
  guestCount?: number;
  peerCount?: number;
  reason?: string;
  role?: ShareRole;
  shareId?: string;
};

const createSharePattern = /^\/api\/shares\/?$/;
const sharePattern = /^\/api\/shares\/([^/]+)(?:\/(session|rotate|revoke|ws))?\/?$/;
const validClientIdPattern = /^[A-Za-z0-9_-]{8,96}$/;
const snapshotKey = "snapshot";
const shareRecordKey = "share";
const pendingHostSaveKey = "pendingHostSave";
const updatedAtKey = "updatedAt";
const initializedAtKey = "initializedAt";
const schemaVersionKey = "schemaVersion";
const sessionKeyPrefix = "session:";
const updateLogEntryPrefix = "update:";
const updateLogBytesKey = "updateLogBytes";
const updateLogSequenceKey = "updateLogSequence";
const schemaVersion = 1;
const saveDebounceMs = 750;
const saveMaxWaitMs = 5000;
const maxRetryDelayMs = 30_000;
const shareSocketTag = "share";
const shareAuthTimeoutMs = 10_000;
const shareStatusBroadcastMinIntervalMs = 250;
const maxAuthVersionVectorEntries = 128;
const maxStoredUpdateLogBytes = maxSnapshotBytes;
const maxStoredUpdateLogEntries = 256;
const requestBodyTooLarge = Symbol("requestBodyTooLarge");

export class GroveShareRoom extends DurableObject<Env> {
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
  private shareStatusTimer: ReturnType<typeof setTimeout> | null = null;
  private lastShareStatusBroadcastAt = 0;
  private sockets = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      let [snapshot, initializedAt, shareRecord, pendingHostSave, updateLog] = await Promise.all([
        this.ctx.storage.get<Uint8Array | ArrayBuffer>(snapshotKey),
        this.ctx.storage.get<number>(initializedAtKey),
        this.ctx.storage.get<ShareRecord>(shareRecordKey),
        this.ctx.storage.get<boolean>(pendingHostSaveKey),
        this.ctx.storage.list<Uint8Array | ArrayBuffer>({ prefix: updateLogEntryPrefix }),
      ]);
      if (snapshot) this.doc.import(toUint8Array(snapshot));
      let updates = [...updateLog.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, update]) => toUint8Array(update));
      if (updates.length) this.doc.importBatch(updates);
      this.initialized = initializedAt != null || snapshot != null || updates.length > 0;
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

    return new Response("Not Found", { status: 404 });
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
    this.writeMetric("share_create", { bytes: snapshot.byteLength, shareId });

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
    this.writeMetric("session_create", {
      guestCount: this.shareSocketCount("guest"),
      peerCount: this.shareSocketCount(),
      role: body.role,
    });

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
    this.broadcastShareStatus(undefined, { immediate: true });
    this.closeShareSockets(1008, "Share link rotated");
    this.writeMetric("share_rotate", { shareId: next.shareId });

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
    this.broadcastShareStatus(undefined, { immediate: true });
    this.closeShareSockets(1008, "Sharing stopped");
    this.writeMetric("share_revoke", { shareId: next.shareId });

    return jsonResponse({ revokedAt: next.revokedAt, shareId: next.shareId }, 200, request);
  }

  private async handleShareWebSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    let share = this.activeShareRecord();
    if (!share) return new Response("Share unavailable", { status: 404 });

    let pair = new WebSocketPair();
    let [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    let attachment: ConnectionAttachment = {
      clientId: normalizeClientId(url.searchParams.get("clientId")),
      joinedAt: Date.now(),
      pendingShareAuth: true,
    };

    this.ctx.acceptWebSocket(server, [shareSocketTag]);
    this.sockets.add(server);
    server.serializeAttachment(attachment);
    this.writeMetric("ws_accept", { peerCount: this.shareSocketCount() });
    setTimeout(() => {
      if (server.readyState != WebSocket.OPEN) return;
      let next = server.deserializeAttachment() as ConnectionAttachment | undefined;
      if (next?.pendingShareAuth) server.close(1008, "Share authentication required");
    }, shareAuthTimeoutMs);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message == "string") {
      if (new TextEncoder().encode(message).byteLength > maxShareControlBodyBytes) {
        this.writeMetric("frame_limit", { reason: "control_message_too_large" });
        ws.close(1009, "Control message too large");
        return;
      }
      await this.handleControlMessage(ws, message);
      return;
    }
    if (this.isPendingShareSocket(ws)) {
      ws.close(1008, "Share authentication required");
      return;
    }
    if (this.socketRole(ws)) await this.refreshShareRecord();
    if (!this.ensureSocketShareAuthorization(ws)) return;

    let relay: WireMessage[] = [];
    let acceptedDocumentUpdates: Uint8Array[] = [];
    let acceptedSnapshot: Uint8Array | null = null;
    let documentChanged = false;
    let hostSaveAcked = false;
    let messages: WireMessage[];

    let frame = toUint8Array(message);
    try {
      messages = decodeWireFrame(frame);
    } catch (error: unknown) {
      this.writeMetric("malformed_frame", { bytes: frame.byteLength, reason: "decode" });
      console.warn("Dropping malformed collaboration frame", error);
      ws.close(1003, "Malformed collaboration frame");
      return;
    }
    let limits = validateWireFrameLimits(frame.byteLength, messages);
    if (!limits.ok) {
      this.writeMetric(
        limits.reason == "Document snapshot is too large" ? "snapshot_too_large" : "frame_limit",
        {
          bytes: frame.byteLength,
          closeCode: limits.closeCode,
          count: messages.length,
          reason: limits.reason,
          role: this.socketRole(ws),
        },
      );
      ws.close(limits.closeCode, limits.reason);
      return;
    }

    for (let item of messages) {
      if (item.kind == WireKind.Doc || item.kind == WireKind.Snapshot) {
        if (item.kind == WireKind.Doc && !this.consumeUpdateToken(ws)) {
          this.writeMetric("rate_limit", { reason: "document_update", role: this.socketRole(ws) });
          ws.close(1008, "Document update rate limit exceeded");
          return;
        }
        let beforeVersion = this.doc.oplogVersion();
        try {
          this.doc.import(item.payload);
        } catch (error: unknown) {
          this.writeMetric("malformed_loro_payload", {
            bytes: item.payload.byteLength,
            role: this.socketRole(ws),
          });
          console.warn("Dropping malformed Loro payload", error);
          ws.close(1003, "Malformed collaboration payload");
          return;
        }
        let afterVersion = this.doc.oplogVersion();
        let changed = versionAdvanced(afterVersion, beforeVersion);
        if (this.shareRecord && !this.enforceDocumentSnapshotLimit(ws)) return;
        if (changed) {
          let relayItem = item;
          this.initialized = true;
          documentChanged = this.shareRecord != null;
          if (this.shareRecord) {
            if (item.kind == WireKind.Snapshot) acceptedSnapshot = item.payload;
            else {
              let acceptedUpdate = this.doc.export({ from: beforeVersion, mode: "update" });
              acceptedDocumentUpdates.push(acceptedUpdate);
              relayItem = { kind: WireKind.Doc, payload: acceptedUpdate };
            }
          } else {
            this.markDirty();
          }
          relay.push(relayItem);
        }
      } else if (item.kind == WireKind.Presence) {
        relay.push(item);
      } else if (item.kind == WireKind.HostSaveAck) {
        if (this.socketRole(ws) != "host") {
          ws.close(1008, "Host authorization required");
          return;
        }
        hostSaveAcked = true;
        relay.push(item);
      }
    }

    if (this.shareRecord && (documentChanged || hostSaveAcked)) {
      if (documentChanged) {
        try {
          if (acceptedSnapshot) {
            await this.persistShareSnapshot(acceptedSnapshot);
          } else {
            let updateLogBytes = await this.appendStoredDocumentUpdates(acceptedDocumentUpdates);
            if (updateLogBytes >= maxStoredUpdateLogBytes) {
              await this.flushSnapshot({ force: true });
            }
          }
        } catch (error: unknown) {
          this.writeMetric("persist_failure", { reason: "update_log" });
          console.error("Failed to persist shared file update log", error);
          ws.close(1011, "Failed to persist shared file update");
          return;
        }
        if (acceptedSnapshot) {
          this.writeMetric("snapshot_update", {
            bytes: acceptedSnapshot.byteLength,
            role: this.socketRole(ws),
          });
        } else if (acceptedDocumentUpdates.length) {
          this.writeMetric("loro_update", {
            bytes: sumByteLength(acceptedDocumentUpdates),
            count: acceptedDocumentUpdates.length,
            role: this.socketRole(ws),
          });
        }
      }
      if (relay.length) this.broadcast(ws, encodeWireBatch(relay));
      await this.setPendingHostSave(documentChanged && !hostSaveAcked);
      this.broadcastShareStatus();
    } else if (relay.length) {
      this.broadcast(ws, encodeWireBatch(relay));
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.sockets.delete(ws);
    this.writeMetric("ws_close", {
      closeCode: code,
      reason,
      role: this.socketRole(ws),
    });
    if (this.shareRecord) return;
    await this.flushSnapshot();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.sockets.delete(ws);
    this.writeMetric("ws_error", { role: this.socketRole(ws) });
    if (this.shareRecord) {
      ws.close(1011, "WebSocket error");
      return;
    }
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

  private broadcastShareStatus(sender?: WebSocket, options: { immediate?: boolean } = {}) {
    if (!this.shareRecord) return;
    if (options.immediate) {
      this.clearShareStatusTimer();
      this.sendShareStatus(sender);
      return;
    }

    let elapsed = Date.now() - this.lastShareStatusBroadcastAt;
    if (elapsed >= shareStatusBroadcastMinIntervalMs) {
      this.sendShareStatus(sender);
      return;
    }
    if (this.shareStatusTimer != null) return;
    this.shareStatusTimer = setTimeout(() => {
      this.shareStatusTimer = null;
      this.sendShareStatus();
    }, shareStatusBroadcastMinIntervalMs - elapsed);
  }

  private sendShareStatus(sender?: WebSocket) {
    if (!this.shareRecord) return;
    this.lastShareStatusBroadcastAt = Date.now();
    let frame = encodeWireMessage(WireKind.ShareStatus, this.shareStatusPayload());
    for (let socket of this.shareSockets()) {
      if (socket == sender || socket.readyState != WebSocket.OPEN) continue;
      if (!this.ensureSocketShareAuthorization(socket)) continue;
      socket.send(frame);
    }
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
    let shareId = this.shareRecord?.shareId;
    this.clearSaveTimers();
    this.clearShareStatusTimer();
    this.closeShareSockets(1008, "Share retention expired");

    let sessionRecords = await this.ctx.storage.list({ prefix: sessionKeyPrefix });
    let updateLogRecords = await this.ctx.storage.list({ prefix: updateLogEntryPrefix });
    await this.ctx.storage.delete([
      shareRecordKey,
      pendingHostSaveKey,
      snapshotKey,
      updatedAtKey,
      initializedAtKey,
      schemaVersionKey,
      updateLogBytesKey,
      updateLogSequenceKey,
      ...sessionRecords.keys(),
      ...updateLogRecords.keys(),
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
    this.writeMetric("share_cleanup", { shareId });
  }

  private closeShareSockets(code: number, reason: string) {
    let sockets = this.allShareTaggedSockets();
    for (let socket of sockets) {
      socket.close(code, reason);
    }
    for (let socket of sockets) this.sockets.delete(socket);
  }

  private shareSockets() {
    return new Set(
      [...this.allShareTaggedSockets()].filter((socket) => Boolean(this.socketRole(socket))),
    );
  }

  private allShareTaggedSockets() {
    return new Set([...this.ctx.getWebSockets(shareSocketTag), ...this.sockets]);
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
    if (value) this.writeMetric("pending_host_save");
  }

  private socketRole(socket: WebSocket) {
    return (socket.deserializeAttachment() as ConnectionAttachment | undefined)?.role;
  }

  private isPendingShareSocket(socket: WebSocket) {
    return Boolean(
      (socket.deserializeAttachment() as ConnectionAttachment | undefined)?.pendingShareAuth,
    );
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

  private clearShareStatusTimer() {
    if (this.shareStatusTimer != null) clearTimeout(this.shareStatusTimer);
    this.shareStatusTimer = null;
  }

  private async flushSnapshot(options: { force?: boolean } = {}): Promise<void> {
    if (this.saving) return;
    this.clearSaveTimers();
    if (!this.dirty && !options.force) return;

    this.saving = true;
    this.dirty = false;

    try {
      let snapshot = this.doc.export({ mode: "snapshot" });
      await Promise.all([
        this.ctx.storage.put(snapshotKey, snapshot),
        this.ctx.storage.put(updatedAtKey, Date.now()),
        this.ctx.storage.put(initializedAtKey, Date.now()),
        this.ctx.storage.put(schemaVersionKey, schemaVersion),
        this.deleteStoredUpdateLog(),
      ]);
      this.firstDirtyAt = 0;
      this.retryDelayMs = 1000;
    } catch (error: unknown) {
      this.writeMetric("persist_failure", { reason: "snapshot" });
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

  private async persistShareSnapshot(snapshot: Uint8Array) {
    await Promise.all([
      this.ctx.storage.put(snapshotKey, snapshot),
      this.ctx.storage.put(updatedAtKey, Date.now()),
      this.ctx.storage.put(initializedAtKey, Date.now()),
      this.ctx.storage.put(schemaVersionKey, schemaVersion),
      this.deleteStoredUpdateLog(),
    ]);
    this.dirty = false;
    this.firstDirtyAt = 0;
  }

  private async appendStoredDocumentUpdates(updates: Uint8Array[]) {
    if (!updates.length) return (await this.ctx.storage.get<number>(updateLogBytesKey)) ?? 0;

    let [previousSequence, previousBytes, existingEntries] = await Promise.all([
      this.ctx.storage.get<number>(updateLogSequenceKey),
      this.ctx.storage.get<number>(updateLogBytesKey),
      this.ctx.storage.list({ prefix: updateLogEntryPrefix }),
    ]);
    if (existingEntries.size + updates.length > maxStoredUpdateLogEntries) {
      await this.flushSnapshot({ force: true });
      return 0;
    }

    let nextSequence = previousSequence ?? 0;
    let nextBytes = previousBytes ?? 0;
    let writes: Array<Promise<void>> = [];
    for (let update of updates) {
      nextSequence += 1;
      let payload = new Uint8Array(update);
      nextBytes += payload.byteLength;
      writes.push(this.ctx.storage.put(updateLogEntryKey(nextSequence), payload));
    }
    writes.push(
      this.ctx.storage.put(updateLogSequenceKey, nextSequence),
      this.ctx.storage.put(updateLogBytesKey, nextBytes),
      this.ctx.storage.put(updatedAtKey, Date.now()),
      this.ctx.storage.put(initializedAtKey, Date.now()),
      this.ctx.storage.put(schemaVersionKey, schemaVersion),
    );
    await Promise.all(writes);
    return nextBytes;
  }

  private async deleteStoredUpdateLog() {
    let updateLogRecords = await this.ctx.storage.list({ prefix: updateLogEntryPrefix });
    let keys = [...updateLogRecords.keys(), updateLogBytesKey, updateLogSequenceKey];
    if (keys.length) await this.ctx.storage.delete(keys);
  }

  private async handleControlMessage(ws: WebSocket, message: string) {
    let control: ControlMessage;
    try {
      control = JSON.parse(message) as ControlMessage;
    } catch {
      this.writeMetric("malformed_control", { reason: "json" });
      ws.close(1003, "Malformed control message");
      return;
    }

    if (this.isPendingShareSocket(ws)) {
      await this.handleShareAuthMessage(ws, control);
      return;
    }

    if (control.type == "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }

  private async handleShareAuthMessage(ws: WebSocket, control: ControlMessage) {
    if (control.type != "auth" || typeof control.sessionToken != "string") {
      this.writeMetric("ws_auth_failed", { reason: "missing_session_token" });
      ws.close(1008, "Share authentication required");
      return;
    }

    await this.refreshShareRecord();
    let session = await this.validateShareSession(control.sessionToken);
    if (!session) {
      this.writeMetric("ws_auth_failed", { reason: "invalid_session" });
      ws.close(1008, "Invalid share session");
      return;
    }
    if (session.role == "guest" && this.shareSocketCount("guest") >= maxShareGuestPeers) {
      this.writeMetric("rate_limit", { reason: "guest_peer_limit", role: session.role });
      ws.close(1008, "Share is full");
      return;
    }

    let attachment: ConnectionAttachment = {
      clientId: normalizeClientId(typeof control.clientId == "string" ? control.clientId : null),
      joinedAt: Date.now(),
      role: session.role,
      secretHash: session.secretHash,
      updateTokens: maxUpdateFrameBurst,
      updateTokensAt: Date.now(),
    };
    ws.serializeAttachment(attachment);
    if (ws.readyState != WebSocket.OPEN) return;
    let clientVersion = parseAuthVersionVector(control.versionVector);
    if (!clientVersion.ok) {
      this.writeMetric("malformed_control", { reason: "version_vector", role: session.role });
      ws.close(1008, "Invalid sync version");
      return;
    }

    let serverVersion = this.doc.oplogVersion();
    ws.send(encodeWireMessage(WireKind.ShareStatus, this.shareStatusPayload()));
    this.sendInitialShareDocument(ws, clientVersion.version, serverVersion);
    this.writeMetric("ws_join", {
      guestCount: this.shareSocketCount("guest"),
      peerCount: this.shareSocketCount(),
      role: session.role,
    });
    this.broadcastShareStatus(ws);
  }

  private sendInitialShareDocument(
    ws: WebSocket,
    clientVersion: VersionVector | null,
    serverVersion: VersionVector,
  ) {
    if (clientVersion) {
      try {
        let update = this.doc.export({ from: clientVersion, mode: "update" });
        if (update.byteLength == 0) {
          this.sendSyncReady(ws, serverVersion);
          return;
        }
        if (update.byteLength <= maxDocumentUpdateBytes) {
          ws.send(encodeWireMessage(WireKind.Doc, update));
          this.sendSyncReady(ws, serverVersion);
          return;
        }
      } catch (error: unknown) {
        console.warn("Falling back to snapshot for collaboration sync", error);
      }
    }

    let snapshot = this.doc.export({ mode: "snapshot" });
    if (snapshot.byteLength > maxSnapshotBytes) {
      this.writeMetric("snapshot_too_large", {
        bytes: snapshot.byteLength,
        reason: "initial_sync",
        role: this.socketRole(ws),
      });
      ws.close(1009, "Document snapshot is too large");
      return;
    }
    ws.send(encodeWireMessage(WireKind.Snapshot, snapshot));
    this.sendSyncReady(ws, serverVersion);
  }

  private sendSyncReady(ws: WebSocket, serverVersion: VersionVector) {
    if (ws.readyState != WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "sync-ready",
        versionVector: serializeVersionVector(serverVersion),
      }),
    );
  }

  private enforceDocumentSnapshotLimit(sender: WebSocket) {
    let snapshot = this.doc.export({ mode: "snapshot" });
    if (snapshot.byteLength <= maxSnapshotBytes) return true;

    this.writeMetric("snapshot_too_large", {
      bytes: snapshot.byteLength,
      reason: "product_limit",
      role: this.socketRole(sender),
    });
    console.warn("Closing shared file room after snapshot size exceeded the product limit");
    sender.close(1009, "Document snapshot is too large");
    this.closeShareSockets(1009, "Document snapshot is too large");
    this.dirty = false;
    this.clearSaveTimers();
    return false;
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

  private writeMetric(event: GroveMetricEvent, values: GroveMetricValues = {}) {
    writeGroveMetric(this.env, event, {
      shareId: this.shareRecord?.shareId,
      ...values,
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let url = new URL(request.url);
    if (request.method == "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { headers: corsHeaders(request) });
    }

    if (createSharePattern.test(url.pathname) && request.method == "POST") {
      if (!(await allowCreateShareRequest(request, env))) {
        writeGroveMetric(env, "rate_limit", { reason: "create_share" });
        return jsonResponse({ error: "Share creation rate limit exceeded" }, 429, request);
      }

      let json = await readJson(request, maxCreateShareBodyBytes);
      if (json === requestBodyTooLarge) {
        writeGroveMetric(env, "frame_limit", { reason: "create_share_body_too_large" });
        return jsonResponse({ error: "Request too large" }, 413, request);
      }

      let body = parseCreateShareRequest(json);
      if (!body) return jsonResponse({ error: "Invalid share" }, 400, request);

      let shareUrl = new URL(`/api/shares/${encodeURIComponent(body.shareId)}`, url);
      return env.GROVE_SHARE_ROOMS.getByName(body.shareId).fetch(
        new Request(shareUrl, {
          body: JSON.stringify(body),
          headers: forwardedJsonHeaders(request),
          method: "POST",
        }),
      );
    }

    let share = shareFromPath(url.pathname);
    if (share) return env.GROVE_SHARE_ROOMS.getByName(share.shareId).fetch(request);

    return new Response("Not Found", { status: 404 });
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

function updateLogEntryKey(sequence: number) {
  return `${updateLogEntryPrefix}${String(sequence).padStart(12, "0")}`;
}

function parseAuthVersionVector(
  value: unknown,
): { ok: true; version: VersionVector | null } | { ok: false } {
  if (value == null) return { ok: true, version: null };
  if (!Array.isArray(value) || value.length > maxAuthVersionVectorEntries) {
    return { ok: false };
  }

  let version = new Map<`${number}`, number>();
  for (let entry of value) {
    if (!Array.isArray(entry) || entry.length != 2) return { ok: false };
    let [peer, counter] = entry;
    if (
      typeof peer != "string" ||
      !/^\d+$/.test(peer) ||
      typeof counter != "number" ||
      !Number.isSafeInteger(counter) ||
      counter < 0
    ) {
      return { ok: false };
    }
    version.set(peer as `${number}`, counter);
  }

  return { ok: true, version: new VersionVector(version) };
}

function serializeVersionVector(version: VersionVector) {
  return [...version.toJSON()].map(([peer, counter]) => [String(peer), counter]);
}

function versionAdvanced(next: VersionVector, previous: VersionVector) {
  return next.compare(previous) == 1;
}

function writeGroveMetric(env: Env, event: GroveMetricEvent, values: GroveMetricValues = {}) {
  let metrics = (env as Env & { GROVE_METRICS?: AnalyticsEngineDataset }).GROVE_METRICS;
  try {
    metrics?.writeDataPoint({
      indexes: [event],
      blobs: [
        event,
        metricBlob(values.shareId),
        metricBlob(values.role),
        metricBlob(values.reason),
      ],
      doubles: [
        Date.now(),
        values.count ?? 1,
        values.bytes ?? 0,
        values.closeCode ?? 0,
        values.peerCount ?? 0,
        values.guestCount ?? 0,
      ],
    });
  } catch (error: unknown) {
    console.warn("Failed to write Grove relay metric", error);
  }
}

function metricBlob(value: string | undefined) {
  return value?.slice(0, 160) ?? "";
}

function sumByteLength(values: Uint8Array[]) {
  let total = 0;
  for (let value of values) total += value.byteLength;
  return total;
}

async function allowCreateShareRequest(request: Request, env: Env) {
  let key =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("Origin") ??
    request.headers.get("Referer") ??
    "unknown";
  let { success } = await env.CREATE_SHARE_RATE_LIMITER.limit({ key: `create-share:${key}` });
  return success;
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
