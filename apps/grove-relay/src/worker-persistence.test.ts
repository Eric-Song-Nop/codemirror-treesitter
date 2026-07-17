import { LoroDoc, VersionVector } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WireKind, encodeWireBatch, encodeWireMessage } from "./protocol.ts";
import { maxSnapshotBytes } from "./share-limits.ts";
import type { ShareRecord } from "./share.ts";

const validShareId = "AAAAAAAAAAAAAAAAAAAAAA";
const validHash = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared file Durable Object persistence", () => {
  it("persists the canonical merge when a client sends a stale snapshot", async () => {
    let original = documentWithText("A", 1);
    let originalSnapshot = original.export({ mode: "snapshot" });

    let serverDoc = new LoroDoc();
    serverDoc.import(originalSnapshot);
    serverDoc.setPeerId(2);
    serverDoc.getText("markdown").insert(1, "B");
    serverDoc.commit();
    let serverUpdate = serverDoc.export({ from: original.oplogVersion(), mode: "update" });

    let clientDoc = new LoroDoc();
    clientDoc.import(originalSnapshot);
    clientDoc.setPeerId(3);
    clientDoc.getText("markdown").insert(1, "C");
    clientDoc.commit();

    let storage = persistedShareStorage(originalSnapshot, serverUpdate);
    let { room, sender } = await createTestRoom(serverDoc, storage);

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(encodeWireMessage(WireKind.Snapshot, clientDoc.export({ mode: "snapshot" }))),
    );

    let restarted = new LoroDoc();
    restarted.import(storage.records.get("snapshot") as Uint8Array);
    for (let [key, value] of storage.records) {
      if (key.startsWith("update:")) restarted.import(value as Uint8Array);
    }

    expect(room.doc.getText("markdown").toString()).toBe("ABC");
    expect(restarted.getText("markdown").toString()).toBe("ABC");
    expect([...storage.records.keys()].filter((key) => key.startsWith("update:"))).toEqual([]);
    expect(storage.records.get("pendingHostSave")).toBe(true);
    expect(room.pendingHostSave).toBe(true);
    expect(storage.transactionCalls).toBe(1);
  });

  it("preflights the whole update burst before importing any document payload", async () => {
    let serverDoc = documentWithText("A", 1);
    let initialSnapshot = serverDoc.export({ mode: "snapshot" });
    let clientDoc = new LoroDoc();
    clientDoc.import(initialSnapshot);
    clientDoc.setPeerId(2);
    let initialVersion = clientDoc.oplogVersion();
    clientDoc.getText("markdown").insert(1, "B");
    clientDoc.commit();
    let firstUpdate = clientDoc.export({ from: initialVersion, mode: "update" });
    let firstVersion = clientDoc.oplogVersion();
    clientDoc.getText("markdown").insert(2, "C");
    clientDoc.commit();
    let secondUpdate = clientDoc.export({ from: firstVersion, mode: "update" });

    let storage = persistedShareStorage(initialSnapshot);
    let { room, sender } = await createTestRoom(serverDoc, storage, { updateTokens: 1 });
    let beforeVersion = serverDoc.oplogVersion();

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(
        encodeWireBatch([
          { kind: WireKind.Doc, payload: firstUpdate },
          { kind: WireKind.Doc, payload: secondUpdate },
        ]),
      ),
    );

    expect(room.doc.oplogVersion().compare(beforeVersion)).toBe(0);
    expect(room.doc.getText("markdown").toString()).toBe("A");
    expect(sender.attachment.updateTokens).toBe(1);
    expect(sender.closed).toEqual({ code: 1008, reason: "Document update rate limit exceeded" });
    expect(storage.transactionCalls).toBe(0);
  });

  it("rate-limits presence messages per socket before relaying them", async () => {
    let doc = documentWithText("A", 1);
    let storage = persistedShareStorage(doc.export({ mode: "snapshot" }));
    let { peer, room, sender } = await createTestRoom(doc, storage, {
      binaryByteTokens: 1024,
      binaryMessageTokens: 1,
      binaryTokensAt: Date.now(),
    });
    let presence = asArrayBuffer(encodeWireMessage(WireKind.Presence, new Uint8Array()));

    await room.webSocketMessage(sender.asWebSocket(), presence);
    await room.webSocketMessage(sender.asWebSocket(), presence);

    expect(peer.sent).toHaveLength(1);
    expect(sender.closed).toEqual({
      code: 1008,
      reason: "Collaboration traffic rate limit exceeded",
    });
  });

  it("rate-limits aggregate binary bytes per socket", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let doc = documentWithText("A", 1);
    let storage = persistedShareStorage(doc.export({ mode: "snapshot" }));
    let { peer, room, sender } = await createTestRoom(doc, storage, {
      binaryByteTokens: 1,
      binaryMessageTokens: 60,
      binaryTokensAt: now,
    });

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(encodeWireMessage(WireKind.Presence, new Uint8Array([1]))),
    );

    expect(peer.sent).toEqual([]);
    expect(sender.closed).toEqual({
      code: 1008,
      reason: "Collaboration traffic rate limit exceeded",
    });
  });

  it("charges an empty binary batch as one frame", async () => {
    let doc = documentWithText("A", 1);
    let storage = persistedShareStorage(doc.export({ mode: "snapshot" }));
    let { room, sender } = await createTestRoom(doc, storage, {
      binaryByteTokens: 1024,
      binaryMessageTokens: 0,
      binaryTokensAt: Date.now(),
    });

    await room.webSocketMessage(sender.asWebSocket(), asArrayBuffer(encodeWireBatch([])));

    expect(sender.closed).toEqual({
      code: 1008,
      reason: "Collaboration traffic rate limit exceeded",
    });
  });

  it("commits a document update, pending-save flag, and relay only after one transaction", async () => {
    let serverDoc = documentWithText("A", 1);
    let initialSnapshot = serverDoc.export({ mode: "snapshot" });
    let clientDoc = new LoroDoc();
    clientDoc.import(initialSnapshot);
    clientDoc.setPeerId(2);
    let initialVersion = clientDoc.oplogVersion();
    clientDoc.getText("markdown").insert(1, "B");
    clientDoc.commit();
    let update = clientDoc.export({ from: initialVersion, mode: "update" });

    let storage = persistedShareStorage(initialSnapshot);
    let { peer, room, sender } = await createTestRoom(serverDoc, storage);

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(encodeWireMessage(WireKind.Doc, update)),
    );

    let restarted = new LoroDoc();
    restarted.import(storage.records.get("snapshot") as Uint8Array);
    for (let [key, value] of storage.records) {
      if (key.startsWith("update:")) restarted.import(value as Uint8Array);
    }

    expect(room.doc.getText("markdown").toString()).toBe("AB");
    expect(restarted.getText("markdown").toString()).toBe("AB");
    expect(storage.records.get("pendingHostSave")).toBe(true);
    expect(room.pendingHostSave).toBe(true);
    expect(peer.sent.length).toBeGreaterThan(0);
    expect(storage.transactionCalls).toBe(1);
  });

  it("rejects an oversized candidate without poisoning the live document", async () => {
    let baseText = deterministicText(510_000);
    let serverDoc = documentWithText(baseText, 1);
    let initialSnapshot = serverDoc.export({ mode: "snapshot" });
    expect(initialSnapshot.byteLength).toBeLessThan(maxSnapshotBytes);

    let clientDoc = new LoroDoc();
    clientDoc.import(initialSnapshot);
    clientDoc.setPeerId(2);
    let initialVersion = clientDoc.oplogVersion();
    clientDoc.getText("markdown").insert(baseText.length, deterministicText(20_000, 987_654_321));
    clientDoc.commit();
    let update = clientDoc.export({ from: initialVersion, mode: "update" });
    expect(update.byteLength).toBeLessThan(256 * 1024);
    expect(clientDoc.export({ mode: "snapshot" }).byteLength).toBeGreaterThan(maxSnapshotBytes);

    let storage = persistedShareStorage(initialSnapshot);
    let { room, sender } = await createTestRoom(serverDoc, storage);
    let beforeVersion = serverDoc.oplogVersion();

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(encodeWireMessage(WireKind.Doc, update)),
    );

    expect(room.doc.oplogVersion().compare(beforeVersion)).toBe(0);
    expect(room.doc.getText("markdown").toString()).toBe(baseText);
    expect(storage.records.get("snapshot")).toEqual(initialSnapshot);
    expect(storage.transactionCalls).toBe(0);
    expect(sender.closed).toEqual({ code: 1009, reason: "Document snapshot is too large" });
  }, 20_000);

  it("keeps live and durable state unchanged when the document transaction fails", async () => {
    let serverDoc = documentWithText("A", 1);
    let initialSnapshot = serverDoc.export({ mode: "snapshot" });
    let clientDoc = new LoroDoc();
    clientDoc.import(initialSnapshot);
    clientDoc.setPeerId(2);
    let initialVersion = clientDoc.oplogVersion();
    clientDoc.getText("markdown").insert(1, "B");
    clientDoc.commit();
    let update = clientDoc.export({ from: initialVersion, mode: "update" });

    let storage = persistedShareStorage(initialSnapshot);
    storage.failTransactionAfterWrites = 2;
    let { peer, room, sender } = await createTestRoom(serverDoc, storage);
    let beforeVersion = serverDoc.oplogVersion();

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(encodeWireMessage(WireKind.Doc, update)),
    );

    expect(room.doc.oplogVersion().compare(beforeVersion)).toBe(0);
    expect(room.doc.getText("markdown").toString()).toBe("A");
    expect(storage.records.get("snapshot")).toEqual(initialSnapshot);
    expect(storage.records.get("pendingHostSave")).toBe(false);
    expect(peer.sent).toEqual([]);
    expect(sender.closed).toEqual({ code: 1011, reason: "Failed to persist shared file update" });
    expect(storage.transactionCalls).toBe(1);
  });

  it("clears pending host save only when the ACK covers the canonical V2", async () => {
    let doc = documentWithText("A", 1);
    doc.getText("markdown").insert(1, "B");
    doc.commit();
    let storage = persistedShareStorage(doc.export({ mode: "snapshot" }));
    let { room, sender } = await createTestRoom(doc, storage, { role: "host" });
    setPendingHostSave(room, storage, true);

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(
        encodeWireMessage(WireKind.HostSaveAck, hostSaveAckPayload(doc.oplogVersion())),
      ),
    );

    expect(room.pendingHostSave).toBe(false);
    expect(storage.records.get("pendingHostSave")).toBe(false);
    expect(storage.transactionCalls).toBe(1);
  });

  it("keeps pending host save for a stale V1 ACK while relaying that valid ACK", async () => {
    let doc = documentWithText("A", 1);
    let versionV1 = doc.oplogVersion();
    doc.getText("markdown").insert(1, "B");
    doc.commit();
    let storage = persistedShareStorage(doc.export({ mode: "snapshot" }));
    let { peer, room, sender } = await createTestRoom(doc, storage, { role: "host" });
    setPendingHostSave(room, storage, true);
    let ackPayload = hostSaveAckPayload(versionV1);

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(encodeWireMessage(WireKind.HostSaveAck, ackPayload)),
    );

    expect(room.pendingHostSave).toBe(true);
    expect(storage.records.get("pendingHostSave")).toBe(true);
    expect(storage.transactionCalls).toBe(0);
    expect(peer.sent[0]).toEqual(encodeWireMessage(WireKind.HostSaveAck, ackPayload));
  });

  it("keeps pending host save when a batch adds V2 but only ACKs V1", async () => {
    let serverDoc = documentWithText("A", 1);
    let snapshotV1 = serverDoc.export({ mode: "snapshot" });
    let versionV1 = serverDoc.oplogVersion();
    let clientDoc = new LoroDoc();
    clientDoc.import(snapshotV1);
    clientDoc.setPeerId(2);
    clientDoc.getText("markdown").insert(1, "B");
    clientDoc.commit();
    let updateV2 = clientDoc.export({ from: versionV1, mode: "update" });
    let storage = persistedShareStorage(snapshotV1);
    let { room, sender } = await createTestRoom(serverDoc, storage, { role: "host" });

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(
        encodeWireBatch([
          { kind: WireKind.Doc, payload: updateV2 },
          { kind: WireKind.HostSaveAck, payload: hostSaveAckPayload(versionV1) },
        ]),
      ),
    );

    expect(room.doc.getText("markdown").toString()).toBe("AB");
    expect(room.pendingHostSave).toBe(true);
    expect(storage.records.get("pendingHostSave")).toBe(true);
    expect(storage.transactionCalls).toBe(1);
  });

  it("accepts host save acknowledgements from documents with 129 actors", async () => {
    let doc = documentWithText("A", 1);
    let storage = persistedShareStorage(doc.export({ mode: "snapshot" }));
    let { peer, room, sender } = await createTestRoom(doc, storage, { role: "host" });
    setPendingHostSave(room, storage, true);
    let canonicalVersion = doc.oplogVersion();
    let entries = [...canonicalVersion.toJSON()].map(([peer, counter]) => [String(peer), counter]);
    canonicalVersion.free();
    for (let peer = 2; entries.length < 129; peer++) entries.push([String(peer), 0]);
    let payload = hostSaveAckEntriesPayload(entries);

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(encodeWireMessage(WireKind.HostSaveAck, payload)),
    );

    expect(sender.closed).toBeNull();
    expect(room.pendingHostSave).toBe(false);
    expect(storage.records.get("pendingHostSave")).toBe(false);
    expect(peer.sent[0]).toEqual(encodeWireMessage(WireKind.HostSaveAck, payload));
  });

  it("rejects host save acknowledgements from guest sockets", async () => {
    let doc = documentWithText("A", 1);
    let storage = persistedShareStorage(doc.export({ mode: "snapshot" }));
    let { peer, room, sender } = await createTestRoom(doc, storage, { role: "guest" });

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(
        encodeWireMessage(WireKind.HostSaveAck, hostSaveAckPayload(doc.oplogVersion())),
      ),
    );

    expect(peer.sent).toEqual([]);
    expect(sender.closed).toEqual({ code: 1008, reason: "Host authorization required" });
  });

  it("frees temporary version vectors created while importing document updates", async () => {
    let serverDoc = documentWithText("A", 1);
    let initialSnapshot = serverDoc.export({ mode: "snapshot" });
    let clientDoc = new LoroDoc();
    clientDoc.import(initialSnapshot);
    clientDoc.setPeerId(2);
    let initialVersion = clientDoc.oplogVersion();
    clientDoc.getText("markdown").insert(1, "B");
    clientDoc.commit();
    let update = clientDoc.export({ from: initialVersion, mode: "update" });
    initialVersion.free();
    clientDoc.free();
    let storage = persistedShareStorage(initialSnapshot);
    let { room, sender } = await createTestRoom(serverDoc, storage);
    let free = vi.spyOn(VersionVector.prototype, "free");
    free.mockClear();

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(encodeWireMessage(WireKind.Doc, update)),
    );

    expect(free).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["malformed JSON", new TextEncoder().encode("{")],
    ["wrong share id", hostSaveAckEntriesPayload([], "CCCCCCCCCCCCCCCCCCCCCC")],
  ])("rejects a %s ACK without clearing or relaying it", async (_name, payload) => {
    let doc = documentWithText("A", 1);
    let storage = persistedShareStorage(doc.export({ mode: "snapshot" }));
    let { peer, room, sender } = await createTestRoom(doc, storage, { role: "host" });
    setPendingHostSave(room, storage, true);

    await room.webSocketMessage(
      sender.asWebSocket(),
      asArrayBuffer(encodeWireMessage(WireKind.HostSaveAck, payload)),
    );

    expect(room.pendingHostSave).toBe(true);
    expect(storage.records.get("pendingHostSave")).toBe(true);
    expect(storage.transactionCalls).toBe(0);
    expect(peer.sent).toEqual([]);
    expect(sender.closed).toEqual({ code: 1008, reason: "Invalid host save acknowledgement" });
  });
});

