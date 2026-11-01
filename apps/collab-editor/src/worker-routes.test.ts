import { ShareRoom, relayCreateAdmittedHeader } from "@codemirror-treesitter/relay-core";
import { encodeBase64 } from "@codemirror-treesitter/relay-core/client";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it, vi } from "vite-plus/test";

const validShareId = "AAAAAAAAAAAAAAAAAAAAAA";
const validHash = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

describe("collab editor Worker routes", () => {
  it("runs the shared relay-core room and quota Durable Objects", async () => {
    let { CollabCreateQuota, CollabRoom } = await import("./worker.ts");
    let { CreateQuota } = await import("@codemirror-treesitter/relay-core");

    expect(Object.create(CollabRoom.prototype)).toBeInstanceOf(ShareRoom);
    expect(Object.create(CollabCreateQuota.prototype)).toBeInstanceOf(CreateQuota);
  });

  it("no longer serves unauthenticated legacy room WebSockets", async () => {
    let { default: worker } = await import("./worker.ts");
    let env = collabEnv();

    let response = await worker.fetch(
      new Request("https://collab.example/api/doc/Ab3kP9qLm2xZ/ws", {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );

    expect(response.status).toBe(404);
    expect(env.COLLAB_ROOMS.getByName).not.toHaveBeenCalled();
  });

  it("does not create rooms through the per-share POST route", async () => {
    let { default: worker } = await import("./worker.ts");
    let env = collabEnv();

    let response = await worker.fetch(
      new Request(`https://collab.example/api/shares/${validShareId}`, {
        body: JSON.stringify(createShareBody()),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": validShareId,
          [relayCreateAdmittedHeader]: "1",
        },
        method: "POST",
      }),
      env,
    );

    expect(response.status).toBe(404);
    expect(env.COLLAB_ROOMS.getByName).not.toHaveBeenCalled();
    expect(env.COLLAB_CREATE_QUOTA.getByName).not.toHaveBeenCalled();
    expect(env.CREATE_SHARE_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });

  it("rate-limits and quota-admits room creation before waking a room", async () => {
    let { default: worker } = await import("./worker.ts");
    let limited = collabEnv({ create: false });
    let response = await worker.fetch(createShareRequest(), limited);

    expect(response.status).toBe(429);
    expect(limited.COLLAB_ROOMS.getByName).not.toHaveBeenCalled();

    let env = collabEnv();
    let created = await worker.fetch(createShareRequest(), env);

    expect(created.status).toBe(201);
    expect(env.reserve).toHaveBeenCalledTimes(1);
    expect(env.forwarded[0]!.headers.get(relayCreateAdmittedHeader)).toBe("1");
  });

  it.each([
    ["session", "POST", {}, "SHARE_SESSION_RATE_LIMITER"],
    ["ws", "GET", { Upgrade: "websocket" }, "SHARE_WEBSOCKET_RATE_LIMITER"],
  ] as const)("rate-limits the %s route", async (action, method, headers, limiter) => {
    let { default: worker } = await import("./worker.ts");
    let env = collabEnv({ [limiter]: false });

    let response = await worker.fetch(
      new Request(`https://collab.example/api/shares/${validShareId}/${action}`, {
        headers,
        method,
      }),
      env,
    );

    expect(response.status).toBe(429);
    expect(env.COLLAB_ROOMS.getByName).not.toHaveBeenCalled();
  });

  it("rejects WebSocket upgrades from origins outside ALLOWED_ORIGINS", async () => {
    let { default: worker } = await import("./worker.ts");
    let env = Object.assign(collabEnv(), { ALLOWED_ORIGINS: "https://collab.example" as "" });

    let denied = await worker.fetch(
      new Request(`https://collab.example/api/shares/${validShareId}/ws`, {
        headers: { Origin: "https://evil.example", Upgrade: "websocket" },
      }),
      env,
    );

    expect(denied.status).toBe(403);
    expect(env.COLLAB_ROOMS.getByName).not.toHaveBeenCalled();
  });
});

function collabEnv(
  allowed: Partial<
    Record<"create" | "SHARE_SESSION_RATE_LIMITER" | "SHARE_WEBSOCKET_RATE_LIMITER", boolean>
  > = {},
) {
  let forwarded: Request[] = [];
  let reserve = vi.fn(async () => ({ status: "reserved" as const }));
  let fetch = vi.fn(async (request: Request) => {
    forwarded.push(request);
    return new Response(null, { status: request.method == "POST" ? 201 : 200 });
  });
  let env = {
    ALLOWED_ORIGINS: "",
    COLLAB_CREATE_QUOTA: { getByName: vi.fn(() => ({ reserve })) },
    COLLAB_ROOMS: { getByName: vi.fn(() => ({ fetch })) },
    CREATE_SHARE_RATE_LIMITER: rateLimiter(allowed.create ?? true),
    SHARE_SESSION_RATE_LIMITER: rateLimiter(allowed.SHARE_SESSION_RATE_LIMITER ?? true),
    SHARE_WEBSOCKET_RATE_LIMITER: rateLimiter(allowed.SHARE_WEBSOCKET_RATE_LIMITER ?? true),
  };
  return Object.assign(env as unknown as Env & typeof env, { forwarded, reserve });
}

function rateLimiter(success: boolean) {
  return { limit: vi.fn(async (_input: { key: string }) => ({ success })) };
}

function createShareBody() {
  let doc = new LoroDoc();
  let snapshot = doc.export({ mode: "snapshot" });
  doc.free();
  return {
    displayName: "Collaborative LiveMD",
    expiresAt: Date.now() + 60_000,
    guestSecretHash: validHash,
    hostSecretHash: validHash,
    shareId: validShareId,
    snapshot: encodeBase64(snapshot),
  };
}

function createShareRequest() {
  return new Request("https://collab.example/api/shares", {
    body: JSON.stringify(createShareBody()),
    headers: { "Content-Type": "application/json", "Idempotency-Key": validShareId },
    method: "POST",
  });
}
