import { LoroDoc, VersionVector } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  encodeBase64,
  hashShareSecret,
  shareSessionTtlMs,
  type ShareRecord,
  type ShareSessionRecord,
} from "./share.ts";
import {
  maxShareGuestPeers,
  maxSharePeers,
  maxShareSessions,
  maxSyncVersionVectorEntries,
} from "./share-limits.ts";

const validShareId = "AAAAAAAAAAAAAAAAAAAAAA";
const hostSecret = "h".repeat(43);
const guestSecret = "g".repeat(43);
const sessionToken = "s".repeat(43);

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

describe("Grove share sessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reserves session capacity for the owner when guests fill their allowance", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let guestHash = await hashShareSecret(guestSecret);
    for (let index = 0; index < maxShareSessions; index++) {
      storage.records.set(`session:guest-${index}`, sessionRecord("guest", guestHash, now));
    }
    let room = await createTestRoom(storage);

    let responses: Response[] = [];
    for (let index = 0; index < 8; index++) {
      responses.push(await createSession(room, "host", hostSecret));
    }
    let rejected = await createSession(room, "host", hostSecret);

    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(201));
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toEqual({ error: "Too many active host sessions" });
  });

  it("evicts unused guest tokens instead of letting them block new guests", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let guestHash = await hashShareSecret(guestSecret);
    for (let index = 0; index < maxShareSessions; index++) {
      storage.records.set(`session:guest-${index}`, sessionRecord("guest", guestHash, now));
    }
    let room = await createTestRoom(storage);

    let response = await createSession(room, "guest", guestSecret);

    expect(response.status).toBe(201);
    expect([...storage.records.keys()].filter((key) => key.startsWith("session:"))).toHaveLength(
      maxShareSessions,
    );
  });

  it("removes every guest token after rotating the guest capability", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let oldGuestHash = await hashShareSecret(guestSecret);
    let nextGuestSecret = "n".repeat(43);
    let nextGuestHash = await hashShareSecret(nextGuestSecret);
    storage.records.set("session:old-guest", sessionRecord("guest", oldGuestHash, now));
    storage.records.set(
      "session:host",
      sessionRecord("host", await hashShareSecret(hostSecret), now),
    );
    storage.records.set("session:future-guest", sessionRecord("guest", nextGuestHash, now));
    let room = await createTestRoom(storage);

    let response = await rotateShare(room, nextGuestHash);

    expect(response.status).toBe(200);
    expect(storage.records.has("session:old-guest")).toBe(false);
    expect(storage.records.has("session:host")).toBe(true);
    expect(storage.records.has("session:future-guest")).toBe(false);
  });

  it("does not count stale-capability tokens against guest issuance", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let staleHash = await hashShareSecret("z".repeat(43));
    for (let index = 0; index < maxShareSessions; index++) {
      storage.records.set(`session:stale-${index}`, sessionRecord("guest", staleHash, now));
    }
    let room = await createTestRoom(storage);

    let response = await createSession(room, "guest", guestSecret);

    expect(response.status).toBe(201);
    expect(
      [...storage.records.values()].filter(
        (value) =>
          typeof value == "object" &&
          value != null &&
          (value as ShareSessionRecord).role == "guest" &&
          (value as ShareSessionRecord).secretHash == staleHash,
      ),
    ).toEqual([]);
  });

  it("limits live guest sockets while retaining the owner's reserved path", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let guestHash = await hashShareSecret(guestSecret);
    let room = await createTestRoom(storage);
    for (let index = 0; index < maxShareGuestPeers; index++) {
      room.sockets.add(
        new TestWebSocket({
          clientId: `guest-${String(index).padStart(8, "0")}`,
          joinedAt: now,
          role: "guest",
          secretHash: guestHash,
          sessionExpiresAt: now + shareSessionTtlMs,
        }).asWebSocket(),
      );
    }

    let guestResponse = await createSession(room, "guest", guestSecret);
    let hostResponse = await createSession(room, "host", hostSecret);

    expect(guestResponse.status).toBe(429);
    expect(await guestResponse.json()).toEqual({ error: "Share is full" });
    expect(hostResponse.status).toBe(201);
  });

  it("caps all live sockets even when another owner session is requested", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let room = await createTestRoom(storage);
    let guestHash = await hashShareSecret(guestSecret);
    for (let index = 0; index < maxSharePeers - 1; index++) {
      room.sockets.add(
        new TestWebSocket({
          clientId: `guest-${String(index).padStart(8, "0")}`,
          joinedAt: now,
          role: "guest",
          secretHash: guestHash,
          sessionExpiresAt: now + shareSessionTtlMs,
        }).asWebSocket(),
      );
    }
    room.sockets.add(
      new TestWebSocket({
        clientId: "owner-live",
        joinedAt: now,
        role: "host",
        secretHash: await hashShareSecret(hostSecret),
        sessionExpiresAt: now + shareSessionTtlMs,
      }).asWebSocket(),
    );

    let response = await createSession(room, "host", hostSecret);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Share is full" });
  });

  it("signals that an expired authentication token should be refreshed", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let guestHash = await hashShareSecret(guestSecret);
    storage.records.set(`session:${await hashShareSecret(sessionToken)}`, {
      ...sessionRecord("guest", guestHash, now),
      expiresAt: now - 1,
    });
    let room = await createTestRoom(storage);
    let socket = new TestWebSocket({
      clientId: "pending-client",
      joinedAt: now,
      pendingShareAuth: true,
    });

    await room.webSocketMessage(
      socket.asWebSocket(),
      JSON.stringify({
        clientId: "pending-client",
        sessionToken,
        type: "auth",
        versionVector: [],
      }),
    );

    expect(socket.sent).toContain(
      JSON.stringify({ reason: "expired", recoverable: true, type: "session-refresh-required" }),
    );
    expect(socket.closed).toEqual({ code: 4001, reason: "Share session expired" });
  });

  it("deletes a stale-capability token when authentication rejects it", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let key = `session:${await hashShareSecret(sessionToken)}`;
    storage.records.set(key, sessionRecord("guest", await hashShareSecret("z".repeat(43)), now));
    let room = await createTestRoom(storage);
    let socket = new TestWebSocket({
      clientId: "pending-client",
      joinedAt: now,
      pendingShareAuth: true,
    });

    await room.webSocketMessage(
      socket.asWebSocket(),
      JSON.stringify({ clientId: "pending-client", sessionToken, type: "auth", versionVector: [] }),
    );

    expect(storage.records.has(key)).toBe(false);
    expect(socket.closed).toEqual({ code: 4001, reason: "Share session is no longer valid" });
  });

  it("expires an authenticated socket on its next heartbeat", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let guestHash = await hashShareSecret(guestSecret);
    let room = await createTestRoom(storage);
    let socket = new TestWebSocket({
      clientId: "active-client",
      joinedAt: now - shareSessionTtlMs,
      role: "guest",
      secretHash: guestHash,
      sessionExpiresAt: now - 1,
    });

    await room.webSocketMessage(socket.asWebSocket(), JSON.stringify({ type: "ping" }));

    expect(socket.sent).toContain(
      JSON.stringify({ reason: "expired", recoverable: true, type: "session-refresh-required" }),
    );
    expect(socket.sent).not.toContain(JSON.stringify({ type: "pong" }));
    expect(socket.closed).toEqual({ code: 4001, reason: "Share session expired" });
  });

  it("accepts reconnect version vectors from documents with more than 128 actors", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let guestHash = await hashShareSecret(guestSecret);
    storage.records.set(
      `session:${await hashShareSecret(sessionToken)}`,
      sessionRecord("guest", guestHash, now),
    );
    let room = await createTestRoom(storage);
    let socket = new TestWebSocket({
      clientId: "pending-client",
      joinedAt: now,
      pendingShareAuth: true,
    });
    let versionVector = Array.from({ length: 129 }, (_, index) => [String(index + 1), 0]);

    await room.webSocketMessage(
      socket.asWebSocket(),
      JSON.stringify({ clientId: "pending-client", sessionToken, type: "auth", versionVector }),
    );

    expect(socket.closed).toBeNull();
    expect(socket.sent).toContainEqual(expect.stringContaining('"type":"sync-ready"'));
  });

  it("rejects reconnect version vectors beyond the bounded actor allowance", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let guestHash = await hashShareSecret(guestSecret);
    storage.records.set(
      `session:${await hashShareSecret(sessionToken)}`,
      sessionRecord("guest", guestHash, now),
    );
    let room = await createTestRoom(storage);
    let socket = new TestWebSocket({
      clientId: "pending-client",
      joinedAt: now,
      pendingShareAuth: true,
    });
    let versionVector = Array.from({ length: maxSyncVersionVectorEntries + 1 }, (_, index) => [
      String(index + 1),
      0,
    ]);
    let message = JSON.stringify({
      clientId: "pending-client",
      sessionToken,
      type: "auth",
      versionVector,
    });
    expect(new TextEncoder().encode(message).byteLength).toBeLessThan(64 * 1024);

    await room.webSocketMessage(socket.asWebSocket(), message);

    expect(socket.closed).toEqual({ code: 1008, reason: "Invalid sync version" });
  });

  it("frees the auth version vector when socket attachment serialization fails", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let guestHash = await hashShareSecret(guestSecret);
    storage.records.set(
      `session:${await hashShareSecret(sessionToken)}`,
      sessionRecord("guest", guestHash, now),
    );
    let room = await createTestRoom(storage);
    let socket = new TestWebSocket({
      clientId: "pending-client",
      joinedAt: now,
      pendingShareAuth: true,
    });
    socket.throwOnSerialize = true;
    let free = vi.spyOn(VersionVector.prototype, "free");
    free.mockClear();

    await expect(
      room.webSocketMessage(
        socket.asWebSocket(),
        JSON.stringify({
          clientId: "pending-client",
          sessionToken,
          type: "auth",
          versionVector: [],
        }),
      ),
    ).rejects.toThrow("attachment serialization failed");

    expect(free).toHaveBeenCalledTimes(1);
  });

  it("returns the existing share for an idempotent create replay", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let room = await createTestRoom(storage);

    let response = await createShare(
      room,
      storage.records.get("share") as ShareRecord,
      storage.records.get("snapshot") as Uint8Array,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      displayName: "note.md",
      expiresAt: now + 24 * 60 * 60 * 1000,
      shareId: validShareId,
    });
  });

  it("persists exact request and snapshot digests for new create replays", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = new MemoryDurableObjectStorage();
    let room = await createTestRoom(storage);
    room.initialized = false;
    room.shareRecord = null;
    let record = await testShareRecord(now);
    let doc = new LoroDoc();
    doc.getText("markdown").insert(0, "original");
    doc.commit();
    let snapshot = doc.export({ mode: "snapshot" });
    doc.free();

    let created = await createShare(room, record, snapshot);
    let replayed = await createShare(room, record, snapshot);

    expect(created.status).toBe(201);
    expect(replayed.status).toBe(200);
    expect(storage.records.get("share")).toMatchObject({
      createRequestDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      idempotencyKey: validShareId,
      snapshotDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it("rejects a create replay whose owner capability does not match", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let room = await createTestRoom(storage);
    let record = storage.records.get("share") as ShareRecord;

    let response = await createShare(
      room,
      { ...record, hostSecretHash: "x".repeat(43) },
      storage.records.get("snapshot") as Uint8Array,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Share already exists" });
  });

  it("rejects an idempotent replay whose snapshot differs", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let room = await createTestRoom(storage);
    let record = storage.records.get("share") as ShareRecord;
    let different = new LoroDoc();
    different.getText("markdown").insert(0, "different");
    different.commit();
    let differentSnapshot = different.export({ mode: "snapshot" });
    different.free();

    let response = await createShare(room, record, differentSnapshot);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Share already exists" });
  });

  it("validates the idempotency key on direct create requests", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let room = await createTestRoom(storage);

    let response = await createShare(
      room,
      storage.records.get("share") as ShareRecord,
      storage.records.get("snapshot") as Uint8Array,
      null,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid idempotency key" });
  });

  it("frees a temporary document when create snapshot validation fails", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    storage.records.clear();
    let room = await createTestRoom(storage);
    room.initialized = false;
    let record = await testShareRecord(now);
    let free = vi.spyOn(LoroDoc.prototype, "free");
    free.mockClear();

    let response = await createShare(room, record, new Uint8Array([1, 2, 3]));

    expect(response.status).toBe(400);
    expect(free).toHaveBeenCalledTimes(1);
  });
});

