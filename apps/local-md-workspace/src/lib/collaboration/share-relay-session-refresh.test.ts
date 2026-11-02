import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ShareRelayConnection } from "./share-relay-connection.ts";
import { RelayWireKind, decodeRelayWireFrame } from "./relay-protocol.ts";

let mockSockets: MockWebSocket[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mockSockets = [];
});

describe("shared file relay session refresh", () => {
  it("deduplicates the refresh control message and 4001 close, then reconnects with the new token", async () => {
    vi.useFakeTimers();
    installBrowserMocks();
    let refresh = deferred<string>();
    let refreshSessionToken = vi.fn((_signal: AbortSignal) => refresh.promise);
    let doc = new LoroDoc();
    doc.commit();
    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc,
      refreshSessionToken,
      relayOrigin: "https://relay.example",
      sessionToken: "expired-token",
      shareId: "share-id",
    });
    connection.connect();
    let expiredSocket = mockSockets[0]!;
    expiredSocket.open();
    expiredSocket.receive(JSON.stringify({ type: "sync-ready", versionVector: [] }));

    expiredSocket.receive(
      JSON.stringify({
        reason: "expired",
        recoverable: true,
        type: "session-refresh-required",
      }),
    );
    expiredSocket.serverClose(4001, "Share session expired");
    await flushAsyncWork();
    expect(refreshSessionToken).toHaveBeenCalledTimes(1);

    let text = doc.getText("markdown");
    text.insert(0, "offline edit");
    doc.commit();
    expect(connection.enqueueDocumentUpdate(new Uint8Array([1]))).toBe(true);

    refresh.resolve("fresh-token");
    await flushAsyncWork();

    expect(mockSockets).toHaveLength(2);
    let refreshedSocket = mockSockets[1]!;
    refreshedSocket.open();
    expect(JSON.parse(refreshedSocket.sent[0] as string)).toMatchObject({
      sessionToken: "fresh-token",
      type: "auth",
    });

    refreshedSocket.receive(JSON.stringify({ type: "sync-ready", versionVector: [] }));
    let serverDoc = new LoroDoc();
    for (let message of sentMessages(refreshedSocket)) {
      if (message.kind == RelayWireKind.Doc) serverDoc.import(message.payload);
    }
    expect(serverDoc.getText("markdown").toString()).toBe("offline edit");

    connection.close();
  });

  it("refreshes when the server closes with 4001 without first delivering a control message", async () => {
    installBrowserMocks();
    let refreshSessionToken = vi.fn(async (_signal: AbortSignal) => "fresh-token");
    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      refreshSessionToken,
      relayOrigin: "https://relay.example",
      sessionToken: "expired-token",
      shareId: "share-id",
    });
    connection.connect();
    mockSockets[0]!.open();

    mockSockets[0]!.serverClose(4001, "Share session expired");
    await flushAsyncWork();

    expect(refreshSessionToken).toHaveBeenCalledTimes(1);
    expect(mockSockets).toHaveLength(2);
    connection.close();
  });

  it("does not reconnect when close aborts an in-flight session refresh", async () => {
    installBrowserMocks();
    let refresh = deferred<string>();
    let refreshSignal: { current: AbortSignal | null } = { current: null };
    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      refreshSessionToken: (signal) => {
        refreshSignal.current = signal;
        return refresh.promise;
      },
      relayOrigin: "https://relay.example",
      sessionToken: "expired-token",
      shareId: "share-id",
    });
    connection.connect();
    let socket = mockSockets[0]!;
    socket.open();
    socket.receive(JSON.stringify({ recoverable: true, type: "session-refresh-required" }));
    await flushAsyncWork();

    connection.close();
    expect(refreshSignal.current).not.toBeNull();
    expect(refreshSignal.current!.aborted).toBe(true);
    refresh.resolve("stale-token");
    await flushAsyncWork();

    expect(mockSockets).toHaveLength(1);
  });

  it("uses a distinct client close code for stale heartbeat reconnects", async () => {
    vi.useFakeTimers();
    installBrowserMocks();
    let refreshSessionToken = vi.fn(async (_signal: AbortSignal) => "unused-token");
    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      refreshSessionToken,
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });
    connection.connect();
    let socket = mockSockets[0]!;
    socket.open();

    await vi.advanceTimersByTimeAsync(75_000);

    expect(socket.lastClose).toEqual({ code: 4002, reason: "Stale connection" });
    expect(refreshSessionToken).not.toHaveBeenCalled();
    connection.close();
  });
});

