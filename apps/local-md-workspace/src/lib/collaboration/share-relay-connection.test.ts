import { describe, expect, it } from "vite-plus/test";
import { parseShareRelayAck, parseShareRelayStatus } from "./share-relay-connection.ts";

describe("shared file relay connection helpers", () => {
  it("parses share status frames", () => {
    let payload = new TextEncoder().encode(
      JSON.stringify({
        displayName: "note.md",
        expiresAt: null,
        guestCount: 2,
        hostOnline: true,
        peerCount: 3,
        pendingHostSave: true,
        revokedAt: null,
        shareId: "share-id",
      }),
    );

    expect(parseShareRelayStatus(payload)).toEqual({
      displayName: "note.md",
      expiresAt: null,
      guestCount: 2,
      hostOnline: true,
      peerCount: 3,
      pendingHostSave: true,
      revokedAt: null,
      shareId: "share-id",
    });
  });

  it("defaults optional share status metadata for older relays", () => {
    let payload = new TextEncoder().encode(
      JSON.stringify({
        displayName: "note.md",
        expiresAt: null,
        hostOnline: true,
        revokedAt: null,
        shareId: "share-id",
      }),
    );

    expect(parseShareRelayStatus(payload)).toEqual({
      displayName: "note.md",
      expiresAt: null,
      guestCount: 0,
      hostOnline: true,
      peerCount: 0,
      pendingHostSave: false,
      revokedAt: null,
      shareId: "share-id",
    });
  });

  it("rejects malformed share status frames", () => {
    expect(() => parseShareRelayStatus(new TextEncoder().encode("{}"))).toThrow(
      "Invalid share status.",
    );
    expect(() => parseShareRelayStatus(new TextEncoder().encode("not json"))).toThrow();
  });

  it("parses relay acknowledgement frames", () => {
    let payload = new TextEncoder().encode(
      JSON.stringify({
        acceptedAt: Date.UTC(2026, 5, 6),
        sequence: 7,
        shareId: "share-id",
      }),
    );

    expect(parseShareRelayAck(payload)).toEqual({
      acceptedAt: Date.UTC(2026, 5, 6),
      sequence: 7,
      shareId: "share-id",
    });
  });

  it("rejects malformed relay acknowledgement frames", () => {
    expect(() => parseShareRelayAck(new TextEncoder().encode("{}"))).toThrow("Invalid relay ack.");
    expect(() => parseShareRelayAck(new TextEncoder().encode("not json"))).toThrow();
  });
});
