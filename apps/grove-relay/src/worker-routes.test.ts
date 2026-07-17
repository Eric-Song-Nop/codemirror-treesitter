import { describe, expect, it, vi } from "vite-plus/test";
import { LoroDoc } from "loro-crdt";
import type { ShareRecord } from "./share.ts";

const validShareId = "AAAAAAAAAAAAAAAAAAAAAA";
const validHash = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

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

function relayEnv(
  getByName: ReturnType<typeof vi.fn>,
  allowed: { create?: boolean; session?: boolean; websocket?: boolean } = {},
) {
  return {
    GROVE_SHARE_ROOMS: { getByName },
    CREATE_SHARE_RATE_LIMITER: rateLimiter(allowed.create ?? true),
    SHARE_SESSION_RATE_LIMITER: rateLimiter(allowed.session ?? true),
    SHARE_WEBSOCKET_RATE_LIMITER: rateLimiter(allowed.websocket ?? true),
  } as unknown as Env;
}

function rateLimiter(success: boolean) {
  return { limit: vi.fn(async () => ({ success })) };
}
