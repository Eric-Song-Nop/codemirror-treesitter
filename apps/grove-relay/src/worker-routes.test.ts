import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LoroDoc } from "loro-crdt";
import { decodeBase64, encodeBase64, type ShareRecord } from "./share.ts";

const validShareId = "AAAAAAAAAAAAAAAAAAAAAA";
const validHash = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared file Worker routes", () => {
  it("does not expose legacy room WebSockets from Grove share Durable Objects", async () => {
    let { GroveShareRoom } = await import("./worker.ts");
    let room = Object.create(GroveShareRoom.prototype) as TestGroveShareRoom;
    room.shareRecord = shareRecord();

    let response = await room.fetch(
      new Request(`http://example.test/api/doc/${validShareId}/ws`, {
        headers: { Upgrade: "websocket" },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("rate-limits public share creation before forwarding to a Durable Object", async () => {
    let { default: worker } = await import("./worker.ts");
    let getByName = vi.fn();
    let response = await worker.fetch(
      new Request("https://relay.example/api/shares", {
        body: "{",
        method: "POST",
      }),
      {
        GROVE_SHARE_ROOMS: { getByName },
        CREATE_SHARE_RATE_LIMITER: {
          limit: vi.fn(async () => ({ success: false })),
        },
      } as unknown as Env,
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Share creation rate limit exceeded" });
    expect(getByName).not.toHaveBeenCalled();
  });

  it("rate-limits public session creation before waking a share Durable Object", async () => {
    let { default: worker } = await import("./worker.ts");
    let getByName = vi.fn();
    let response = await worker.fetch(
      new Request(`https://relay.example/api/shares/${validShareId}/session`, {
        body: JSON.stringify({ role: "guest", secret: "g".repeat(43) }),
        method: "POST",
      }),
      relayEnv(getByName, { session: false }),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Share session rate limit exceeded" });
    expect(getByName).not.toHaveBeenCalled();
  });

  it("rate-limits public WebSocket upgrades before waking a share Durable Object", async () => {
    let { default: worker } = await import("./worker.ts");
    let getByName = vi.fn();
    let response = await worker.fetch(
      new Request(`https://relay.example/api/shares/${validShareId}/ws`, {
        headers: { Upgrade: "websocket" },
      }),
      relayEnv(getByName, { websocket: false }),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Share connection rate limit exceeded" });
    expect(getByName).not.toHaveBeenCalled();
  });

  it("forwards a validated idempotency key to the share Durable Object", async () => {
    let { default: worker } = await import("./worker.ts");
    let forwardedIdempotencyKey: string | null = null;
    let fetch = vi.fn(async (request: Request) => {
      forwardedIdempotencyKey = request.headers.get("Idempotency-Key");
      return new Response(null, { status: 201 });
    });
    let getByName = vi.fn(() => ({ fetch }));
    let response = await worker.fetch(
      new Request("https://relay.example/api/shares", {
        body: JSON.stringify(createShareBody()),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": validShareId,
        },
        method: "POST",
      }),
      relayEnv(getByName),
    );

    expect(response.status).toBe(201);
    expect(forwardedIdempotencyKey).toBe(validShareId);
  });

  it("reserves decoded snapshot bytes before waking the share Durable Object", async () => {
    let { default: worker } = await import("./worker.ts");
    let events: string[] = [];
    let reserve = vi.fn(async () => {
      events.push("quota");
      return { status: "reserved" as const };
    });
    let fetch = vi.fn(async () => {
      events.push("share");
      return new Response(null, { status: 201 });
    });
    let getByName = vi.fn(() => ({ fetch }));
    let body = createShareBody();

    let response = await worker.fetch(
      createShareRequest(body),
      relayEnv(getByName, {}, { reserve }),
    );

    expect(response.status).toBe(201);
    expect(reserve).toHaveBeenCalledWith(validShareId, decodeBase64(body.snapshot)!.byteLength);
    expect(events).toEqual(["quota", "share"]);
  });

  it("passes exact create replays through the same idempotent quota reservation", async () => {
    let { default: worker } = await import("./worker.ts");
    let reserve = vi
      .fn()
      .mockResolvedValueOnce({ status: "reserved" as const })
      .mockResolvedValueOnce({ status: "replayed" as const });
    let fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    let getByName = vi.fn(() => ({ fetch }));
    let body = createShareBody();
    let env = relayEnv(getByName, {}, { reserve });

    let created = await worker.fetch(createShareRequest(body), env);
    let replayed = await worker.fetch(createShareRequest(body), env);

    expect(created.status).toBe(201);
    expect(replayed.status).toBe(200);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve.mock.calls[0]).toEqual(reserve.mock.calls[1]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ reason: "count", status: "exhausted" } as const, 429, "Share creation quota exceeded"],
    [{ status: "conflict" } as const, 409, "Share quota reservation conflicts"],
  ])(
    "does not wake a share Durable Object when quota admission returns $0.status",
    async (quotaResult, expectedStatus, expectedError) => {
      let { default: worker } = await import("./worker.ts");
      let reserve = vi.fn(async () => quotaResult);
      let getByName = vi.fn();

      let response = await worker.fetch(
        createShareRequest(createShareBody()),
        relayEnv(getByName, {}, { reserve }),
      );

      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toEqual({ error: expectedError });
      expect(getByName).not.toHaveBeenCalled();
    },
  );

  it("fails closed without waking a share Durable Object when quota RPC fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let { default: worker } = await import("./worker.ts");
    let reserve = vi.fn(async () => {
      throw new Error("quota unavailable");
    });
    let getByName = vi.fn();

    let response = await worker.fetch(
      createShareRequest(createShareBody()),
      relayEnv(getByName, {}, { reserve }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Share creation temporarily unavailable" });
    expect(getByName).not.toHaveBeenCalled();
  });

  it("fails closed without waking a share Durable Object for an invalid quota response", async () => {
    let { default: worker } = await import("./worker.ts");
    let reserve = vi.fn(async () => ({ status: "invalid" }));
    let getByName = vi.fn();

    let response = await worker.fetch(
      createShareRequest(createShareBody()),
      relayEnv(getByName, {}, { reserve }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Share creation temporarily unavailable" });
    expect(getByName).not.toHaveBeenCalled();
  });

  it("does not reserve quota or wake a share for an invalid Loro snapshot", async () => {
    let { default: worker } = await import("./worker.ts");
    let reserve = vi.fn(async () => ({ status: "reserved" as const }));
    let getByName = vi.fn();
    let body = { ...createShareBody(), snapshot: encodeBase64(new Uint8Array([1, 2, 3])) };

    let response = await worker.fetch(
      createShareRequest(body),
      relayEnv(getByName, {}, { reserve }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid snapshot" });
    expect(reserve).not.toHaveBeenCalled();
    expect(getByName).not.toHaveBeenCalled();
  });

  it.each([
    ["session", "POST", {}, "SHARE_SESSION_RATE_LIMITER", "share-session"],
    ["ws", "GET", { Upgrade: "websocket" }, "SHARE_WEBSOCKET_RATE_LIMITER", "share-websocket"],
  ] as const)(
    "applies actor, share, and aggregate edge keys to the %s route",
    async (action, method, headers, limiterName, routeKey) => {
      let { default: worker } = await import("./worker.ts");
      let getByName = vi.fn(() => ({ fetch: vi.fn(async () => new Response(null)) }));
      let limiter = rateLimiter(true);
      let response = await worker.fetch(
        new Request(`https://relay.example/api/shares/${validShareId}/${action}`, {
          headers,
          method,
        }),
        relayEnv(getByName, {}, { [limiterName]: limiter }),
      );

      expect(response.status).toBe(200);
      expect(limiter.limit.mock.calls.map(([input]) => input.key)).toEqual([
        `${routeKey}:actor:unknown`,
        `${routeKey}:resource:${validShareId}`,
        `${routeKey}:resource:all`,
      ]);
    },
  );

  it.each([
    ["share-session:actor:unknown", ["share-session:actor:unknown"]],
    [
      `share-session:resource:${validShareId}`,
      ["share-session:actor:unknown", `share-session:resource:${validShareId}`],
    ],
  ] as const)(
    "stops edge rate-limit checks after %s is rejected",
    async (rejectedKey, expectedKeys) => {
      let { default: worker } = await import("./worker.ts");
      let getByName = vi.fn();
      let limiter = {
        limit: vi.fn(async ({ key }: { key: string }) => ({ success: key != rejectedKey })),
      };

      let response = await worker.fetch(
        new Request(`https://relay.example/api/shares/${validShareId}/session`, {
          method: "POST",
        }),
        relayEnv(getByName, {}, { SHARE_SESSION_RATE_LIMITER: limiter }),
      );

      expect(response.status).toBe(429);
      expect(limiter.limit.mock.calls.map(([input]) => input.key)).toEqual(expectedKeys);
      expect(getByName).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["session", "GET", {}, 404],
    ["ws", "POST", { Upgrade: "websocket" }, 404],
    ["ws", "GET", {}, 426],
  ] as const)(
    "rejects invalid %s request shape before waking a share Durable Object",
    async (action, method, headers, expectedStatus) => {
      let { default: worker } = await import("./worker.ts");
      let getByName = vi.fn();

      let response = await worker.fetch(
        new Request(`https://relay.example/api/shares/${validShareId}/${action}`, {
          headers,
          method,
        }),
        relayEnv(getByName),
      );

      expect(response.status).toBe(expectedStatus);
      expect(getByName).not.toHaveBeenCalled();
    },
  );

  it.each([null, "BBBBBBBBBBBBBBBBBBBBBB"])(
    "rejects a missing or mismatched create idempotency key (%s)",
    async (idempotencyKey) => {
      let { default: worker } = await import("./worker.ts");
      let fetch = vi.fn(async () => new Response(null, { status: 201 }));
      let getByName = vi.fn(() => ({ fetch }));
      let headers = new Headers({ "Content-Type": "application/json" });
      if (idempotencyKey != null) headers.set("Idempotency-Key", idempotencyKey);

      let response = await worker.fetch(
        new Request("https://relay.example/api/shares", {
          body: JSON.stringify(createShareBody()),
          headers,
          method: "POST",
        }),
        relayEnv(getByName),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid idempotency key" });
      expect(getByName).not.toHaveBeenCalled();
    },
  );

  it("compacts stored share update logs into a snapshot", async () => {
    let { GroveShareRoom } = await import("./worker.ts");
    let storage = new MemoryDurableObjectStorage();
    let room = Object.create(GroveShareRoom.prototype) as TestGroveShareRoom & TestStorageRoom;
    let doc = new LoroDoc();
    doc.getText("markdown").insert(0, "# First\n");
    doc.commit();
    room.ctx = { storage };
    room.dirty = false;
    room.doc = doc;
    room.firstDirtyAt = 0;
    room.maxSaveTimer = null;
    room.pendingHostSave = false;
    room.saveTimer = null;
    room.saving = false;

    for (let sequence = 1; sequence <= 256; sequence++) {
      storage.records.set(
        `update:${String(sequence).padStart(12, "0")}`,
        new Uint8Array([1, 2, 3]),
      );
    }
    storage.records.set("updateLogBytes", 256 * 3);
    storage.records.set("updateLogSequence", 256);
    expect([...storage.records.keys()]).toEqual(
      expect.arrayContaining(["update:000000000001", "updateLogBytes", "updateLogSequence"]),
    );

    await room.flushSnapshot({ force: true });

    expect(storage.records.has("snapshot")).toBe(true);
    expect([...storage.records.keys()].filter((key) => key.startsWith("update:"))).toEqual([]);
    expect(storage.records.has("updateLogBytes")).toBe(false);
    expect(storage.records.has("updateLogSequence")).toBe(false);
  });
});

type TestGroveShareRoom = {
  fetch(request: Request): Promise<Response>;
  shareRecord: ShareRecord | null;
};

type TestStorageRoom = {
  ctx: { storage: MemoryDurableObjectStorage };
  dirty: boolean;
  doc: LoroDoc;
  firstDirtyAt: number;
  flushSnapshot(options: { force?: boolean }): Promise<void>;
  maxSaveTimer: ReturnType<typeof setTimeout> | null;
  pendingHostSave: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;
  saving: boolean;
};

class MemoryDurableObjectStorage {
  records = new Map<string, unknown>();

  async delete(keys: string | string[]) {
    if (Array.isArray(keys) && keys.length > 128) throw new Error("delete batch is too large");
    for (let key of Array.isArray(keys) ? keys : [keys]) this.records.delete(key);
  }

  async get<T>(key: string) {
    return this.records.get(key) as T | undefined;
  }

  async list<T>(options: { prefix?: string } = {}) {
    let result = new Map<string, T>();
    for (let [key, value] of this.records) {
      if (options.prefix && !key.startsWith(options.prefix)) continue;
      result.set(key, value as T);
    }
    return result;
  }

  async put<T>(key: string, value: T) {
    this.records.set(key, value);
  }

  async transaction<T>(callback: (txn: MemoryDurableObjectTransaction) => Promise<T>) {
    let records = new Map(this.records);
    let result = await callback(new MemoryDurableObjectTransaction(records));
    this.records = records;
    return result;
  }
}

class MemoryDurableObjectTransaction {
  constructor(private readonly records: Map<string, unknown>) {}

  async delete(keys: string | string[]) {
    if (Array.isArray(keys) && keys.length > 128) throw new Error("delete batch is too large");
    for (let key of Array.isArray(keys) ? keys : [keys]) this.records.delete(key);
  }

  async get<T>(key: string) {
    return this.records.get(key) as T | undefined;
  }

  async list<T>(options: { prefix?: string } = {}) {
    let result = new Map<string, T>();
    for (let [key, value] of this.records) {
      if (options.prefix && !key.startsWith(options.prefix)) continue;
      result.set(key, value as T);
    }
    return result;
  }

  async put<T>(key: string, value: T) {
    this.records.set(key, value);
  }
}

function shareRecord(): ShareRecord {
  return {
    createdAt: Date.now(),
    displayName: "note.md",
    expiresAt: Date.now() + 60_000,
    guestSecretHash: validHash,
    hostSecretHash: validHash,
    schemaVersion: 1,
    shareId: validShareId,
  };
}

function createShareBody() {
  let doc = new LoroDoc();
  let snapshot = doc.export({ mode: "snapshot" });
  doc.free();
  return {
    displayName: "note.md",
    expiresAt: Date.now() + 60_000,
    guestSecretHash: validHash,
    hostSecretHash: validHash,
    shareId: validShareId,
    snapshot: encodeBase64(snapshot),
  };
}

function createShareRequest(body = createShareBody()) {
  return new Request("https://relay.example/api/shares", {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": validShareId,
    },
    method: "POST",
  });
}

type RelayEnvOverrides = {
  CREATE_SHARE_RATE_LIMITER?: ReturnType<typeof rateLimiter>;
  SHARE_SESSION_RATE_LIMITER?: ReturnType<typeof rateLimiter>;
  SHARE_WEBSOCKET_RATE_LIMITER?: ReturnType<typeof rateLimiter>;
  reserve?: ReturnType<typeof vi.fn>;
};

function relayEnv(
  getByName: ReturnType<typeof vi.fn>,
  allowed: { create?: boolean; session?: boolean; websocket?: boolean } = {},
  overrides: RelayEnvOverrides = {},
) {
  let reserve = overrides.reserve ?? vi.fn(async () => ({ status: "reserved" as const }));
  return {
    GROVE_CREATE_QUOTA: { getByName: vi.fn(() => ({ reserve })) },
    GROVE_SHARE_ROOMS: { getByName },
    CREATE_SHARE_RATE_LIMITER:
      overrides.CREATE_SHARE_RATE_LIMITER ?? rateLimiter(allowed.create ?? true),
    SHARE_SESSION_RATE_LIMITER:
      overrides.SHARE_SESSION_RATE_LIMITER ?? rateLimiter(allowed.session ?? true),
    SHARE_WEBSOCKET_RATE_LIMITER:
      overrides.SHARE_WEBSOCKET_RATE_LIMITER ?? rateLimiter(allowed.websocket ?? true),
  } as unknown as Env;
}

function rateLimiter(success: boolean) {
  return { limit: vi.fn(async (_input: { key: string }) => ({ success })) };
}
