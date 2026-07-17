import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ShareRelayConnection,
  maxQueuedRelayMessages,
  maxSingleQueuedDocumentUpdateBytes,
  parseShareRelayStatus,
} from "./share-relay-connection.ts";
import { RelayWireKind, decodeRelayWireFrame, encodeRelayWireMessage } from "./relay-protocol.ts";

let mockSockets: MockWebSocket[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mockSockets = [];
});

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

  it("sends the share session token as the first WebSocket auth frame", () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", MockWebSocket);

    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });

    connection.connect();

    expect(mockSockets).toHaveLength(1);
    let socket = mockSockets[0]!;
    expect(socket.url).toBe("wss://relay.example/api/shares/share-id/ws?clientId=client-id");
    socket.open();

    expect(socket.sent).toEqual([
      JSON.stringify({
        clientId: "client-id",
        sessionToken: "session-token",
        type: "auth",
        versionVector: [],
      }),
    ]);

    connection.close();
  });

  it("treats sync-ready control messages as initial sync completion", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", { getRandomValues: (array: Uint16Array) => array.fill(0) });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", MockWebSocket);

    let states: string[] = [];
    let doc = new LoroDoc();
    doc.getText("markdown").insert(0, "local");
    doc.commit();
    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc,
      onConnectionState: (state) => states.push(state),
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });

    connection.enqueueDocumentUpdate(doc.export({ mode: "update" }));
    connection.connect();
    let socket = mockSockets[0]!;
    socket.open();
    socket.receive(JSON.stringify({ type: "sync-ready", versionVector: [] }));
    await vi.advanceTimersByTimeAsync(50);

    expect(states).toEqual(["connecting", "connected"]);
    let binaryFrames = socket.sent.filter((item): item is Uint8Array => item instanceof Uint8Array);
    expect(binaryFrames).toHaveLength(1);
    expect(decodeRelayWireFrame(binaryFrames[0]!).map((message) => message.kind)).toEqual([
      RelayWireKind.Doc,
    ]);

    connection.close();
  });

  it("flushes queued relay messages immediately", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", MockWebSocket);

    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });

    connection.connect();
    let socket = mockSockets[0]!;
    socket.open();
    socket.receive(JSON.stringify({ type: "sync-ready", versionVector: [] }));

    connection.enqueueHostSaveAck(new Uint8Array([7]));
    connection.flushNow();

    let hostSaveAcks = sentMessages(socket).filter(
      (message) => message.kind == RelayWireKind.HostSaveAck,
    );
    expect(hostSaveAcks).toEqual([
      { kind: RelayWireKind.HostSaveAck, payload: new Uint8Array([7]) },
    ]);

    await vi.advanceTimersByTimeAsync(50);
    hostSaveAcks = sentMessages(socket).filter(
      (message) => message.kind == RelayWireKind.HostSaveAck,
    );
    expect(hostSaveAcks).toHaveLength(1);

    connection.close();
  });

  it("splits a queued flush into relay-compatible batches", () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", MockWebSocket);

    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });
    connection.connect();
    let socket = mockSockets[0]!;
    socket.open();
    socket.receive(JSON.stringify({ type: "sync-ready", versionVector: [] }));

    for (let index = 0; index < 130; index++) {
      connection.enqueueHostSaveAck(new Uint8Array([index >> 8, index & 0xff]));
    }
    connection.flushNow();

    let batches = sentHostSaveAckBatches(socket);
    expect(batches.map((batch) => batch.length)).toEqual([64, 64, 2]);
    expect(batches.flat().map((message) => message.kind)).toEqual(
      Array(130).fill(RelayWireKind.HostSaveAck),
    );

    connection.close();
  });

  it("retains the unsent tail when a later relay batch send fails", () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", MockWebSocket);

    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });
    connection.connect();
    let firstSocket = mockSockets[0]!;
    firstSocket.open();
    firstSocket.receive(JSON.stringify({ type: "sync-ready", versionVector: [] }));

    for (let index = 0; index < 130; index++) {
      connection.enqueueHostSaveAck(new Uint8Array([index >> 8, index & 0xff]));
    }
    firstSocket.failBinarySendAt = 3;
    connection.flushNow();

    expect(sentHostSaveAckBatches(firstSocket).map((batch) => batch.length)).toEqual([64]);

    connection.connect();
    let retrySocket = mockSockets[1]!;
    retrySocket.open();
    retrySocket.receive(JSON.stringify({ type: "sync-ready", versionVector: [] }));
    connection.flushNow();

    let delivered = [
      ...sentHostSaveAckBatches(firstSocket).flat(),
      ...sentHostSaveAckBatches(retrySocket).flat(),
    ];
    expect(delivered).toHaveLength(130);
    expect(delivered.map((message) => (message.payload[0]! << 8) | message.payload[1]!)).toEqual(
      Array.from({ length: 130 }, (_, index) => index),
    );
    expect(sentHostSaveAckBatches(retrySocket).map((batch) => batch.length)).toEqual([64, 2]);

    connection.close();
  });

  it("flushes queued relay messages before closing", () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", MockWebSocket);

    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });

    connection.connect();
    let socket = mockSockets[0]!;
    socket.open();
    socket.receive(JSON.stringify({ type: "sync-ready", versionVector: [] }));

    connection.enqueueHostSaveAck(new Uint8Array([9]));
    connection.close();

    let hostSaveAcks = sentMessages(socket).filter(
      (message) => message.kind == RelayWireKind.HostSaveAck,
    );
    expect(hostSaveAcks).toEqual([
      { kind: RelayWireKind.HostSaveAck, payload: new Uint8Array([9]) },
    ]);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("merges offline document updates before replaying them to the relay", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", { getRandomValues: (array: Uint16Array) => array.fill(0) });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", MockWebSocket);

    let doc = new LoroDoc();
    let text = doc.getText("markdown");
    doc.commit();
    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc,
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });
    connection.pause();

    text.insert(0, "first");
    doc.commit();
    expect(connection.enqueueDocumentUpdate(new Uint8Array([1]))).toBe(true);
    text.insert(5, " second");
    doc.commit();
    expect(connection.enqueueDocumentUpdate(new Uint8Array([2]))).toBe(true);

    connection.connect();
    let socket = mockSockets[0]!;
    socket.open();
    let serverDoc = new LoroDoc();
    socket.receive(
      encodeRelayWireMessage(RelayWireKind.Snapshot, serverDoc.export({ mode: "snapshot" })),
    );
    socket.receive(JSON.stringify({ type: "sync-ready", versionVector: [] }));
    await vi.advanceTimersByTimeAsync(50);

    let binaryFrames = socket.sent.filter((item): item is Uint8Array => item instanceof Uint8Array);
    expect(binaryFrames).toHaveLength(1);
    let messages = decodeRelayWireFrame(binaryFrames[0]!);
    expect(messages.map((message) => message.kind)).toEqual([RelayWireKind.Doc]);
    serverDoc.import(messages[0]!.payload);
    expect(serverDoc.getText("markdown").toString()).toBe("first second");

    connection.close();
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
      expect(connection.enqueueDocumentUpdate(new Uint8Array([index & 0xff]))).toBe(true);
    }

    expect(connection.enqueueDocumentUpdate(new Uint8Array([1]))).toBeNull();
    expect(states).toEqual(["resync-required"]);
  });
});

