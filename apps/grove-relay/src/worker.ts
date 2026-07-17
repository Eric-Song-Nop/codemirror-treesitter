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
  type CreateShareRequest,
  type ShareRecord,
  type ShareRole,
  type ShareSessionRecord,
} from "./share.ts";
import {
  maxBinaryByteBurst,
  maxBinaryBytesPerMinute,
  maxBinaryMessageBurst,
  maxBinaryMessagesPerMinute,
  maxCreateQuotaSharesPerUtcDay,
  maxCreateQuotaSnapshotBytesPerUtcDay,
  maxCreateShareBodyBytes,
  maxDocumentUpdateBytes,
  maxShareControlBodyBytes,
  maxShareGuestPeers,
  maxShareHostSessions,
  maxSharePeers,
  maxShareSessions,
  maxSnapshotBytes,
  maxSyncVersionVectorEntries,
  maxUpdateFrameBurst,
  maxUpdateFramesPerMinute,
  validateWireFrameLimits,
} from "./share-limits.ts";

type ConnectionAttachment = {
  binaryByteTokens?: number;
  binaryMessageTokens?: number;
  binaryTokensAt?: number;
  clientId: string;
  joinedAt: number;
  pendingShareAuth?: boolean;
  role?: ShareRole;
  secretHash?: string;
  sessionExpiresAt?: number;
  updateTokens?: number;
  updateTokensAt?: number;
};

