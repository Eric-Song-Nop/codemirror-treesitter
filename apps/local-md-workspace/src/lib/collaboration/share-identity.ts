import type { LoroDoc, UndoManager } from "loro-crdt";
import type { WorkspaceStorageKind } from "@/lib/storage/types";
import type { DocumentSourceRef } from "@/lib/workspace/source-identity";

export type ShareExpirationOption = "24h" | "7d" | "30d";

export type ShareCredentials = {
  guestSecret: string;
  hostSecret: string;
  shareId: string;
};

export type SharedFileRole = "owner" | "guest";

export type SharedFileSession = {
  clientId: string;
  doc: LoroDoc;
  role: SharedFileRole;
  shareId: string;
  undoManager: UndoManager;
};

export type OwnerSharedFileState = {
  backendKind: WorkspaceStorageKind;
  hostSecretRef: string;
  lastHostSavedVersion?: string;
  localFileId: string;
  materializedHash: string;
  path: string;
  shareId: string;
  sourceRef: DocumentSourceRef;
};

export type GuestSharedFileState = {
  displayName: string;
  sessionToken: string;
  shareId: string;
};

export type ShareLinkParts = {
  guestSecret: string;
  shareId: string;
};

export const shareIdBytes = 16;
export const shareSecretBytes = 32;

const base64UrlAlphabet = /^[A-Za-z0-9_-]+$/;
const shareIdLength = 22;
const shareSecretLength = 43;
const millisecondsByExpiration: Record<ShareExpirationOption, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function createShareCredentials(randomBytes = secureRandomBytes): ShareCredentials {
  return {
    guestSecret: randomToken(shareSecretBytes, randomBytes),
    hostSecret: randomToken(shareSecretBytes, randomBytes),
    shareId: randomToken(shareIdBytes, randomBytes),
  };
}

export function isValidShareId(value: string) {
  return value.length == shareIdLength && base64UrlAlphabet.test(value);
}

export function isValidShareSecret(value: string) {
  return value.length == shareSecretLength && base64UrlAlphabet.test(value);
}

export function shareExpiresAt(option: ShareExpirationOption, now = Date.now()) {
  return now + millisecondsByExpiration[option];
}

export function buildShareLink(baseUrl: string | URL, { guestSecret, shareId }: ShareLinkParts) {
  if (!isValidShareId(shareId)) throw new Error("Invalid share id.");
  if (!isValidShareSecret(guestSecret)) throw new Error("Invalid share secret.");

  let url = new URL(baseUrl);
  url.pathname = `/share/${encodeURIComponent(shareId)}`;
  url.search = "";
  url.hash = new URLSearchParams({ key: guestSecret }).toString();
  return url.toString();
}

export function parseShareLink(value: string | URL): ShareLinkParts | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  let match = /^\/share\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return null;

  let shareId = decodeURIComponent(match[1]!);
  let guestSecret = new URLSearchParams(url.hash.replace(/^#/, "")).get("key") ?? "";
  if (!isValidShareId(shareId) || !isValidShareSecret(guestSecret)) return null;

  return { guestSecret, shareId };
}

export async function hashShareSecret(secret: string) {
  if (!isValidShareSecret(secret)) throw new Error("Invalid share secret.");

  let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return encodeBase64Url(new Uint8Array(digest));
}

function randomToken(byteLength: number, randomBytes: (byteLength: number) => Uint8Array) {
  return encodeBase64Url(randomBytes(byteLength));
}

function secureRandomBytes(byteLength: number) {
  let bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
