import type { LoroDoc } from "loro-crdt";
import type { WorkspaceBackend } from "@/lib/workspace-backend";

type BroadcastSyncMessage =
  | {
      bytes: Uint8Array;
      docId: string;
      kind: "doc-update";
      senderId: string;
    }
  | {
      bytes: Uint8Array;
      kind: "workspace-update";
      senderId: string;
    };

export type CollabDocumentBroadcastSyncOptions = {
  backend: WorkspaceBackend;
  doc: LoroDoc;
  docId: string;
  onRemoteUpdate?: () => void;
  senderId?: string;
};

export type WorkspaceManifestBroadcastSync = {
  broadcast: (bytes: Uint8Array) => void;
  dispose: () => void;
};

export type WorkspaceManifestBroadcastSyncOptions = {
  backend: WorkspaceBackend;
  onRemoteUpdate?: (bytes: Uint8Array) => void;
  senderId?: string;
};

export function createCollabDocumentBroadcastSync({
  backend,
  doc,
  docId,
  onRemoteUpdate,
  senderId = getBroadcastSenderId(),
}: CollabDocumentBroadcastSyncOptions) {
  if (typeof BroadcastChannel == "undefined") return () => {};

  let channel = new BroadcastChannel(collabDocumentBroadcastChannelName(backend, docId));
  let unsubscribe = doc.subscribeLocalUpdates((bytes) => {
    channel.postMessage({
      bytes: new Uint8Array(bytes),
      docId,
      kind: "doc-update",
      senderId,
    } satisfies BroadcastSyncMessage);
  });

  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    let message = parseBroadcastSyncMessage(event.data);
    if (
      !message ||
      message.kind != "doc-update" ||
      message.docId != docId ||
      message.senderId == senderId
    ) {
      return;
    }

    doc.import(message.bytes);
    onRemoteUpdate?.();
  });

  return () => {
    unsubscribe();
    channel.close();
  };
}

export function createWorkspaceManifestBroadcastSync({
  backend,
  onRemoteUpdate,
  senderId = getBroadcastSenderId(),
}: WorkspaceManifestBroadcastSyncOptions): WorkspaceManifestBroadcastSync {
  if (typeof BroadcastChannel == "undefined") {
    return {
      broadcast: () => {},
      dispose: () => {},
    };
  }

  let channel = new BroadcastChannel(collabWorkspaceBroadcastChannelName(backend));

  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    let message = parseBroadcastSyncMessage(event.data);
    if (!message || message.kind != "workspace-update" || message.senderId == senderId) return;

    onRemoteUpdate?.(message.bytes);
  });

  return {
    broadcast(bytes) {
      channel.postMessage({
        bytes,
        kind: "workspace-update",
        senderId,
      } satisfies BroadcastSyncMessage);
    },
    dispose() {
      channel.close();
    },
  };
}

export function collabDocumentBroadcastChannelName(backend: WorkspaceBackend, docId: string) {
  return `local-md-workspace:${backend.kind}:${backend.id}:doc:${docId}`;
}

export function collabWorkspaceBroadcastChannelName(backend: WorkspaceBackend) {
  return `local-md-workspace:${backend.kind}:${backend.id}:workspace`;
}

function parseBroadcastSyncMessage(value: unknown): BroadcastSyncMessage | null {
  if (!value || typeof value != "object") return null;
  let record = value as Partial<BroadcastSyncMessage>;
  if (record.kind == "workspace-update") {
    if (typeof record.senderId != "string" || !(record.bytes instanceof Uint8Array)) return null;
    return {
      bytes: record.bytes,
      kind: "workspace-update",
      senderId: record.senderId,
    };
  }

  if (
    record.kind != "doc-update" ||
    typeof record.docId != "string" ||
    typeof record.senderId != "string" ||
    !(record.bytes instanceof Uint8Array)
  ) {
    return null;
  }

  return {
    bytes: record.bytes,
    docId: record.docId,
    kind: "doc-update",
    senderId: record.senderId,
  };
}

function getBroadcastSenderId() {
  return stableBroadcastSenderId;
}

const stableBroadcastSenderId = createBroadcastSenderId();

function createBroadcastSenderId() {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2);
  }
}
