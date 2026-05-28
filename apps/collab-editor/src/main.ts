import "./style.css";
import { defineLiveMdEditor, type LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import { liveMdLoroCollaboration } from "@codemirror-treesitter/live-md-loro";
import { LoroDoc, UndoManager } from "loro-crdt";
import { WireKind, decodeWireFrame, encodeWireBatch, type WireMessage } from "./protocol.ts";

const roomId = ensureRoomId();
const localSnapshotKey = `collab:${roomId}:snapshot`;
const clientId = getOrCreateClientId();
const doc = new LoroDoc();
const undoManager = new UndoManager(doc, {});
const restoredSnapshot = loadLocalSnapshot(localSnapshotKey);

if (restoredSnapshot) doc.import(restoredSnapshot);

let localSaveTimer: number | null = null;

class CollaborationConnection {
  private activeGeneration = 0;
  private clientId: string;
  private doc: LoroDoc;
  private flushTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lastMessageAt = 0;
  private localSnapshotSent = false;
  private queue: WireMessage[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private receivedServerSnapshot = false;
  private restoredSnapshot: Uint8Array | null;
  private roomId: string;
  private socket: WebSocket | null = null;

  constructor(roomId: string, clientId: string, doc: LoroDoc, restoredSnapshot: Uint8Array | null) {
    this.clientId = clientId;
    this.doc = doc;
    this.restoredSnapshot = restoredSnapshot;
    this.roomId = roomId;
  }

  close() {
    this.activeGeneration++;
    this.clearReconnectTimer();
    this.clearFlushTimer();
    this.stopHeartbeat();
    this.socket?.close(1000, "Page closed");
    this.socket = null;
  }

  connect() {
    if (navigator.onLine === false) {
      this.scheduleReconnect();
      return;
    }

    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.socket?.close(1000, "Reconnecting");

    let generation = ++this.activeGeneration;
    let socket = new WebSocket(this.websocketUrl());
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.receivedServerSnapshot = false;
    this.lastMessageAt = Date.now();

    socket.addEventListener("open", () => {
      if (!this.isActive(generation, socket)) return;
      this.reconnectAttempt = 0;
      this.startHeartbeat(generation, socket);
    });

    socket.addEventListener("message", (event: MessageEvent<ArrayBuffer | string>) => {
      if (!this.isActive(generation, socket)) return;
      this.lastMessageAt = Date.now();
      this.handleMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (!this.isActive(generation, socket)) return;
      this.socket = null;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (!this.isActive(generation, socket)) return;
      socket.close();
    });
  }

  enqueue(kind: WireKind, payload: Uint8Array) {
    this.queue.push({ kind, payload: new Uint8Array(payload) });
    this.scheduleFlush();
  }

  pause() {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.socket?.close(1000, "Offline");
    this.socket = null;
  }

  private clearFlushTimer() {
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private flushQueue() {
    this.flushTimer = null;
    if (!this.queue.length || !this.readyToSend()) return;

    let messages = this.queue.splice(0);
    let frame = encodeWireBatch(messages);

    try {
      this.socket!.send(frame);
    } catch {
      this.queue.unshift(...messages);
      this.socket?.close();
    }
  }

  private handleMessage(data: ArrayBuffer | string) {
    if (typeof data == "string") {
      this.handleControlMessage(data);
      return;
    }

    let messages = decodeWireFrame(data);
    for (let message of messages) {
      if (message.kind == WireKind.Doc || message.kind == WireKind.Snapshot) {
        this.doc.import(message.payload);
      }

      if (message.kind == WireKind.Snapshot && !this.receivedServerSnapshot) {
        this.receivedServerSnapshot = true;
        if (this.restoredSnapshot && !this.localSnapshotSent) {
          this.localSnapshotSent = true;
          this.queue.unshift({
            kind: WireKind.Snapshot,
            payload: this.doc.export({ mode: "snapshot" }),
          });
        }
        this.scheduleFlush();
      }
    }
  }

  private handleControlMessage(data: string) {
    try {
      JSON.parse(data);
    } catch {
      this.socket?.close(1003, "Malformed control message");
    }
  }

  private isActive(generation: number, socket: WebSocket) {
    return this.activeGeneration == generation && this.socket == socket;
  }

  private readyToSend() {
    return this.socket?.readyState == WebSocket.OPEN && this.receivedServerSnapshot;
  }

  private reconnectDelay() {
    let base = Math.min(250 * 2 ** this.reconnectAttempt, 10_000);
    this.reconnectAttempt++;
    return base + (crypto.getRandomValues(new Uint16Array(1))[0]! % 301);
  }

  private scheduleFlush() {
    if (!this.readyToSend() || this.flushTimer != null) return;
    this.flushTimer = window.setTimeout(() => this.flushQueue(), 50);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null || navigator.onLine === false) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay());
  }

  private startHeartbeat(generation: number, socket: WebSocket) {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.isActive(generation, socket)) return;
      if (Date.now() - this.lastMessageAt > 60_000) {
        socket.close(1001, "Stale connection");
        return;
      }
      if (socket.readyState == WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }, 25_000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer != null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private websocketUrl() {
    let protocol = location.protocol == "https:" ? "wss:" : "ws:";
    let path = `/api/doc/${encodeURIComponent(this.roomId)}/ws`;
    let params = new URLSearchParams({ clientId: this.clientId });
    return `${protocol}//${location.host}${path}?${params}`;
  }
}

defineLiveMdEditor();

let editor = document.createElement("live-md-editor") as LiveMdEditorElement;
editor.setAttribute("autofocus", "");
editor.extensions = [liveMdLoroCollaboration({ doc, undoManager })];
document.querySelector<HTMLDivElement>("#app")!.replaceChildren(editor);

let connection = new CollaborationConnection(roomId, clientId, doc, restoredSnapshot);

doc.subscribeLocalUpdates((bytes) => {
  connection.enqueue(WireKind.Doc, bytes);
});

doc.subscribe(() => {
  scheduleLocalSnapshotSave();
});

connection.connect();
window.addEventListener("online", () => connection.connect());
window.addEventListener("offline", () => connection.pause());
window.addEventListener("beforeunload", () => {
  saveLocalSnapshot();
  connection.close();
});

function decodeBase64(value: string): Uint8Array {
  let binary = atob(value);
  let bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

function ensureRoomId() {
  let hash = decodeURIComponent(location.hash.slice(1));
  if (/^[A-Za-z0-9_-]{8,96}$/.test(hash)) return hash;

  let nextRoomId = crypto.randomUUID();
  history.replaceState(null, "", `${location.pathname}${location.search}#${nextRoomId}`);
  return nextRoomId;
}

function getOrCreateClientId() {
  try {
    let existing = sessionStorage.getItem("collab:clientId");
    if (existing) return existing;
    let next = crypto.randomUUID();
    sessionStorage.setItem("collab:clientId", next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}

function loadLocalSnapshot(key: string): Uint8Array | null {
  try {
    let value = localStorage.getItem(key);
    return value ? decodeBase64(value) : null;
  } catch {
    return null;
  }
}

function saveLocalSnapshot() {
  try {
    localStorage.setItem(localSnapshotKey, encodeBase64(doc.export({ mode: "snapshot" })));
  } catch {
    // Local snapshots are opportunistic; the Durable Object snapshot is authoritative.
  }
}

function scheduleLocalSnapshotSave() {
  if (localSaveTimer != null) clearTimeout(localSaveTimer);
  localSaveTimer = window.setTimeout(() => {
    localSaveTimer = null;
    saveLocalSnapshot();
  }, 750);
}
