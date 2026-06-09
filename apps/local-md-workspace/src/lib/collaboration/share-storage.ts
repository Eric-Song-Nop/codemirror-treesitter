import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";
import {
  getCollabDocumentValue,
  hashMarkdownText,
  type CollabDocumentState,
} from "./markdown-document.ts";
import {
  createRelayShare as defaultCreateRelayShare,
  revokeRelayShare as defaultRevokeRelayShare,
  rotateRelayShare as defaultRotateRelayShare,
  type RelayShareCreateRequest,
  type RelayShareRevokeResult,
  type RelayShareRotateRequest,
  type RelayShareRotateResult,
} from "./share-relay-client.ts";
import {
  buildShareLink,
  createShareCredentials,
  hashShareSecret,
  shareExpiresAt,
  type ShareExpirationOption,
} from "./share-identity.ts";

const shareRecordStoragePrefix = "local-md-workspace:share-record:";
const schemaVersion = 2;

export type OwnerShareRecord = {
  backendKind: "local" | "opendal-dropbox";
  createdAt: number;
  displayName: string;
  expiresAt: number | null;
  guestSecretHash: string;
  hostSecretHash: string;
  hostSecretRef: string;
  lastHostSavedVersion?: string;
  localFileId: string;
  materializedHash: string;
  path: string;
  revokedAt?: number;
  schemaVersion: 2;
  shareId: string;
  workspaceId: string;
};

export type CreateOwnerShareOptions = {
  backend: WorkspaceBackend;
  baseUrl: string | URL;
  document: CollabDocumentState;
  expiration: ShareExpirationOption;
  file: MarkdownFileNode;
  createRelayShare?: (relayOrigin: string, request: RelayShareCreateRequest) => Promise<void>;
  hostSecretStore?: Pick<Storage, "setItem">;
  now?: number;
  relayOrigin: string;
};

export type CreatedOwnerShare = {
  link: string;
  record: OwnerShareRecord;
};

export type RotateOwnerShareOptions = {
  backend: WorkspaceBackend;
  baseUrl: string | URL;
  expiration: ShareExpirationOption;
  hostSecret: string;
  now?: number;
  record: OwnerShareRecord;
  relayOrigin: string;
  rotateRelayShare?: (
    relayOrigin: string,
    shareId: string,
    request: RelayShareRotateRequest,
  ) => Promise<RelayShareRotateResult>;
};

export type RevokeOwnerShareOptions = {
  backend: WorkspaceBackend;
  hostSecret: string;
  record: OwnerShareRecord;
  relayOrigin: string;
  revokeRelayShare?: (
    relayOrigin: string,
    shareId: string,
    hostSecret: string,
  ) => Promise<RelayShareRevokeResult>;
};

type ShareRecordStore = Pick<Storage, "getItem" | "key" | "removeItem" | "setItem"> & {
  readonly length: number;
};

let memoryShareRecords = new Map<string, string>();

export async function createOwnerShare({
  backend,
  baseUrl,
  document,
  expiration,
  file,
  createRelayShare = defaultCreateRelayShare,
  hostSecretStore,
  now = Date.now(),
  relayOrigin,
}: CreateOwnerShareOptions): Promise<CreatedOwnerShare> {
  if (backend.kind != "local" && backend.kind != "opendal-dropbox") {
    throw new Error("This workspace cannot host shared files.");
  }

  let credentials = createShareCredentials();
  let hostSecretRef = hostSecretStorageKey(credentials.shareId);
  let record: OwnerShareRecord = {
    backendKind: backend.kind,
    createdAt: now,
    displayName: file.name,
    expiresAt: shareExpiresAt(expiration, now),
    guestSecretHash: await hashShareSecret(credentials.guestSecret),
    hostSecretHash: await hashShareSecret(credentials.hostSecret),
    hostSecretRef,
    localFileId: document.docId,
    materializedHash: hashMarkdownText(getCollabDocumentValue(document)),
    path: file.path,
    schemaVersion,
    shareId: credentials.shareId,
    workspaceId: workspaceShareNamespace(backend),
  };

  await createRelayShare(relayOrigin, {
    displayName: record.displayName,
    expiresAt: record.expiresAt,
    guestSecretHash: record.guestSecretHash,
    hostSecretHash: record.hostSecretHash,
    shareId: record.shareId,
    snapshot: document.doc.export({ mode: "snapshot" }),
  });
  saveHostSecret(hostSecretRef, credentials.hostSecret, hostSecretStore);
  await writeOwnerShareRecord(backend, record);
  return {
    link: buildShareLink(baseUrl, credentials),
    record,
  };
}

export async function rotateOwnerShare({
  backend,
  baseUrl,
  expiration,
  hostSecret,
  now = Date.now(),
  record,
  relayOrigin,
  rotateRelayShare = defaultRotateRelayShare,
}: RotateOwnerShareOptions): Promise<CreatedOwnerShare> {
  if (record.revokedAt != null) throw new Error("This file is no longer shared.");

  let credentials = createShareCredentials();
  let expiresAt = shareExpiresAt(expiration, now);
  let nextGuestSecretHash = await hashShareSecret(credentials.guestSecret);
  let result = await rotateRelayShare(relayOrigin, record.shareId, {
    expiresAt,
    hostSecret,
    nextGuestSecretHash,
  });
  if (result.shareId != record.shareId) throw new Error("Relay returned the wrong share.");

  let nextRecord: OwnerShareRecord = {
    ...record,
    expiresAt: result.expiresAt,
    guestSecretHash: nextGuestSecretHash,
  };
  await writeOwnerShareRecord(backend, nextRecord);
  return {
    link: buildShareLink(baseUrl, {
      guestSecret: credentials.guestSecret,
      shareId: record.shareId,
    }),
    record: nextRecord,
  };
}