describe("shared file relay reconnect policy", () => {
  it("backs off between failed attempts and restarts the schedule after a socket opens", async () => {
    vi.useFakeTimers();
    installBrowserMocks();
    let states: string[] = [];
    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      onConnectionState: (state) => states.push(state),
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });
    connection.connect();
    mockSockets[0]!.serverClose(1006, "");
    expect(states.at(-1)).toBe("offline");

    // First retry: 250ms plus at most 300ms of jitter.
    await vi.advanceTimersByTimeAsync(249);
    expect(mockSockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(301);
    expect(mockSockets).toHaveLength(2);

    // A second consecutive failure waits at least 500ms.
    mockSockets[1]!.serverClose(1006, "");
    await vi.advanceTimersByTimeAsync(499);
    expect(mockSockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(301);
    expect(mockSockets).toHaveLength(3);

    // Once a socket has opened, the next drop starts again from 250ms.
    mockSockets[2]!.open();
    mockSockets[2]!.serverClose(1006, "");
    await vi.advanceTimersByTimeAsync(550);
    expect(mockSockets).toHaveLength(4);
    connection.close();
  });

  it("stops without reconnecting when the relay rejects the session", async () => {
    vi.useFakeTimers();
    installBrowserMocks();
    let errors: string[] = [];
    let states: string[] = [];
    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      onConnectionState: (state) => states.push(state),
      onError: (message) => errors.push(message),
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });
    connection.connect();
    mockSockets[0]!.open();
    mockSockets[0]!.serverClose(1008, "Share session is no longer valid");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockSockets).toHaveLength(1);
    expect(errors).toEqual(["Shared file access was rejected."]);
    expect(states.at(-1)).toBe("offline");
    connection.close();
  });

  it("cancels a pending reconnect when paused or closed", async () => {
    vi.useFakeTimers();
    installBrowserMocks();
    let connection = new ShareRelayConnection({
      clientId: "client-id",
      doc: new LoroDoc(),
      relayOrigin: "https://relay.example",
      sessionToken: "session-token",
      shareId: "share-id",
    });
    connection.connect();
    mockSockets[0]!.serverClose(1006, "");
    connection.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockSockets).toHaveLength(1);

    connection.connect();
    expect(mockSockets).toHaveLength(2);
    mockSockets[1]!.open();
    connection.pause();
    expect(mockSockets[1]!.lastClose).toEqual({ code: 1000, reason: "Offline" });

    connection.connect();
    connection.close();
    expect(mockSockets[2]!.lastClose).toEqual({ code: 1000, reason: "Page closed" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockSockets).toHaveLength(3);
  });
});

function installBrowserMocks() {
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", MockWebSocket);
}

function sentMessages(socket: MockWebSocket) {
  return socket.sent
    .filter((item): item is Uint8Array => item instanceof Uint8Array)
    .flatMap((frame) => decodeRelayWireFrame(frame));
}

class MockWebSocket extends EventTarget {
  static readonly CLOSED = 3;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;

  binaryType: BinaryType = "arraybuffer";
  lastClose: { code: number; reason: string } | null = null;
  readyState = MockWebSocket.CONNECTING;
  readonly sent: Array<string | Uint8Array> = [];

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

  serverClose(code: number, reason: string) {
    this.finishClose(code, reason);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data == "string") {
      this.sent.push(data);
    } else if (ArrayBuffer.isView(data)) {
      this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
    }
  }

  close(code = 1000, reason = "") {
    this.finishClose(code, reason);
  }

  private finishClose(code: number, reason: string) {
    if (this.readyState == MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.lastClose = { code, reason };
    let event = new Event("close") as CloseEvent;
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    });
    this.dispatchEvent(event);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
