import { describe, expect, it, vi } from "vite-plus/test";
import type { ShareRecord } from "./share.ts";

const validShareId = "AAAAAAAAAAAAAAAAAAAAAA";
const validHash = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

describe("shared file Worker routes", () => {
  it("rejects legacy room WebSockets for share Durable Objects", async () => {
    let { CollabRoom } = await import("./worker.ts");
    let room = Object.create(CollabRoom.prototype) as TestCollabRoom;
    room.shareRecord = shareRecord();

    let response = await room.fetch(
      new Request(`http://example.test/api/doc/${validShareId}/ws`, {
        headers: { Upgrade: "websocket" },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Share session required");
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
        COLLAB_ROOMS: { getByName },
        CREATE_SHARE_RATE_LIMITER: {
          limit: vi.fn(async () => ({ success: false })),
        },
      } as unknown as Env,
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Share creation rate limit exceeded" });
    expect(getByName).not.toHaveBeenCalled();
  });
});

type TestCollabRoom = {
  fetch(request: Request): Promise<Response>;
  shareRecord: ShareRecord | null;
};

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
