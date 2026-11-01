import { isValidShareId, isValidShareSecret } from "@codemirror-treesitter/relay-core/client";

export type ShareLink = {
  guestSecret: string;
  shareId: string;
};

export type ShareCredentials = ShareLink & {
  hostSecret: string;
};

const shareIdBytes = 16;
const shareSecretBytes = 32;

export function createShareCredentials(
  randomBytes: (length: number) => Uint8Array = secureRandomBytes,
): ShareCredentials {
  return {
    guestSecret: randomToken(randomBytes(shareSecretBytes)),
    hostSecret: randomToken(randomBytes(shareSecretBytes)),
    shareId: randomToken(randomBytes(shareIdBytes)),
  };
}

/** Reads `#share=<id>&key=<guest secret>` from a location hash. */
export function parseShareHash(hash: string): ShareLink | null {
  let params = new URLSearchParams(hash.replace(/^#/, ""));
  let shareId = params.get("share") ?? "";
  let guestSecret = params.get("key") ?? "";
  if (!isValidShareId(shareId) || !isValidShareSecret(guestSecret)) return null;
  return { guestSecret, shareId };
}

export function shareHash({ guestSecret, shareId }: ShareLink) {
  return `#${new URLSearchParams({ share: shareId, key: guestSecret }).toString()}`;
}

export function shareUrl(base: string | URL, link: ShareLink) {
  let url = new URL(base);
  url.pathname = "/";
  url.search = "";
  url.hash = shareHash(link);
  return url.toString();
}

function randomToken(bytes: Uint8Array) {
  let binary = "";
  for (let byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function secureRandomBytes(length: number) {
  return crypto.getRandomValues(new Uint8Array(length));
}
