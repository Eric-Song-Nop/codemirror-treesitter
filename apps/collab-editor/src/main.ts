import "./style.css";
import {
  defineLiveMdEditor,
  prepareLiveMd,
  type LiveMdEditorElement,
} from "@codemirror-treesitter/live-md";
import { liveMdLoroCollaboration } from "@codemirror-treesitter/live-md-loro";
import { LoroDoc, UndoManager } from "loro-crdt";
import { createInitialDocument } from "./initial-document.ts";
import {
  ShareRoomConnection,
  createRelayShare,
  type ConnectionState,
  type ShareAccess,
} from "./share-client.ts";
import { createShareCredentials, parseShareHash, shareHash, shareUrl } from "./share-link.ts";

const markdownTextKey = "markdown";
const roomLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const origin = collaborationWorkerOrigin();
const clientId = getOrCreateClientId();
const doc = new LoroDoc();
const undoManager = new UndoManager(doc, {});

let localSaveTimer: number | null = null;
let localSnapshotKey: string | null = null;

let statusLine = document.createElement("p");
statusLine.className = "collab-status";
statusLine.setAttribute("role", "status");

await prepareLiveMd();
defineLiveMdEditor();

let access: ShareAccess;
try {
  access = await ensureShare();
} catch (error: unknown) {
  renderShell(null);
  setStatus("unavailable", error instanceof Error ? error.message : String(error));
  throw error;
}

renderShell(access);
let connection = new ShareRoomConnection({
  access,
  clientId,
  doc,
  onState: setStatus,
  origin,
});

doc.subscribeLocalUpdates(() => connection.markLocalChange());
doc.subscribe(() => scheduleLocalSnapshotSave());

void connection.connect();
window.addEventListener("online", () => void connection.connect());
window.addEventListener("offline", () => connection.pause());
window.addEventListener("beforeunload", () => {
  saveLocalSnapshot();
  connection.close();
});

async function ensureShare(): Promise<ShareAccess> {
  let link = parseShareHash(location.hash);
  if (link) {
    localSnapshotKey = snapshotStorageKey(link.shareId);
    let restored = loadLocalSnapshot(localSnapshotKey);
    if (restored) doc.import(restored);
    let hostSecret = loadHostSecret(link.shareId);
    return hostSecret
      ? { role: "host", secret: hostSecret, shareId: link.shareId }
      : { role: "guest", secret: link.guestSecret, shareId: link.shareId };
  }

  // No valid share link: create a new rate-limited, quota-admitted share room.
  let credentials = createShareCredentials();
  let newLink = { guestSecret: credentials.guestSecret, shareId: credentials.shareId };
  doc.getText(markdownTextKey).insert(0, createInitialDocument(shareUrl(location.href, newLink)));
  doc.commit();
  await createRelayShare(origin, credentials, doc.export({ mode: "snapshot" }), {
    displayName: "Collaborative LiveMD",
    expiresAt: Date.now() + roomLifetimeMs,
  });
  saveHostSecret(credentials.shareId, credentials.hostSecret);
  history.replaceState(null, "", `/${shareHash(newLink)}`);
  localSnapshotKey = snapshotStorageKey(credentials.shareId);
  return { role: "host", secret: credentials.hostSecret, shareId: credentials.shareId };
}

function renderShell(share: ShareAccess | null) {
  let shell = document.createElement("main");
  shell.className = "collab-shell";
  shell.appendChild(statusLine);

  if (share) {
    let editor = document.createElement("live-md-editor") as LiveMdEditorElement;
    editor.setAttribute("autofocus", "");
    editor.placeholder = "Start writing Markdown. Share this link to collaborate.";
    editor.extensions = [liveMdLoroCollaboration({ doc, undoManager })];

    let editorFrame = document.createElement("section");
    editorFrame.className = "editor-frame";
    editorFrame.setAttribute("aria-label", "Collaborative Markdown editor");
    editorFrame.appendChild(editor);
    shell.appendChild(editorFrame);
  }

  document.querySelector<HTMLDivElement>("#app")!.replaceChildren(shell);
}

function setStatus(state: ConnectionState, detail?: string) {
  let labels: Record<ConnectionState, string> = {
    connected: "Connected",
    connecting: "Connecting…",
    offline: "Offline, retrying…",
    unavailable: "This room is unavailable.",
  };
  statusLine.dataset.state = state;
  statusLine.textContent =
    detail && state != "connected" ? `${labels[state]} ${detail}` : labels[state];
  if (state == "unavailable") {
    let fresh = document.createElement("a");
    fresh.href = "/";
    fresh.textContent = "Start a new room";
    statusLine.appendChild(document.createTextNode(" "));
    statusLine.appendChild(fresh);
  }
}

function collaborationWorkerOrigin(): string {
  let configuredOrigin = import.meta.env.VITE_COLLAB_WORKER_ORIGIN?.trim();
  if (!configuredOrigin) return location.origin;

  let normalizedOrigin = /^[a-z]+:\/\//i.test(configuredOrigin)
    ? configuredOrigin
    : `https://${configuredOrigin}`;

  try {
    return new URL(normalizedOrigin).origin;
  } catch {
    return location.origin;
  }
}

function snapshotStorageKey(shareId: string) {
  return `collab:${shareId}:snapshot`;
}

function hostSecretStorageKey(shareId: string) {
  return `collab:${shareId}:host`;
}

function loadHostSecret(shareId: string) {
  try {
    return localStorage.getItem(hostSecretStorageKey(shareId));
  } catch {
    return null;
  }
}

function saveHostSecret(shareId: string, secret: string) {
  try {
    localStorage.setItem(hostSecretStorageKey(shareId), secret);
  } catch {
    // Without storage this browser rejoins as a guest, which can still edit.
  }
}

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
  if (!localSnapshotKey) return;
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
