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

const livemdDirectory = ".livemd";
const sharesDirectory = `${livemdDirectory}/shares`;
const schemaVersion = 1;

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
  schemaVersion: 1;
  shareId: string;
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

type ShareStorageBackend = WorkspaceBackend &
  Required<Pick<WorkspaceBackend, "createDirectory" | "readTextFile" | "writeTextFile">>;
type ShareDiscoveryBackend = ShareStorageBackend & Required<Pick<WorkspaceBackend, "listEntries">>;

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
  ensureShareStorageBackend(backend);
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
  ensureShareStorageBackend(backend);
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
  ensureShareStorageBackend(backend);
  let result = await revokeRelayShare(relayOrigin, record.shareId, hostSecret);
  if (result.shareId != record.shareId) throw new Error("Relay returned the wrong share.");

  let nextRecord: OwnerShareRecord = {
    ...record,
    revokedAt: result.revokedAt,
  };
  await writeOwnerShareRecord(backend, nextRecord);
  return nextRecord;
}

export async function readOwnerShareRecord(backend: WorkspaceBackend, shareId: string) {
  ensureShareStorageBackend(backend);
  let raw = await backend.readTextFile(ownerShareRecordPath(shareId));
  return parseOwnerShareRecord(JSON.parse(raw));
}

export async function findOwnerShareRecordForPath(backend: WorkspaceBackend, path: string) {
  ensureShareDiscoveryBackend(backend);

  let entries: Awaited<ReturnType<ShareDiscoveryBackend["listEntries"]>>;
  try {
    entries = await backend.listEntries(sharesDirectory);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }

  let records: OwnerShareRecord[] = [];
  for (let entry of entries) {
    if (!entry.isFile || !entry.path.endsWith(".json")) continue;
    try {
      let raw = await backend.readTextFile(entry.path);
      let record = parseOwnerShareRecord(JSON.parse(raw));
      if (record.path == path && record.revokedAt == null) records.push(record);
    } catch {
      // Ignore corrupt share records so one bad sidecar does not block the file.
    }
  }

  records.sort((left, right) => right.createdAt - left.createdAt);
  return records[0] ?? null;
}

export async function writeOwnerShareRecord(backend: WorkspaceBackend, record: OwnerShareRecord) {
  ensureShareStorageBackend(backend);
  await backend.createDirectory(sharesDirectory);
  await backend.writeTextFile(
    ownerShareRecordPath(record.shareId),
    JSON.stringify(record, null, 2),
  );
}

export function ownerShareRecordPath(shareId: string) {
  return `${sharesDirectory}/${shareId}.json`;
}

export function hostSecretStorageKey(shareId: string) {
  return `local-md-workspace:share-host-secret:${shareId}`;
}

function saveHostSecret(
  key: string,
  hostSecret: string,
  store: Pick<Storage, "setItem"> | undefined,
) {
  let target = store ?? globalThis.localStorage;
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
  };
}

function ensureShareStorageBackend(
  backend: WorkspaceBackend,
): asserts backend is ShareStorageBackend {
  if (!backend.createDirectory || !backend.readTextFile || !backend.writeTextFile) {
    throw new Error("This workspace backend does not support shared file metadata.");
  }
}

function ensureShareDiscoveryBackend(
  backend: WorkspaceBackend,
): asserts backend is ShareDiscoveryBackend {
  ensureShareStorageBackend(backend);
  if (!backend.listEntries) {
    throw new Error("This workspace backend does not support shared file discovery.");
  }
}

function isNotFoundError(error: unknown) {
  return error instanceof DOMException && error.name == "NotFoundError";
}
