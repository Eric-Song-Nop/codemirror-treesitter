import { describe, expect, it } from "vite-plus/test";
import {
  createRelayShare,
  createRelayShareSession,
  revokeRelayShare,
  rotateRelayShare,
  shareRelayWebSocketUrl,
} from "./share-relay-client.ts";

describe("shared file relay client", () => {
  it("creates relay shares with a normalized origin and encoded snapshot", async () => {
    let calls: Array<{ body: string; init?: RequestInit; url: string }> = [];
    let fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: requestBody(init?.body), init, url: requestUrl(input) });
      return new Response("{}", { status: 201 });
    }) as typeof fetch;

    await createRelayShare(
      "relay.example/path?ignored=1",
      {
        displayName: "note.md",
        expiresAt: Date.UTC(2026, 5, 13),
        guestSecretHash: "guest-hash",
        hostSecretHash: "host-hash",
        shareId: "share-id",
        snapshot: new Uint8Array([1, 2, 3, 250]),
      },
      fetchImpl,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://relay.example/api/shares");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toEqual({
      "Content-Type": "application/json",
      "Idempotency-Key": "share-id",
    });
    expect(JSON.parse(calls[0]!.body)).toEqual({
      displayName: "note.md",
      expiresAt: Date.UTC(2026, 5, 13),
      guestSecretHash: "guest-hash",
      hostSecretHash: "host-hash",
      shareId: "share-id",
      snapshot: "AQID+g==",
    });
  });

  it("fails before sending when the relay origin is missing or malformed", async () => {
    let fetchImpl = (() => {
      throw new Error("unexpected fetch");
    }) as typeof fetch;

    await expect(createRelayShare("", relayRequest(), fetchImpl)).rejects.toThrow(
      "Shared file relay is not configured.",
    );
    await expect(createRelayShare("https://", relayRequest(), fetchImpl)).rejects.toThrow(
      "Shared file relay is not configured.",
    );
  });

  it("surfaces relay creation failures", async () => {
    let fetchImpl = (async () => new Response("conflict", { status: 409 })) as typeof fetch;

    await expect(
      createRelayShare("https://relay.example", relayRequest(), fetchImpl),
    ).rejects.toThrow("Could not create shared file (409).");
  });

  it("replays the same idempotent create after a lost response", async () => {
    let calls: Array<{ body: string; idempotencyKey: string | null }> = [];
    let attempt = 0;
    let fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      let headers = new Headers(init?.headers);
      calls.push({
        body: requestBody(init?.body),
        idempotencyKey: headers.get("Idempotency-Key"),
      });
      if (attempt++ == 0) throw new TypeError("response lost");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    let request = relayRequest();

    await createRelayShare("https://relay.example", request, fetchImpl);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]!.idempotencyKey).toBe(request.shareId);
  });

  it("creates guest sessions without putting secrets in the URL", async () => {
    let calls: Array<{ body: string; init?: RequestInit; url: string }> = [];
    let fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: requestBody(init?.body), init, url: requestUrl(input) });
      return Response.json(
        {
          displayName: "note.md",
          expiresAt: 1_779_999_999_999,
          guestCount: 1,
          hostOnline: true,
          peerCount: 2,
          pendingHostSave: false,
          role: "guest",
          sessionToken: "session-token",
          shareExpiresAt: null,
          shareId: "share-id",
        },
        { status: 201 },
      );
    }) as typeof fetch;

    await expect(
      createRelayShareSession(
        "https://relay.example",
        "share-id",
        "guest",
        "guest-secret",
        fetchImpl,
      ),
    ).resolves.toEqual({
      displayName: "note.md",
      expiresAt: 1_779_999_999_999,
      guestCount: 1,
      hostOnline: true,
      peerCount: 2,
      pendingHostSave: false,
      role: "guest",
      sessionToken: "session-token",
      shareExpiresAt: null,
      shareId: "share-id",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://relay.example/api/shares/share-id/session");
    expect(calls[0]!.url).not.toContain("guest-secret");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      role: "guest",
      secret: "guest-secret",
    });
  });

  it("builds share WebSocket URLs from relay sessions", () => {
    expect(shareRelayWebSocketUrl("http://127.0.0.1:8787", "share-id", "client-id")).toBe(
      "ws://127.0.0.1:8787/api/shares/share-id/ws?clientId=client-id",
    );
    expect(shareRelayWebSocketUrl("https://relay.example", "share/id", "client id")).toBe(
      "wss://relay.example/api/shares/share%2Fid/ws?clientId=client+id",
    );
  });

  it("rotates guest capabilities through the relay", async () => {
    let calls: Array<{ body: string; init?: RequestInit; url: string }> = [];
    let fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: requestBody(init?.body), init, url: requestUrl(input) });
      return Response.json(
        {
          expiresAt: Date.UTC(2026, 5, 13),
          shareId: "share-id",
        },
        { status: 200 },
      );
    }) as typeof fetch;

    await expect(
      rotateRelayShare(
        "https://relay.example",
        "share-id",
        {
          expiresAt: Date.UTC(2026, 5, 13),
          hostSecret: "host-secret",
          nextGuestSecretHash: "next-guest-hash",
        },
        fetchImpl,
      ),
    ).resolves.toEqual({
      expiresAt: Date.UTC(2026, 5, 13),
      shareId: "share-id",
    });

    expect(calls).toEqual([
      {
        body: JSON.stringify({
          expiresAt: Date.UTC(2026, 5, 13),
          hostSecret: "host-secret",
          nextGuestSecretHash: "next-guest-hash",
        }),
        init: expect.objectContaining({
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
        url: "https://relay.example/api/shares/share-id/rotate",
      },
    ]);
  });

  it("revokes shared files through the relay", async () => {
    let calls: Array<{ body: string; init?: RequestInit; url: string }> = [];
    let fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: requestBody(init?.body), init, url: requestUrl(input) });
      return Response.json(
        {
          revokedAt: Date.UTC(2026, 5, 6),
          shareId: "share-id",
        },
        { status: 200 },
      );
    }) as typeof fetch;

    await expect(
      revokeRelayShare("https://relay.example", "share-id", "host-secret", fetchImpl),
    ).resolves.toEqual({
      revokedAt: Date.UTC(2026, 5, 6),
      shareId: "share-id",
    });

    expect(calls).toEqual([
      {
        body: JSON.stringify({ hostSecret: "host-secret" }),
        init: expect.objectContaining({
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
        url: "https://relay.example/api/shares/share-id/revoke",
      },
    ]);
  });
});

function relayRequest() {
  return {
    displayName: "note.md",
    expiresAt: null,
    guestSecretHash: "guest-hash",
    hostSecretHash: "host-hash",
    shareId: "share-id",
    snapshot: new Uint8Array([1]),
  };
}

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return input;
}

function requestBody(body: BodyInit | null | undefined) {
  return typeof body == "string" ? body : "";
}
