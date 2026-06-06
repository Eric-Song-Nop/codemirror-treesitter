import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vite-plus/test";
import {
  ShareRelayConnection,
  maxQueuedRelayMessages,
  maxSingleQueuedDocumentUpdateBytes,
  parseShareRelayAck,
  parseShareRelayStatus,
} from "./share-relay-connection.ts";

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

  it("enters resync-required when one local update exceeds the relay queue limit", () => {
    let states: string[] = [];
    let errors: string[] = [];
    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      onConnectionState: (state) => states.push(state),
      onError: (message) => errors.push(message),
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });

    expect(
      connection.enqueueDocumentUpdate(new Uint8Array(maxSingleQueuedDocumentUpdateBytes + 1)),
    ).toBeNull();
    expect(states).toEqual(["resync-required"]);
    expect(errors).toEqual(["Shared file update is too large to send through the relay."]);

    connection.connect();
    connection.pause();
    expect(states).toEqual(["resync-required", "resync-required", "resync-required"]);
  });

  it("enters resync-required when the offline relay queue reaches its message limit", () => {
    let states: string[] = [];
    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      onConnectionState: (state) => states.push(state),
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });

    for (let index = 0; index < maxQueuedRelayMessages; index++) {
      expect(connection.enqueueDocumentUpdate(new Uint8Array([index & 0xff]))).toBe(index + 1);
    }

    expect(connection.enqueueDocumentUpdate(new Uint8Array([1]))).toBeNull();
    expect(states).toEqual(["resync-required"]);
  });
});