type TestRoom = {
  ctx: TestDurableObjectState;
  doc: LoroDoc;
  initialized: boolean;
  pendingHostSave: boolean;
  lastShareStatusBroadcastAt: number;
  shareRecord: ShareRecord | null;
  shareStatusTimer: ReturnType<typeof setTimeout> | null;
  sockets: Set<WebSocket>;
  fetch(request: Request): Promise<Response>;
  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void>;
};

type ConnectionAttachment = {
  clientId: string;
  joinedAt: number;
  pendingShareAuth?: boolean;
  role?: "guest" | "host";
  secretHash?: string;
  sessionExpiresAt?: number;
};

type TestDurableObjectState = {
  getWebSockets(tag?: string): WebSocket[];
  storage: MemoryDurableObjectStorage;
};

async function createTestRoom(storage: MemoryDurableObjectStorage) {
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  let { GroveShareRoom } = await import("./worker.ts");
  let room = Object.create(GroveShareRoom.prototype) as TestRoom;
  room.ctx = { getWebSockets: () => [...room.sockets], storage };
  room.doc = new LoroDoc();
  room.initialized = true;
  room.lastShareStatusBroadcastAt = 0;
  room.pendingHostSave = false;
  room.shareRecord = storage.records.get("share") as ShareRecord;
  room.shareStatusTimer = null;
  room.sockets = new Set();
  return room;
}