export async function revokeOwnerShare({
  backend,
  hostSecret,
  record,
  relayOrigin,
  revokeRelayShare = defaultRevokeRelayShare,
}: RevokeOwnerShareOptions) {
  let result = await revokeRelayShare(relayOrigin, record.shareId, hostSecret);
  if (result.shareId != record.shareId) throw new Error("Relay returned the wrong share.");

  let nextRecord: OwnerShareRecord = {
    ...record,
    revokedAt: result.revokedAt,
  };
  await writeOwnerShareRecord(backend, nextRecord);
  return nextRecord;
}

export async function readOwnerShareRecord(_backend: WorkspaceBackend, shareId: string) {
  let raw = shareRecordStore().getItem(ownerShareRecordPath(shareId));
  if (!raw) throw new Error("Shared file metadata is not available in this browser.");
  return parseOwnerShareRecord(JSON.parse(raw));
}

export async function findOwnerShareRecordForPath(backend: WorkspaceBackend, path: string) {
  let store = shareRecordStore();
  let workspaceId = workspaceShareNamespace(backend);
  let records: OwnerShareRecord[] = [];
  for (let index = 0; index < store.length; index++) {
    let key = store.key(index);
    if (!key?.startsWith(shareRecordStoragePrefix)) continue;
    try {
      let raw = store.getItem(key);
      if (!raw) continue;
      let record = parseOwnerShareRecord(JSON.parse(raw));
      if (record.workspaceId == workspaceId && record.path == path && record.revokedAt == null) {
        records.push(record);
      }
    } catch {
      // Ignore corrupt browser records so one bad entry does not block the file.
    }
  }

  records.sort((left, right) => right.createdAt - left.createdAt);
  return records[0] ?? null;
}

export async function writeOwnerShareRecord(_backend: WorkspaceBackend, record: OwnerShareRecord) {
  shareRecordStore().setItem(ownerShareRecordPath(record.shareId), JSON.stringify(record));
}

export function ownerShareRecordPath(shareId: string) {
  return `${shareRecordStoragePrefix}${shareId}`;
}

export function hostSecretStorageKey(shareId: string) {
  return `local-md-workspace:share-host-secret:${shareId}`;
}

function saveHostSecret(
  key: string,
  hostSecret: string,
  store: Pick<Storage, "setItem"> | undefined,
) {
  let target = store ?? browserLocalStorage();
  if (!target) throw new Error("Browser storage is required to host a shared file.");
  try {
    target.setItem(key, hostSecret);
  } catch {
    throw new Error("Browser storage is required to host a shared file.");
  }
  return key;
}

function parseOwnerShareRecord(value: unknown): OwnerShareRecord {
  if (!value || typeof value != "object") throw new Error("Invalid share metadata.");
  let record = value as Partial<OwnerShareRecord>;
  if (
    record.schemaVersion != schemaVersion ||
    typeof record.shareId != "string" ||
    typeof record.localFileId != "string" ||
    typeof record.path != "string" ||
    typeof record.workspaceId != "string" ||
    typeof record.displayName != "string" ||
    (record.backendKind != "local" && record.backendKind != "opendal-dropbox") ||
    typeof record.createdAt != "number" ||
    (record.expiresAt != null && typeof record.expiresAt != "number") ||
    typeof record.guestSecretHash != "string" ||
    typeof record.hostSecretHash != "string" ||
    typeof record.hostSecretRef != "string" ||
    typeof record.materializedHash != "string" ||
    (record.revokedAt != null && typeof record.revokedAt != "number")
  ) {
    throw new Error("Invalid share metadata.");
  }

  return {
    backendKind: record.backendKind,
    createdAt: record.createdAt,
    displayName: record.displayName,
    expiresAt: record.expiresAt ?? null,
    guestSecretHash: record.guestSecretHash,
    hostSecretHash: record.hostSecretHash,
    hostSecretRef: record.hostSecretRef,
    ...(typeof record.lastHostSavedVersion == "string"
      ? { lastHostSavedVersion: record.lastHostSavedVersion }
      : {}),
    localFileId: record.localFileId,
    materializedHash: record.materializedHash,
    path: record.path,
    ...(typeof record.revokedAt == "number" ? { revokedAt: record.revokedAt } : {}),
    schemaVersion,
    shareId: record.shareId,
    workspaceId: record.workspaceId,
  };
}

export function resetOwnerShareRecordStoreForTests() {
  memoryShareRecords = new Map();
}

function workspaceShareNamespace(backend: WorkspaceBackend) {
  return `${backend.kind}:${backend.id}`;
}

function shareRecordStore(): ShareRecordStore {
  let storage = browserLocalStorage();
  if (storage) return storage;

  return memoryShareRecordStore;
}

function browserLocalStorage(): Storage | null {
  try {
    let storage = (globalThis as typeof globalThis & { window?: { localStorage?: Storage } }).window
      ?.localStorage;
    if (storage) return storage;
  } catch {}

  let descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  if (descriptor && "value" in descriptor && descriptor.value) {
    return descriptor.value as Storage;
  }
  return null;
}

const memoryShareRecordStore: ShareRecordStore = {
  get length() {
    return memoryShareRecords.size;
  },
  getItem(key) {
    return memoryShareRecords.get(key) ?? null;
  },
  key(index) {
    return [...memoryShareRecords.keys()][index] ?? null;
  },
  removeItem(key) {
    memoryShareRecords.delete(key);
  },
  setItem(key, value) {
    memoryShareRecords.set(key, value);
  },
};