type ControlMessage = {
  clientId?: unknown;
  sessionToken?: unknown;
  type?: string;
  versionVector?: unknown;
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
const maxHostSaveAckVersionVectorEntries = maxSyncVersionVectorEntries;
const maxVersionVectorCounter = 0x7fff_ffff;
const maxPeerId = "18446744073709551615";
const maxStoredUpdateLogBytes = maxSnapshotBytes;
const maxStoredUpdateLogEntries = 256;
const maxStorageDeleteBatch = 128;
const requestBodyTooLarge = Symbol("requestBodyTooLarge");
const createQuotaRecordKey = "currentUtcDay";

type CreateQuotaRecord = {
  distinctCreates: number;
  reservations: [shareId: string, decodedSnapshotBytes: number][];
  schemaVersion: 1;
  snapshotBytes: number;
  utcDay: string;
};

export type CreateQuotaReservationResult = {
  distinctCreates: number;
  reason?: "bytes" | "count";
  snapshotBytes: number;
  status: "conflict" | "exhausted" | "replayed" | "reserved";
  utcDay: string;
};

/**
 * One deliberately global, low-throughput coordinator for exact create
 * admission. Edge Rate Limit bindings smooth traffic but cannot enforce a
 * deployment-wide storage budget.
 */
export class GroveCreateQuota extends DurableObject<Env> {
  async reserve(
    shareId: string,
    decodedSnapshotBytes: number,
  ): Promise<CreateQuotaReservationResult> {
    if (
      !isValidShareId(shareId) ||
      !Number.isSafeInteger(decodedSnapshotBytes) ||
      decodedSnapshotBytes < 0 ||
      decodedSnapshotBytes > maxCreateQuotaSnapshotBytesPerUtcDay
    ) {
      throw new TypeError("Invalid create quota reservation");
    }

    let utcDay = new Date(Date.now()).toISOString().slice(0, 10);
    return this.ctx.storage.transaction(async (transaction) => {
      let stored = await transaction.get<unknown>(createQuotaRecordKey);
      let record = quotaRecordForDay(stored, utcDay);
      let existing = record.reservations.find(([reservedShareId]) => {
        return reservedShareId == shareId;
      });

      if (existing) {
        return quotaReservationResult(
          record,
          existing[1] == decodedSnapshotBytes ? "replayed" : "conflict",
        );
      }
      if (record.distinctCreates >= maxCreateQuotaSharesPerUtcDay) {
        return quotaReservationResult(record, "exhausted", "count");
      }
      if (record.snapshotBytes + decodedSnapshotBytes > maxCreateQuotaSnapshotBytesPerUtcDay) {
        return quotaReservationResult(record, "exhausted", "bytes");
      }

      record.reservations.push([shareId, decodedSnapshotBytes]);
      record.distinctCreates++;
      record.snapshotBytes += decodedSnapshotBytes;
      await transaction.put(createQuotaRecordKey, record);
      return quotaReservationResult(record, "reserved");
    });
  }
}

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

    let idempotencyKey = request.headers.get("Idempotency-Key");
    if (!isValidCreateIdempotencyKey(idempotencyKey, shareId)) {
      return jsonResponse({ error: "Invalid idempotency key" }, 400, request);
    }

    let snapshot = decodeBase64(body.snapshot);
    if (!snapshot) return jsonResponse({ error: "Invalid snapshot" }, 400, request);
    if (snapshot.byteLength > maxSnapshotBytes) {
      return jsonResponse({ error: "Snapshot too large" }, 413, request);
    }
    let snapshotDigest = await digestBytes(snapshot);
    let createRequestDigest = await digestCreateShareRequest(body, snapshotDigest);

    if (
      this.shareRecord &&
      (await this.isIdempotentCreateReplay(
        this.shareRecord,
        body,
        idempotencyKey,
        snapshotDigest,
        createRequestDigest,
      ))
    ) {
      return jsonResponse(
        {
          displayName: this.shareRecord.displayName,
          expiresAt: this.shareRecord.expiresAt,
          shareId: this.shareRecord.shareId,
        },
        200,
        request,
      );
    }
    if (this.shareRecord || this.initialized) {
      return jsonResponse({ error: "Share already exists" }, 409, request);
    }

    let nextDoc: LoroDoc | null = new LoroDoc();
    try {
      try {
        nextDoc.import(snapshot);
      } catch {
        return jsonResponse({ error: "Invalid snapshot" }, 400, request);
      }

      let now = Date.now();
      let record: ShareRecord = {
        createRequestDigest,
        createdAt: now,
        displayName: body.displayName,
        expiresAt: body.expiresAt,
        guestSecretHash: body.guestSecretHash,
        hostSecretHash: body.hostSecretHash,
        idempotencyKey,
        schemaVersion: shareSchemaVersion,
        shareId,
        snapshotDigest,
      };

      await this.ctx.storage.transaction(async (txn) => {
        await Promise.all([
          txn.put(shareRecordKey, record),
          txn.put(pendingHostSaveKey, false),
          txn.put(snapshotKey, snapshot),
          txn.put(updatedAtKey, now),
          txn.put(initializedAtKey, now),
          txn.put(schemaVersionKey, schemaVersion),
        ]);
      });

      let previousDoc = this.doc;
      this.doc = nextDoc;
      nextDoc = null;
      previousDoc.free();
      this.shareRecord = record;
      this.initialized = true;
      this.pendingHostSave = false;
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
    } finally {
      nextDoc?.free();
    }
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
    this.enforceShareSocketAuthorization();
    if (
      this.shareSocketCount() >= maxSharePeers ||
      (body.role == "guest" && this.shareSocketCount("guest") >= maxShareGuestPeers)
    ) {
      return jsonResponse({ error: "Share is full" }, 429, request);
    }

    let sessionToken = createSessionToken();
    let createdAt = Date.now();
    let expiresAt = createdAt + shareSessionTtlMs;
    let session: ShareSessionRecord = {
      clientId: normalizeClientId(null),
      createdAt,
      expiresAt,
      role: body.role,
      secretHash,
    };
    let stored = await this.storeShareSession(
      sessionKey(await hashShareSecret(sessionToken)),
      session,
    );
    if (!stored) {
      return jsonResponse({ error: `Too many active ${body.role} sessions` }, 429, request);
    }

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
    await this.ctx.storage.transaction(async (txn) => {
      let sessions = await txn.list<ShareSessionRecord>({ prefix: sessionKeyPrefix });
      let guestSessionKeys = [...sessions]
        .filter(([, session]) => session.role == "guest")
        .map(([key]) => key);
      await txn.put(shareRecordKey, next);
      if (guestSessionKeys.length) await txn.delete(guestSessionKeys);
    });
    this.shareRecord = next;
    await this.scheduleShareMaintenance();
    this.broadcastShareStatus(undefined, { immediate: true });
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
    this.broadcastShareStatus(undefined, { immediate: true });
    this.closeShareSockets(1008, "Sharing stopped");

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

    let hasHostSaveAck = messages.some((item) => item.kind == WireKind.HostSaveAck);
    if (hasHostSaveAck && this.socketRole(ws) != "host") {
      ws.close(1008, "Host authorization required");
      return;
    }

    let documentUpdateCount = messages.filter((item) => item.kind == WireKind.Doc).length;
    let rateLimit = this.updatedAttachmentAfterConsumingTokens(
      ws,
      Math.max(1, messages.length),
      frame.byteLength,
      documentUpdateCount,
    );
    if (!rateLimit.ok) {
      ws.close(1008, rateLimit.reason);
      return;
    }
    ws.serializeAttachment(rateLimit.attachment);

    let hostSaveAckVersions: VersionVector[] = [];
    let candidate: LoroDoc | null = null;
    try {
      for (let item of messages) {
        if (item.kind != WireKind.HostSaveAck) continue;
        let version = parseHostSaveAcknowledgement(item.payload, this.shareRecord?.shareId ?? null);
        if (!version) {
          ws.close(1008, "Invalid host save acknowledgement");
          return;
        }
        hostSaveAckVersions.push(version);
      }

      let hasDocumentPayload = messages.some(
        (item) => item.kind == WireKind.Doc || item.kind == WireKind.Snapshot,
      );
      candidate = hasDocumentPayload ? this.doc.fork() : null;
      let relay: WireMessage[] = [];
      let acceptedDocumentUpdates: Uint8Array[] = [];
      let acceptedSnapshot = false;
      let documentChanged = false;
      let firstDocumentRelayIndex: number | null = null;

      for (let item of messages) {
        if (item.kind == WireKind.Doc || item.kind == WireKind.Snapshot) {
          let beforeVersion = candidate!.oplogVersion();
          try {
            try {
              candidate!.import(item.payload);
            } catch (error: unknown) {
              console.warn("Dropping malformed Loro payload", error);
              ws.close(1003, "Malformed collaboration payload");
              return;
            }
            let afterVersion = candidate!.oplogVersion();
            let changed: boolean;
            try {
              changed = versionAdvanced(afterVersion, beforeVersion);
            } finally {
              afterVersion.free();
            }
            if (changed) {
              if (firstDocumentRelayIndex == null) firstDocumentRelayIndex = relay.length;
              documentChanged = true;
              if (item.kind == WireKind.Snapshot) {
                acceptedSnapshot = true;
                relay.push(item);
              } else {
                let acceptedUpdate = candidate!.export({ from: beforeVersion, mode: "update" });
                acceptedDocumentUpdates.push(acceptedUpdate);
                relay.push({ kind: WireKind.Doc, payload: acceptedUpdate });
              }
            }
          } finally {
            beforeVersion.free();
          }
        } else if (item.kind == WireKind.Presence) {
          relay.push(item);
        } else if (item.kind == WireKind.HostSaveAck) {
          relay.push(item);
        }
      }

      let canonicalSnapshot: Uint8Array | null = null;
      if (documentChanged) {
        canonicalSnapshot = candidate!.export({ mode: "snapshot" });
        if (this.shareRecord && canonicalSnapshot.byteLength > maxSnapshotBytes) {
          console.warn("Rejecting shared file update after candidate snapshot exceeded the limit");
          ws.close(1009, "Document snapshot is too large");
          return;
        }
        if (acceptedSnapshot) {
          relay = relay.filter(
            (item) => item.kind != WireKind.Doc && item.kind != WireKind.Snapshot,
          );
          relay.splice(firstDocumentRelayIndex ?? 0, 0, {
            kind: WireKind.Snapshot,
            payload: canonicalSnapshot,
          });
        }
      }

      let hostSaveAckCoversCanonical = false;
      if (hostSaveAckVersions.length) {
        let canonicalVersion = (documentChanged ? candidate! : this.doc).oplogVersion();
        try {
          hostSaveAckCoversCanonical = hostSaveAckVersions.some((version) => {
            let comparison = version.compare(canonicalVersion);
            return comparison == 0 || comparison == 1;
          });
        } finally {
          canonicalVersion.free();
        }
      }

      if (this.shareRecord && (documentChanged || hasHostSaveAck)) {
        let nextPendingHostSave = documentChanged ? true : this.pendingHostSave;
        if (hostSaveAckCoversCanonical) nextPendingHostSave = false;
        if (documentChanged) {
          try {
            await this.persistSharedDocumentState({
              canonicalSnapshot: canonicalSnapshot!,
              pendingHostSave: nextPendingHostSave,
              replaceSnapshot: acceptedSnapshot,
              updates: acceptedDocumentUpdates,
            });
          } catch (error: unknown) {
            console.error("Failed to persist shared file update log", error);
            ws.close(1011, "Failed to persist shared file update");
            return;
          }
        } else {
          try {
            await this.persistPendingHostSave(nextPendingHostSave);
          } catch (error: unknown) {
            console.error("Failed to persist host save acknowledgement", error);
            ws.close(1011, "Failed to persist shared file update");
            return;
          }
        }

        if (documentChanged) {
          let previousDoc = this.doc;
          this.doc = candidate!;
          candidate = null;
          previousDoc.free();
          this.initialized = true;
        }
        this.pendingHostSave = nextPendingHostSave;
        if (relay.length) this.broadcast(ws, encodeWireBatch(relay));
        this.broadcastShareStatus();
        return;
      }

      if (documentChanged) {
        let previousDoc = this.doc;
        this.doc = candidate!;
        candidate = null;
        previousDoc.free();
        this.initialized = true;
        this.markDirty();
      }
      if (relay.length) this.broadcast(ws, encodeWireBatch(relay));
    } finally {
      freeVersionVectors(hostSaveAckVersions);
      candidate?.free();
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.sockets.delete(ws);
    if (this.shareRecord) return;
    await this.flushSnapshot();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.sockets.delete(ws);
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
    this.doc.free();
    this.doc = new LoroDoc();
    this.firstDirtyAt = 0;
    this.initialized = false;
    this.pendingHostSave = false;
    this.retryDelayMs = 1000;
    this.saving = false;
    this.shareRecord = null;
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

  private async persistPendingHostSave(value: boolean) {
    if (this.pendingHostSave == value) return;
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(pendingHostSaveKey, value);
    });
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
    let sessionExpiresAt = attachment.sessionExpiresAt ?? attachment.joinedAt + shareSessionTtlMs;
    if (sessionExpiresAt <= Date.now()) {
      this.requestSessionRefresh(socket, "expired");
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
    if (!share || !sessionToken) return { status: "invalid" } as const;

    let key = sessionKey(await hashShareSecret(sessionToken));
    let session = await this.ctx.storage.get<ShareSessionRecord>(key);
    if (!session) return { status: "invalid" } as const;
    if (session.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(key);
      return { status: "expired" } as const;
    }

    let expectedHash = session.role == "host" ? share.hostSecretHash : share.guestSecretHash;
    if (!timingSafeEqualString(session.secretHash, expectedHash)) {
      await this.ctx.storage.delete(key);
      return { status: "invalid" } as const;
    }
    return { session, status: "valid" } as const;
  }

  private requestSessionRefresh(socket: WebSocket, reason: "expired" | "invalid") {
    if (socket.readyState == WebSocket.OPEN) {
      socket.send(JSON.stringify({ reason, recoverable: true, type: "session-refresh-required" }));
    }
    socket.close(
      4001,
      reason == "expired" ? "Share session expired" : "Share session is no longer valid",
    );
  }

  private async storeShareSession(key: string, next: ShareSessionRecord) {
    let now = Date.now();
    let share = this.shareRecord;
    return this.ctx.storage.transaction(async (txn) => {
      let sessions = await txn.list<ShareSessionRecord>({ prefix: sessionKeyPrefix });
      let discardKeys: string[] = [];
      let activeForRole: [string, ShareSessionRecord][] = [];
      for (let [sessionKey, session] of sessions) {
        let expectedHash = session.role == "host" ? share?.hostSecretHash : share?.guestSecretHash;
        if (
          session.expiresAt <= now ||
          !expectedHash ||
          !timingSafeEqualString(session.secretHash, expectedHash)
        ) {
          discardKeys.push(sessionKey);
        } else if (session.role == next.role) {
          activeForRole.push([sessionKey, session]);
        }
      }

      if (discardKeys.length) await txn.delete(discardKeys);
      let roleLimit = next.role == "host" ? maxShareHostSessions : maxShareSessions;
      if (activeForRole.length >= roleLimit) {
        if (next.role == "host") return false;
        activeForRole.sort(
          ([leftKey, left], [rightKey, right]) =>
            sessionCreatedAt(left) - sessionCreatedAt(right) || leftKey.localeCompare(rightKey),
        );
        let evictCount = activeForRole.length - roleLimit + 1;
        await txn.delete(activeForRole.slice(0, evictCount).map(([sessionKey]) => sessionKey));
      }
      await txn.put(key, next);
      return true;
    });
  }

  private updatedAttachmentAfterConsumingTokens(
    socket: WebSocket,
    binaryMessageCount: number,
    binaryByteCount: number,
    documentUpdateCount: number,
  ):
    | { attachment: ConnectionAttachment; ok: true }
    | {
        ok: false;
        reason: "Collaboration traffic rate limit exceeded" | "Document update rate limit exceeded";
      } {
    let attachment = socket.deserializeAttachment() as ConnectionAttachment | undefined;
    if (!attachment) return { ok: false, reason: "Collaboration traffic rate limit exceeded" };

    let now = Date.now();
    let nextUpdateTokens = refillTokenBucket(
      attachment.updateTokens ?? maxUpdateFrameBurst,
      attachment.updateTokensAt ?? now,
      now,
      maxUpdateFrameBurst,
      maxUpdateFramesPerMinute,
    );
    if (nextUpdateTokens < documentUpdateCount) {
      return { ok: false, reason: "Document update rate limit exceeded" };
    }
    let nextBinaryMessageTokens = refillTokenBucket(
      attachment.binaryMessageTokens ?? maxBinaryMessageBurst,
      attachment.binaryTokensAt ?? now,
      now,
      maxBinaryMessageBurst,
      maxBinaryMessagesPerMinute,
    );
    let nextBinaryByteTokens = refillTokenBucket(
      attachment.binaryByteTokens ?? maxBinaryByteBurst,
      attachment.binaryTokensAt ?? now,
      now,
      maxBinaryByteBurst,
      maxBinaryBytesPerMinute,
    );
    if (nextBinaryMessageTokens < binaryMessageCount || nextBinaryByteTokens < binaryByteCount) {
      return { ok: false, reason: "Collaboration traffic rate limit exceeded" };
    }

    return {
      attachment: {
        ...attachment,
        binaryByteTokens: nextBinaryByteTokens - binaryByteCount,
        binaryMessageTokens: nextBinaryMessageTokens - binaryMessageCount,
        binaryTokensAt: now,
        updateTokens: nextUpdateTokens - documentUpdateCount,
        updateTokensAt: now,
      },
      ok: true,
    };
  }

  private async isIdempotentCreateReplay(
    record: ShareRecord,
    request: CreateShareRequest,
    idempotencyKey: string,
    snapshotDigest: string,
    createRequestDigest: string,
  ) {
    if (
      !hasMatchingCreateMetadata(record, request) ||
      (record.idempotencyKey != null && record.idempotencyKey != idempotencyKey)
    ) {
      return false;
    }
    if (record.snapshotDigest != null || record.createRequestDigest != null) {
      return (
        record.snapshotDigest != null &&
        record.createRequestDigest != null &&
        timingSafeEqualString(record.snapshotDigest, snapshotDigest) &&
        timingSafeEqualString(record.createRequestDigest, createRequestDigest)
      );
    }

    let storedSnapshot = await this.ctx.storage.get<Uint8Array | ArrayBuffer>(snapshotKey);
    if (!storedSnapshot) return false;
    return timingSafeEqualString(await digestBytes(toUint8Array(storedSnapshot)), snapshotDigest);
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
      await this.persistSharedDocumentState({
        canonicalSnapshot: snapshot,
        pendingHostSave: this.pendingHostSave,
        replaceSnapshot: true,
        updates: [],
      });
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

  private async persistSharedDocumentState(options: {
    canonicalSnapshot: Uint8Array;
    pendingHostSave: boolean;
    replaceSnapshot: boolean;
    updates: Uint8Array[];
  }) {
    let now = Date.now();
    let updateBytes = options.updates.reduce((total, update) => total + update.byteLength, 0);

    return this.ctx.storage.transaction(async (txn) => {
      if (options.replaceSnapshot) {
        await this.writeCanonicalSnapshot(
          txn,
          options.canonicalSnapshot,
          options.pendingHostSave,
          now,
        );
        return 0;
      }

      let [previousSequence, previousBytes, existingEntries] = await Promise.all([
        txn.get<number>(updateLogSequenceKey),
        txn.get<number>(updateLogBytesKey),
        txn.list({ prefix: updateLogEntryPrefix }),
      ]);
      let nextBytes = (previousBytes ?? 0) + updateBytes;
      if (
        existingEntries.size + options.updates.length > maxStoredUpdateLogEntries ||
        nextBytes >= maxStoredUpdateLogBytes
      ) {
        await this.writeCanonicalSnapshot(
          txn,
          options.canonicalSnapshot,
          options.pendingHostSave,
          now,
          existingEntries,
        );
        return 0;
      }

      let nextSequence = previousSequence ?? 0;
      for (let update of options.updates) {
        nextSequence += 1;
        await txn.put(updateLogEntryKey(nextSequence), new Uint8Array(update));
      }
      await Promise.all([
        txn.put(updateLogSequenceKey, nextSequence),
        txn.put(updateLogBytesKey, nextBytes),
        txn.put(pendingHostSaveKey, options.pendingHostSave),
        txn.put(updatedAtKey, now),
        txn.put(initializedAtKey, now),
        txn.put(schemaVersionKey, schemaVersion),
      ]);
      return nextBytes;
    });
  }

  private async writeCanonicalSnapshot(
    txn: DurableObjectTransaction,
    snapshot: Uint8Array,
    pendingHostSave: boolean,
    now: number,
    existingEntries?: Map<string, unknown>,
  ) {
    await Promise.all([
      txn.put(snapshotKey, new Uint8Array(snapshot)),
      txn.put(pendingHostSaveKey, pendingHostSave),
      txn.put(updatedAtKey, now),
      txn.put(initializedAtKey, now),
      txn.put(schemaVersionKey, schemaVersion),
    ]);
    await this.deleteStoredUpdateLog(txn, existingEntries);
  }

  private async deleteStoredUpdateLog(
    txn: DurableObjectTransaction,
    existingEntries?: Map<string, unknown>,
  ) {
    let updateLogRecords = existingEntries ?? (await txn.list({ prefix: updateLogEntryPrefix }));
    let keys = [...updateLogRecords.keys(), updateLogBytesKey, updateLogSequenceKey];
    for (let index = 0; index < keys.length; index += maxStorageDeleteBatch) {
      await txn.delete(keys.slice(index, index + maxStorageDeleteBatch));
    }
  }

  private async handleControlMessage(ws: WebSocket, message: string) {
    let control: ControlMessage;
    try {
      control = JSON.parse(message) as ControlMessage;
    } catch {
      ws.close(1003, "Malformed control message");
      return;
    }

    if (this.isPendingShareSocket(ws)) {
      await this.handleShareAuthMessage(ws, control);
      return;
    }

    if (!this.ensureSocketShareAuthorization(ws)) return;

    if (control.type == "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }

  private async handleShareAuthMessage(ws: WebSocket, control: ControlMessage) {
    if (control.type != "auth" || typeof control.sessionToken != "string") {
      ws.close(1008, "Share authentication required");
      return;
    }

    await this.refreshShareRecord();
    let validation = await this.validateShareSession(control.sessionToken);
    if (validation.status != "valid") {
      this.requestSessionRefresh(ws, validation.status);
      return;
    }
    let session = validation.session;
    this.enforceShareSocketAuthorization();
    if (
      this.shareSocketCount() >= maxSharePeers ||
      (session.role == "guest" && this.shareSocketCount("guest") >= maxShareGuestPeers)
    ) {
      ws.close(1008, "Share is full");
      return;
    }
    let clientVersion = parseAuthVersionVector(control.versionVector);
    if (!clientVersion.ok) {
      ws.close(1008, "Invalid sync version");
      return;
    }

    let clientVersionValue = clientVersion.version;
    try {
      let authenticatedAt = Date.now();
      let attachment: ConnectionAttachment = {
        binaryByteTokens: maxBinaryByteBurst,
        binaryMessageTokens: maxBinaryMessageBurst,
        binaryTokensAt: authenticatedAt,
        clientId: normalizeClientId(typeof control.clientId == "string" ? control.clientId : null),
        joinedAt: authenticatedAt,
        role: session.role,
        secretHash: session.secretHash,
        sessionExpiresAt: session.expiresAt,
        updateTokens: maxUpdateFrameBurst,
        updateTokensAt: authenticatedAt,
      };
      ws.serializeAttachment(attachment);
      if (ws.readyState != WebSocket.OPEN) return;

      let serverVersion = this.doc.oplogVersion();
      try {
        ws.send(encodeWireMessage(WireKind.ShareStatus, this.shareStatusPayload()));
        this.sendInitialShareDocument(ws, clientVersionValue, serverVersion);
        this.broadcastShareStatus(ws);
      } finally {
        serverVersion.free();
      }
    } finally {
      clientVersionValue?.free();
    }
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
      if (!(await allowCreateShareRequest(request, env))) {
        return jsonResponse({ error: "Share creation rate limit exceeded" }, 429, request);
      }

      let json = await readJson(request, maxCreateShareBodyBytes);
      if (json === requestBodyTooLarge)
        return jsonResponse({ error: "Request too large" }, 413, request);

      let body = parseCreateShareRequest(json);
      if (!body) return jsonResponse({ error: "Invalid share" }, 400, request);
      if (!isValidCreateIdempotencyKey(request.headers.get("Idempotency-Key"), body.shareId)) {
        return jsonResponse({ error: "Invalid idempotency key" }, 400, request);
      }

      let snapshot = decodeBase64(body.snapshot);
      if (!snapshot) return jsonResponse({ error: "Invalid snapshot" }, 400, request);
      if (snapshot.byteLength > maxSnapshotBytes) {
        return jsonResponse({ error: "Snapshot too large" }, 413, request);
      }
      if (!isValidLoroSnapshot(snapshot)) {
        return jsonResponse({ error: "Invalid snapshot" }, 400, request);
      }

      let quotaReservation: unknown;
      try {
        quotaReservation = await env.GROVE_CREATE_QUOTA.getByName("global-create-quota").reserve(
          body.shareId,
          snapshot.byteLength,
        );
      } catch (error: unknown) {
        console.error("Grove create quota reservation failed", error);
        return jsonResponse({ error: "Share creation temporarily unavailable" }, 503, request);
      }
      let quotaStatus =
        quotaReservation && typeof quotaReservation == "object"
          ? (quotaReservation as { status?: unknown }).status
          : null;
      if (quotaStatus == "exhausted") {
        return jsonResponse({ error: "Share creation quota exceeded" }, 429, request);
      }
      if (quotaStatus == "conflict") {
        return jsonResponse({ error: "Share quota reservation conflicts" }, 409, request);
      }
      if (quotaStatus != "reserved" && quotaStatus != "replayed") {
        return jsonResponse({ error: "Share creation temporarily unavailable" }, 503, request);
      }

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
    if (share) {
      if (share.action == "session") {
        if (request.method != "POST") {
          return jsonResponse({ error: "Not found" }, 404, request);
        }
        if (
          !(await allowPublicApiRequest(
            request,
            env.SHARE_SESSION_RATE_LIMITER,
            "share-session",
            share.shareId,
          ))
        ) {
          return jsonResponse({ error: "Share session rate limit exceeded" }, 429, request);
        }
      }
      if (share.action == "ws") {
        if (request.method != "GET") {
          return jsonResponse({ error: "Not found" }, 404, request);
        }
        if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") {
          return new Response("Expected WebSocket", { status: 426 });
        }
        if (
          !(await allowPublicApiRequest(
            request,
            env.SHARE_WEBSOCKET_RATE_LIMITER,
            "share-websocket",
            share.shareId,
          ))
        ) {
          return jsonResponse({ error: "Share connection rate limit exceeded" }, 429, request);
        }
      }
      return env.GROVE_SHARE_ROOMS.getByName(share.shareId).fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};

function quotaRecordForDay(stored: unknown, utcDay: string): CreateQuotaRecord {
  if (stored != null) {
    if (!isCreateQuotaRecord(stored)) throw new Error("Invalid stored create quota record");
    if (stored.utcDay == utcDay) return stored;
  }

  return {
    distinctCreates: 0,
    reservations: [],
    schemaVersion: 1,
    snapshotBytes: 0,
    utcDay,
  };
}

function isCreateQuotaRecord(value: unknown): value is CreateQuotaRecord {
  if (!value || typeof value != "object" || Array.isArray(value)) return false;
  let record = value as Partial<CreateQuotaRecord>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.utcDay != "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(record.utcDay) ||
    !Number.isSafeInteger(record.distinctCreates) ||
    record.distinctCreates! < 0 ||
    record.distinctCreates! > maxCreateQuotaSharesPerUtcDay ||
    !Number.isSafeInteger(record.snapshotBytes) ||
    record.snapshotBytes! < 0 ||
    record.snapshotBytes! > maxCreateQuotaSnapshotBytesPerUtcDay ||
    !Array.isArray(record.reservations) ||
    record.reservations.length != record.distinctCreates
  ) {
    return false;
  }

  let shareIds = new Set<string>();
  let snapshotBytes = 0;
  for (let reservation of record.reservations) {
    if (
      !Array.isArray(reservation) ||
      reservation.length != 2 ||
      !isValidShareId(reservation[0]) ||
      shareIds.has(reservation[0]) ||
      !Number.isSafeInteger(reservation[1]) ||
      reservation[1] < 0 ||
      reservation[1] > maxCreateQuotaSnapshotBytesPerUtcDay
    ) {
      return false;
    }
    shareIds.add(reservation[0]);
    snapshotBytes += reservation[1];
  }
  return snapshotBytes == record.snapshotBytes;
}

function quotaReservationResult(
  record: CreateQuotaRecord,
  status: CreateQuotaReservationResult["status"],
  reason?: CreateQuotaReservationResult["reason"],
): CreateQuotaReservationResult {
  return {
    distinctCreates: record.distinctCreates,
    ...(reason ? { reason } : {}),
    snapshotBytes: record.snapshotBytes,
    status,
    utcDay: record.utcDay,
  };
}

function isValidLoroSnapshot(snapshot: Uint8Array) {
  let doc = new LoroDoc();
  try {
    doc.import(snapshot);
    return true;
  } catch {
    return false;
  } finally {
    doc.free();
  }
}

function normalizeClientId(value: string | null): string {
  if (value && validClientIdPattern.test(value)) return value;
  return crypto.randomUUID();
}

function hasMatchingCreateMetadata(record: ShareRecord, request: CreateShareRequest) {
  return (
    record.revokedAt == null &&
    record.shareId == request.shareId &&
    record.displayName == request.displayName &&
    record.expiresAt == request.expiresAt &&
    timingSafeEqualString(record.guestSecretHash, request.guestSecretHash) &&
    timingSafeEqualString(record.hostSecretHash, request.hostSecretHash)
  );
}

function isValidCreateIdempotencyKey(value: string | null, shareId: string): value is string {
  return value != null && value == shareId && isValidShareId(value);
}

async function digestCreateShareRequest(request: CreateShareRequest, snapshotDigest: string) {
  return digestBytes(
    new TextEncoder().encode(
      JSON.stringify([
        request.shareId,
        request.displayName,
        request.expiresAt,
        request.guestSecretHash,
        request.hostSecretHash,
        snapshotDigest,
      ]),
    ),
  );
}

async function digestBytes(bytes: Uint8Array) {
  let input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  let digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  let binary = "";
  for (let byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

function sessionCreatedAt(session: ShareSessionRecord) {
  return session.createdAt ?? session.expiresAt - shareSessionTtlMs;
}

function updateLogEntryKey(sequence: number) {
  return `${updateLogEntryPrefix}${String(sequence).padStart(12, "0")}`;
}

function parseAuthVersionVector(
  value: unknown,
): { ok: true; version: VersionVector | null } | { ok: false } {
  if (value == null) return { ok: true, version: null };
  let version = parseVersionVector(value, maxSyncVersionVectorEntries);
  return version ? { ok: true, version } : { ok: false };
}

function parseHostSaveAcknowledgement(payload: Uint8Array, expectedShareId: string | null) {
  if (!expectedShareId) return null;

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    return null;
  }
  if (!value || typeof value != "object" || Array.isArray(value)) return null;

  let acknowledgement = value as Record<string, unknown>;
  if (
    acknowledgement.shareId !== expectedShareId ||
    typeof acknowledgement.shareId != "string" ||
    !isValidShareId(acknowledgement.shareId)
  ) {
    return null;
  }
  let savedAt = acknowledgement.savedAt;
  if (
    savedAt != null &&
    (typeof savedAt != "number" || !Number.isSafeInteger(savedAt) || savedAt < 0)
  ) {
    return null;
  }
  return parseVersionVector(acknowledgement.versionVector, maxHostSaveAckVersionVectorEntries);
}

function parseVersionVector(value: unknown, maxEntries: number) {
  if (!Array.isArray(value) || value.length > maxEntries) return null;

  let version = new Map<`${number}`, number>();
  for (let entry of value) {
    if (!Array.isArray(entry) || entry.length != 2) return null;
    let [peer, counter] = entry;
    if (
      typeof peer != "string" ||
      !isCanonicalPeerId(peer) ||
      version.has(peer as `${number}`) ||
      typeof counter != "number" ||
      !Number.isSafeInteger(counter) ||
      counter < 0 ||
      counter > maxVersionVectorCounter
    ) {
      return null;
    }
    version.set(peer as `${number}`, counter);
  }

  try {
    return new VersionVector(version);
  } catch {
    return null;
  }
}

function isCanonicalPeerId(value: string) {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return false;
  return (
    value.length < maxPeerId.length || (value.length == maxPeerId.length && value <= maxPeerId)
  );
}

function freeVersionVectors(versions: readonly VersionVector[]) {
  for (let version of versions) version.free();
}

function serializeVersionVector(version: VersionVector) {
  return [...version.toJSON()].map(([peer, counter]) => [String(peer), counter]);
}

function versionAdvanced(next: VersionVector, previous: VersionVector) {
  return next.compare(previous) == 1;
}

function refillTokenBucket(
  previousTokens: number,
  previousAt: number,
  now: number,
  burst: number,
  perMinute: number,
) {
  let elapsed = Math.max(0, now - previousAt);
  return Math.min(burst, previousTokens + (elapsed / 60_000) * perMinute);
}

async function allowCreateShareRequest(request: Request, env: Env) {
  return allowPublicApiRequest(request, env.CREATE_SHARE_RATE_LIMITER, "create-share", "all");
}

async function allowPublicApiRequest(
  request: Request,
  limiter: RateLimit,
  route: string,
  resource: string,
) {
  let actor =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("Origin") ??
    request.headers.get("Referer") ??
    "unknown";
  let actorResult = await limiter.limit({ key: `${route}:actor:${actor}` });
  if (!actorResult.success) return false;

  let resourceResult = await limiter.limit({ key: `${route}:resource:${resource}` });
  if (!resourceResult.success || resource == "all") return resourceResult.success;

  let aggregateResult = await limiter.limit({ key: `${route}:resource:all` });
  return aggregateResult.success;
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
  let idempotencyKey = request.headers.get("Idempotency-Key");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
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
    "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": origin || "*",
    Vary: "Origin",
  };
}
