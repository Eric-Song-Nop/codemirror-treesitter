import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  hashShareSecret,
  shareSessionTtlMs,
  type ShareRecord,
  type ShareSessionRecord,
} from "./share.ts";
import { maxShareSessions, maxSyncVersionVectorEntries } from "./share-limits.ts";

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

  it("keeps guest session issuance bounded when host capacity is reserved", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let storage = await shareStorage(now);
    let guestHash = await hashShareSecret(guestSecret);
    for (let index = 0; index < maxShareSessions; index++) {
      storage.records.set(`session:guest-${index}`, sessionRecord("guest", guestHash, now));
    }
    let room = await createTestRoom(storage);

    let response = await createSession(room, "guest", guestSecret);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Too many active guest sessions" });
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

async function shareStorage(now: number) {
  let storage = new MemoryDurableObjectStorage();
  storage.records.set("share", {
    createdAt: now,
    displayName: "note.md",
    expiresAt: now + 24 * 60 * 60 * 1000,
    guestSecretHash: await hashShareSecret(guestSecret),
    hostSecretHash: await hashShareSecret(hostSecret),
    schemaVersion: 1,
    shareId: validShareId,
  } satisfies ShareRecord);
  return storage;
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
    this.attachment = value;
  }
}

class MemoryDurableObjectStorage {
  records = new Map<string, unknown>();

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
