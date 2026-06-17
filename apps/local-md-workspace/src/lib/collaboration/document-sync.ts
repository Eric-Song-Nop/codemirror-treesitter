import type { LoroDoc } from "loro-crdt";
import type { WorkspaceBackend } from "@/lib/workspace-backend";
import { collabBroadcastChannelName } from "@/lib/workspace/source-identity";

type BroadcastSyncMessage = {
  bytes: Uint8Array;
  docId: string;
  kind: "doc-update";
  senderId: string;
};

export type CollabDocumentBroadcastSyncOptions = {
  backend: WorkspaceBackend;
  doc: LoroDoc;
  docId: string;
  onRemoteUpdate?: () => void;
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

export function collabDocumentBroadcastChannelName(backend: WorkspaceBackend, docId: string) {
  return collabBroadcastChannelName(backend, docId);
}

function parseBroadcastSyncMessage(value: unknown): BroadcastSyncMessage | null {
  if (!value || typeof value != "object") return null;
  let record = value as Partial<BroadcastSyncMessage>;
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