type TestRoom = {
  ctx: TestDurableObjectState;
  dirty: boolean;
  doc: LoroDoc;
  firstDirtyAt: number;
  initialized: boolean;
  lastShareStatusBroadcastAt: number;
  maxSaveTimer: ReturnType<typeof setTimeout> | null;
  pendingHostSave: boolean;
  retryDelayMs: number;
  saveTimer: ReturnType<typeof setTimeout> | null;
  saving: boolean;
  shareRecord: ShareRecord | null;
  shareStatusTimer: ReturnType<typeof setTimeout> | null;
  sockets: Set<WebSocket>;
  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void>;
};

type ConnectionAttachment = {
  binaryByteTokens?: number;
  binaryMessageTokens?: number;
  binaryTokensAt?: number;
  clientId: string;
  joinedAt: number;
  role: "guest" | "host";
  secretHash: string;
  updateTokens: number;
  updateTokensAt: number;
};

type TestDurableObjectState = {
  getWebSockets(tag?: string): WebSocket[];
  storage: MemoryDurableObjectStorage;
};

async function createTestRoom(
  doc: LoroDoc,
  storage: MemoryDurableObjectStorage,
  attachmentOverrides: Partial<ConnectionAttachment> = {},
) {
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  let { GroveShareRoom } = await import("./worker.ts");
  let room = Object.create(GroveShareRoom.prototype) as TestRoom;
  let attachment: ConnectionAttachment = {
    clientId: "sender-client",
    joinedAt: Date.now(),
    role: "guest",
    secretHash: validHash,
    updateTokens: 60,
    updateTokensAt: Date.now(),
    ...attachmentOverrides,
  };
  let sender = new TestWebSocket(attachment);
  let peer = new TestWebSocket({ ...attachment, clientId: "peer-client" });
  let sockets = new Set<WebSocket>([sender.asWebSocket(), peer.asWebSocket()]);

  room.ctx = {
    getWebSockets: () => [...sockets],
    storage,
  };
  room.dirty = false;
  room.doc = doc;
  room.firstDirtyAt = 0;
  room.initialized = true;
  room.lastShareStatusBroadcastAt = 0;
  room.maxSaveTimer = null;
  room.pendingHostSave = false;
  room.retryDelayMs = 1000;
  room.saveTimer = null;
  room.saving = false;
  room.shareRecord = shareRecord();
  room.shareStatusTimer = null;
  room.sockets = sockets;

  return { peer, room, sender };
}

