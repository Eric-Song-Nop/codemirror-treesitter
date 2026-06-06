export type ShareRole = "guest" | "host";

export type ShareRecord = {
  createdAt: number;
  displayName: string;
  expiresAt: number | null;
  guestSecretHash: string;
  hostSecretHash: string;
  revokedAt?: number;
  schemaVersion: 1;
  shareId: string;
};

export type ShareSessionRecord = {
  clientId: string;
  expiresAt: number;
  role: ShareRole;
  secretHash: string;
};

export type CreateShareRequest = {
  displayName: string;
  expiresAt: number | null;
  guestSecretHash: string;
  hostSecretHash: string;
  shareId: string;
  snapshot: string;
};

export type CreateSessionRequest = {
  role: ShareRole;
  secret: string;
};

export type RotateShareRequest = {
  expiresAt?: number | null;
  hostSecret: string;
  nextGuestSecretHash: string;
};

export type RevokeShareRequest = {
  hostSecret: string;
};

export const shareSchemaVersion = 1;
export const shareSessionTtlMs = 12 * 60 * 60 * 1000;
export const shareRetentionMs = 7 * 24 * 60 * 60 * 1000;

const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const shareIdLength = 22;
const secretLength = 43;
const maxDisplayNameLength = 160;

export function parseCreateShareRequest(value: unknown): CreateShareRequest | null {
  if (!value || typeof value != "object") return null;
  let record = value as Partial<CreateShareRequest>;
  if (
    typeof record.shareId != "string" ||
    !isValidShareId(record.shareId) ||
    typeof record.displayName != "string" ||
    !record.displayName.trim() ||
    record.displayName.length > maxDisplayNameLength ||
    !isValidShareSecretHash(record.guestSecretHash) ||
    !isValidShareSecretHash(record.hostSecretHash) ||
    (record.expiresAt != null &&
      (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now())) ||
    typeof record.snapshot != "string"
  ) {
    return null;
  }

  return {
    displayName: record.displayName.trim(),
    expiresAt: record.expiresAt ?? null,
    guestSecretHash: record.guestSecretHash,
    hostSecretHash: record.hostSecretHash,
    shareId: record.shareId,
    snapshot: record.snapshot,
  };
}

export function parseCreateSessionRequest(value: unknown): CreateSessionRequest | null {
  if (!value || typeof value != "object") return null;
  let record = value as Partial<CreateSessionRequest>;
  if ((record.role != "guest" && record.role != "host") || !isValidShareSecret(record.secret)) {
    return null;
  }

  return { role: record.role, secret: record.secret };
}

export function parseRotateShareRequest(value: unknown): RotateShareRequest | null {
  if (!value || typeof value != "object") return null;
  let record = value as Partial<RotateShareRequest>;
  if (
    !isValidShareSecret(record.hostSecret) ||
    !isValidShareSecretHash(record.nextGuestSecretHash) ||
    (record.expiresAt !== undefined &&
      record.expiresAt !== null &&
      (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()))
  ) {
    return null;
  }

  return {
    expiresAt: record.expiresAt,
    hostSecret: record.hostSecret,
    nextGuestSecretHash: record.nextGuestSecretHash,
  };
}

export function parseRevokeShareRequest(value: unknown): RevokeShareRequest | null {
  if (!value || typeof value != "object") return null;
  let record = value as Partial<RevokeShareRequest>;
  return isValidShareSecret(record.hostSecret) ? { hostSecret: record.hostSecret } : null;
}

export function isShareActive(record: ShareRecord, now = Date.now()) {
  return record.revokedAt == null && (record.expiresAt == null || record.expiresAt > now);
}

export function shareCleanupDueAt(
  record: ShareRecord,
  retentionMs = shareRetentionMs,
): number | null {
  let endedAt = shareEndedAt(record);
  return endedAt == null ? null : endedAt + retentionMs;
}

export function isShareCleanupDue(
  record: ShareRecord,
  now = Date.now(),
  retentionMs = shareRetentionMs,
) {
  let cleanupAt = shareCleanupDueAt(record, retentionMs);
  return cleanupAt != null && cleanupAt <= now;
}

export function isValidShareId(value: unknown): value is string {
  return typeof value == "string" && value.length == shareIdLength && base64UrlPattern.test(value);
}

export function isValidShareSecret(value: unknown): value is string {
  return typeof value == "string" && value.length == secretLength && base64UrlPattern.test(value);
}

export function isValidShareSecretHash(value: unknown): value is string {
  return isValidShareSecret(value);
}

export async function hashShareSecret(secret: string) {
  if (!isValidShareSecret(secret)) throw new Error("Invalid share secret.");
  let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return encodeBase64Url(new Uint8Array(digest));
}

export function createSessionToken() {
  let bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (let byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(value: string) {
  try {
    let binary = atob(value);
    let bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export function timingSafeEqualString(left: string, right: string) {
  let leftBytes = new TextEncoder().encode(left);
  let rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength != rightBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index++) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference == 0;
}

function encodeBase64Url(bytes: Uint8Array) {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function shareEndedAt(record: ShareRecord) {
  let timestamps: number[] = [];
  if (record.revokedAt != null && Number.isFinite(record.revokedAt)) {
    timestamps.push(record.revokedAt);
  }
  if (record.expiresAt != null && Number.isFinite(record.expiresAt)) {
    timestamps.push(record.expiresAt);
  }
  return timestamps.length ? Math.min(...timestamps) : null;
}