async function createSession(room: TestRoom, role: "guest" | "host", secret: string) {
  return room.fetch(
    new Request(`https://relay.example/api/shares/${validShareId}/session`, {
      body: JSON.stringify({ role, secret }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  );
}

async function rotateShare(room: TestRoom, nextGuestSecretHash: string) {
  return room.fetch(
    new Request(`https://relay.example/api/shares/${validShareId}/rotate`, {
      body: JSON.stringify({ hostSecret, nextGuestSecretHash }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  );
}

async function createShare(
  room: TestRoom,
  record: ShareRecord,
  snapshot: Uint8Array,
  idempotencyKey: string | null = validShareId,
) {
  let headers = new Headers({ "Content-Type": "application/json" });
  if (idempotencyKey != null) headers.set("Idempotency-Key", idempotencyKey);
  return room.fetch(
    new Request(`https://relay.example/api/shares/${validShareId}`, {
      body: JSON.stringify({
        displayName: record.displayName,
        expiresAt: record.expiresAt,
        guestSecretHash: record.guestSecretHash,
        hostSecretHash: record.hostSecretHash,
        shareId: record.shareId,
        snapshot: encodeBase64(snapshot),
      }),
      headers,
      method: "POST",
    }),
  );
}

async function shareStorage(now: number) {
  let storage = new MemoryDurableObjectStorage();
  storage.records.set("share", await testShareRecord(now));
  let doc = new LoroDoc();
  storage.records.set("snapshot", doc.export({ mode: "snapshot" }));
  doc.free();
  return storage;
}

async function testShareRecord(now: number) {
  return {
    createdAt: now,
    displayName: "note.md",
    expiresAt: now + 24 * 60 * 60 * 1000,
    guestSecretHash: await hashShareSecret(guestSecret),
    hostSecretHash: await hashShareSecret(hostSecret),
    schemaVersion: 1,
    shareId: validShareId,
  } satisfies ShareRecord;
}

function sessionRecord(role: "guest" | "host", secretHash: string, now: number) {
  return {
    clientId: "session-client",
    expiresAt: now + shareSessionTtlMs,
    role,
    secretHash,
  } satisfies ShareSessionRecord;
}

class TestWebSocket {
  closed: { code: number; reason: string } | null = null;
  readyState = 1;
  sent: Array<string | Uint8Array> = [];
  throwOnSerialize = false;

  constructor(public attachment: ConnectionAttachment) {}

  asWebSocket() {
    return this as unknown as WebSocket;
  }

  close(code = 1000, reason = "") {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  deserializeAttachment() {
    return this.attachment;
  }

  send(value: string | ArrayBuffer | ArrayBufferView) {
    this.sent.push(
      typeof value == "string"
        ? value
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }

  serializeAttachment(value: ConnectionAttachment) {
    if (this.throwOnSerialize) throw new Error("attachment serialization failed");
    this.attachment = value;
  }
}

class MemoryDurableObjectStorage {
  alarmAt: number | null = null;
  records = new Map<string, unknown>();

  async deleteAlarm() {
    this.alarmAt = null;
  }

  async delete(keys: string | string[]) {
    let deleted = 0;
    for (let key of Array.isArray(keys) ? keys : [keys]) {
      if (this.records.delete(key)) deleted++;
    }
    return deleted;
  }

  async get<T>(key: string) {
    return this.records.get(key) as T | undefined;
  }

  async list<T>(options: { prefix?: string } = {}) {
    return listRecords<T>(this.records, options);
  }

  async put<T>(key: string, value: T) {
    this.records.set(key, structuredClone(value));
  }

  async setAlarm(value: number | Date) {
    this.alarmAt = Number(value);
  }

  async transaction<T>(callback: (txn: MemoryDurableObjectStorage) => Promise<T>) {
    let records = new Map(
      [...this.records].map(([key, value]) => [key, structuredClone(value)] as const),
    );
    let transaction = new MemoryDurableObjectStorage();
    transaction.records = records;
    let result = await callback(transaction);
    this.records = records;
    return result;
  }
}

function listRecords<T>(records: Map<string, unknown>, options: { prefix?: string }) {
  let result = new Map<string, T>();
  for (let [key, value] of records) {
    if (options.prefix && !key.startsWith(options.prefix)) continue;
    result.set(key, value as T);
  }
  return result;
}