class TestWebSocket {
  closed: { code: number; reason: string } | null = null;
  readyState = 1;
  sent: Array<string | Uint8Array> = [];

  constructor(public attachment: ConnectionAttachment) {}

  asWebSocket() {
    return this as unknown as WebSocket;
  }

  close(code = 1000, reason = "") {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  deserializeAttachment() {
    return this.attachment;
  }

  send(value: string | ArrayBuffer | ArrayBufferView) {
    this.sent.push(
      typeof value == "string"
        ? value
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }

  serializeAttachment(value: ConnectionAttachment) {
    this.attachment = value;
  }
}

class MemoryDurableObjectStorage {
  failTransactionAfterWrites: number | null = null;
  records = new Map<string, unknown>();
  transactionCalls = 0;

  async delete(keys: string | string[]) {
    return deleteRecords(this.records, keys);
  }

  async get<T>(key: string) {
    return this.records.get(key) as T | undefined;
  }

  async list<T>(options: { prefix?: string } = {}) {
    return listRecords<T>(this.records, options);
  }

  async put<T>(key: string, value: T) {
    this.records.set(key, cloneStoredValue(value));
  }

  async transaction<T>(callback: (txn: MemoryDurableObjectTransaction) => Promise<T>) {
    this.transactionCalls++;
    let records = cloneRecords(this.records);
    let result = await callback(
      new MemoryDurableObjectTransaction(records, this.failTransactionAfterWrites),
    );
    this.records = records;
    return result;
  }
}

class MemoryDurableObjectTransaction {
  private writes = 0;

  constructor(
    private readonly records: Map<string, unknown>,
    private readonly failAfterWrites: number | null,
  ) {}

  async delete(keys: string | string[]) {
    let result = deleteRecords(this.records, keys);
    this.failIfRequested();
    return result;
  }

  async get<T>(key: string) {
    return this.records.get(key) as T | undefined;
  }

  async list<T>(options: { prefix?: string } = {}) {
    return listRecords<T>(this.records, options);
  }

  async put<T>(key: string, value: T) {
    this.records.set(key, cloneStoredValue(value));
    this.failIfRequested();
  }

  private failIfRequested() {
    this.writes++;
    if (this.failAfterWrites != null && this.writes >= this.failAfterWrites) {
      throw new Error("injected transaction failure");
    }
  }
}

function persistedShareStorage(snapshot: Uint8Array, update?: Uint8Array) {
  let storage = new MemoryDurableObjectStorage();
  storage.records.set("share", shareRecord());
  storage.records.set("snapshot", new Uint8Array(snapshot));
  storage.records.set("pendingHostSave", false);
  if (update) {
    storage.records.set("update:000000000001", new Uint8Array(update));
    storage.records.set("updateLogBytes", update.byteLength);
    storage.records.set("updateLogSequence", 1);
  }
  return storage;
}

function documentWithText(value: string, peerId: number) {
  let doc = new LoroDoc();
  doc.setPeerId(peerId);
  doc.getText("markdown").insert(0, value);
  doc.commit();
  return doc;
}

function deterministicText(length: number, initialState = 123_456_789) {
  let state = initialState;
  let chunks: string[] = [];
  let chunk = "";
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    chunk += String.fromCharCode(32 + (state % 95));
    if (chunk.length == 8192) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.join("");
}

function asArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function hostSaveAckPayload(version: VersionVector, shareId = validShareId) {
  let payload = hostSaveAckEntriesPayload(
    [...version.toJSON()].map(([peer, counter]) => [String(peer), counter]),
    shareId,
  );
  version.free();
  return payload;
}

function hostSaveAckEntriesPayload(entries: (string | number)[][], shareId = validShareId) {
  return new TextEncoder().encode(
    JSON.stringify({ savedAt: 123, shareId, versionVector: entries }),
  );
}

function setPendingHostSave(
  room: TestRoom,
  storage: MemoryDurableObjectStorage,
  pendingHostSave: boolean,
) {
  room.pendingHostSave = pendingHostSave;
  storage.records.set("pendingHostSave", pendingHostSave);
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

function deleteRecords(records: Map<string, unknown>, keys: string | string[]) {
  let deleted = 0;
  for (let key of Array.isArray(keys) ? keys : [keys]) {
    if (records.delete(key)) deleted++;
  }
  return deleted;
}

function listRecords<T>(records: Map<string, unknown>, options: { prefix?: string }) {
  let result = new Map<string, T>();
  for (let [key, value] of records) {
    if (options.prefix && !key.startsWith(options.prefix)) continue;
    result.set(key, value as T);
  }
  return result;
}

function cloneRecords(records: Map<string, unknown>) {
  return new Map([...records].map(([key, value]) => [key, cloneStoredValue(value)]));
}

function cloneStoredValue<T>(value: T): T {
  return (value instanceof Uint8Array ? new Uint8Array(value) : structuredClone(value)) as T;
}
