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
    let writeDataPoint = vi.fn();
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
        GROVE_METRICS: { writeDataPoint },
      } as unknown as Env,
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Share creation rate limit exceeded" });
    expect(getByName).not.toHaveBeenCalled();
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ["rate_limit", "", "", "create_share"],
      doubles: [expect.any(Number), 1, 0, 0, 0, 0],
      indexes: ["rate_limit"],
    });
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
    room.saveTimer = null;
    room.saving = false;

    await room.appendStoredDocumentUpdates([new Uint8Array([1, 2, 3])]);
    expect([...storage.records.keys()]).toEqual(
      expect.arrayContaining(["update:000000000001", "updateLogBytes", "updateLogSequence"]),
    );

    await room.flushSnapshot({ force: true });

    expect(storage.records.has("snapshot")).toBe(true);
    expect([...storage.records.keys()]).not.toEqual(
      expect.arrayContaining(["update:000000000001", "updateLogBytes", "updateLogSequence"]),
    );
  });
});

type TestGroveShareRoom = {
  fetch(request: Request): Promise<Response>;
  shareRecord: ShareRecord | null;
};

type TestStorageRoom = {
  appendStoredDocumentUpdates(updates: Uint8Array[]): Promise<number>;
  ctx: { storage: MemoryDurableObjectStorage };
  dirty: boolean;
  doc: LoroDoc;
  firstDirtyAt: number;
  flushSnapshot(options: { force?: boolean }): Promise<void>;
  maxSaveTimer: ReturnType<typeof setTimeout> | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  saving: boolean;
};

class MemoryDurableObjectStorage {
  records = new Map<string, unknown>();

  async delete(keys: string | string[]) {
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
