import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createQuotaRetentionWindowDays,
  maxCreateQuotaRetainedInitialSnapshotBytes,
  maxCreateQuotaRetainedSnapshotBytes,
  maxCreateQuotaSharesPerUtcDay,
  maxCreateQuotaSnapshotBytesPerUtcDay,
  maxShareTtlMs,
  maxSnapshotBytes,
  shareRetentionMs,
} from "./share-limits.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("global Grove create quota", () => {
  it("makes a same-day share reservation idempotent", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 6, 17, 12));
    let storage = new MemoryDurableObjectStorage();
    let quota = await createQuota(storage);

    let first = await quota.reserve(shareId(1), 1024);
    let replay = await quota.reserve(shareId(1), 1024);

    expect(first).toEqual({
      distinctCreates: 1,
      snapshotBytes: 1024,
      status: "reserved",
      utcDay: "2026-07-17",
    });
    expect(replay).toEqual({
      distinctCreates: 1,
      snapshotBytes: 1024,
      status: "replayed",
      utcDay: "2026-07-17",
    });
  });

  it("rejects a same-day reservation that changes decoded snapshot bytes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 6, 17, 12));
    let quota = await createQuota(new MemoryDurableObjectStorage());

    await quota.reserve(shareId(1), 1024);
    let conflict = await quota.reserve(shareId(1), 2048);

    expect(conflict).toMatchObject({
      distinctCreates: 1,
      snapshotBytes: 1024,
      status: "conflict",
      utcDay: "2026-07-17",
    });
  });

  it("bounds distinct create reservations per UTC day", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 6, 17, 12));
    let quota = await createQuota(new MemoryDurableObjectStorage());
    for (let index = 0; index < maxCreateQuotaSharesPerUtcDay; index++) {
      expect((await quota.reserve(shareId(index), 1)).status).toBe("reserved");
    }

    let exhausted = await quota.reserve(shareId(maxCreateQuotaSharesPerUtcDay), 1);

    expect(exhausted).toMatchObject({
      distinctCreates: maxCreateQuotaSharesPerUtcDay,
      reason: "count",
      snapshotBytes: maxCreateQuotaSharesPerUtcDay,
      status: "exhausted",
      utcDay: "2026-07-17",
    });
  });

  it("bounds decoded snapshot bytes per UTC day", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 6, 17, 12));
    let quota = await createQuota(new MemoryDurableObjectStorage());

    expect((await quota.reserve(shareId(1), maxCreateQuotaSnapshotBytesPerUtcDay)).status).toBe(
      "reserved",
    );
    let exhausted = await quota.reserve(shareId(2), 1);

    expect(exhausted).toMatchObject({
      distinctCreates: 1,
      reason: "bytes",
      snapshotBytes: maxCreateQuotaSnapshotBytesPerUtcDay,
      status: "exhausted",
      utcDay: "2026-07-17",
    });
  });

  it("starts a fresh quota record on the next UTC day", async () => {
    let now = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 6, 17, 23, 59));
    let storage = new MemoryDurableObjectStorage();
    let quota = await createQuota(storage);
    await quota.reserve(shareId(1), maxCreateQuotaSnapshotBytesPerUtcDay);

    now.mockReturnValue(Date.UTC(2026, 6, 18, 0, 1));
    let nextDay = await quota.reserve(shareId(2), 1);

    expect(nextDay).toEqual({
      distinctCreates: 1,
      snapshotBytes: 1,
      status: "reserved",
      utcDay: "2026-07-18",
    });
    expect(storage.records).toHaveLength(1);
  });

  it("exports explicit retained-cost planning bounds for TTL plus retention", () => {
    expect(maxCreateQuotaSharesPerUtcDay).toBe(100);
    expect(maxCreateQuotaSnapshotBytesPerUtcDay).toBe(64 * 1024 * 1024);
    expect(createQuotaRetentionWindowDays).toBe(37);
    expect(createQuotaRetentionWindowDays * 24 * 60 * 60 * 1000).toBe(
      maxShareTtlMs + shareRetentionMs,
    );
    expect(maxCreateQuotaRetainedInitialSnapshotBytes).toBe(
      createQuotaRetentionWindowDays * maxCreateQuotaSnapshotBytesPerUtcDay,
    );
    expect(maxCreateQuotaRetainedSnapshotBytes).toBe(
      createQuotaRetentionWindowDays * maxCreateQuotaSharesPerUtcDay * maxSnapshotBytes,
    );
    expect(maxCreateQuotaRetainedInitialSnapshotBytes).toBeLessThan(
      maxCreateQuotaRetainedSnapshotBytes,
    );
  });
});

type QuotaResult = {
  distinctCreates: number;
  reason?: "bytes" | "count";
  snapshotBytes: number;
  status: "conflict" | "exhausted" | "replayed" | "reserved";
  utcDay: string;
};

type TestQuota = {
  ctx: { storage: MemoryDurableObjectStorage };
  reserve(shareId: string, decodedSnapshotBytes: number): Promise<QuotaResult>;
};

async function createQuota(storage: MemoryDurableObjectStorage) {
  let { GroveCreateQuota } = await import("./worker.ts");
  let quota = Object.create(GroveCreateQuota.prototype) as TestQuota;
  quota.ctx = { storage };
  return quota;
}

function shareId(index: number) {
  return index.toString(36).padStart(22, "A");
}

class MemoryDurableObjectStorage {
  records = new Map<string, unknown>();

  async get<T>(key: string) {
    return this.records.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T) {
    this.records.set(key, structuredClone(value));
  }

  async transaction<T>(callback: (txn: MemoryDurableObjectStorage) => Promise<T>) {
    let previous = this.records;
    let records = new Map(
      [...previous].map(([key, value]) => [key, structuredClone(value)] as const),
    );
    let transaction = new MemoryDurableObjectStorage();
    transaction.records = records;
    try {
      let result = await callback(transaction);
      this.records = records;
      return result;
    } catch (error) {
      this.records = previous;
      throw error;
    }
  }
}