function sentMessages(socket: MockWebSocket) {
  return sentBatches(socket).flat();
}

function sentBatches(socket: MockWebSocket) {
  return socket.sent
    .filter((item): item is Uint8Array => item instanceof Uint8Array)
    .map((frame) => decodeRelayWireFrame(frame));
}

function sentHostSaveAckBatches(socket: MockWebSocket) {
  return sentBatches(socket)
    .map((batch) => batch.filter((message) => message.kind == RelayWireKind.HostSaveAck))
    .filter((batch) => batch.length > 0);
}

class MockWebSocket extends EventTarget {
  static readonly CLOSED = 3;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;

  binaryType: BinaryType = "arraybuffer";
  failBinarySendAt: number | null = null;
  readonly sent: Array<string | Uint8Array> = [];
  readyState = MockWebSocket.CONNECTING;
  private binarySendCount = 0;

  constructor(readonly url: string) {
    super();
    mockSockets.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: Uint8Array | string) {
    let event = new Event("message") as MessageEvent<ArrayBuffer | string>;
    Object.defineProperty(event, "data", {
      value:
        typeof data == "string"
          ? data
          : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    });
    this.dispatchEvent(event);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data == "string") {
      this.sent.push(data);
      return;
    }
    this.binarySendCount++;
    if (this.binarySendCount == this.failBinarySendAt) throw new Error("injected send failure");
    if (ArrayBuffer.isView(data)) {
      this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
    }
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}
