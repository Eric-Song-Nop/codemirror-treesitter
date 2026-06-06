import { describe, expect, it } from "vite-plus/test";
import {
  buildShareLink,
  createShareCredentials,
  hashShareSecret,
  isValidShareId,
  isValidShareSecret,
  parseShareLink,
  shareExpiresAt,
} from "./share-identity.ts";

describe("shared file identity", () => {
  it("creates non-derived share ids and owner/guest secrets", () => {
    let nextByte = 0;
    let credentials = createShareCredentials((byteLength) => {
      let bytes = new Uint8Array(byteLength);
      for (let index = 0; index < bytes.length; index++) bytes[index] = nextByte++ & 0xff;
      return bytes;
    });

    expect(credentials.shareId).toHaveLength(22);
    expect(credentials.guestSecret).toHaveLength(43);
    expect(credentials.hostSecret).toHaveLength(43);
    expect(isValidShareId(credentials.shareId)).toBe(true);
    expect(isValidShareSecret(credentials.guestSecret)).toBe(true);
    expect(isValidShareSecret(credentials.hostSecret)).toBe(true);
    expect(credentials.guestSecret).not.toBe(credentials.hostSecret);
  });

  it("keeps the guest capability in the URL fragment", () => {
    let credentials = createShareCredentials((byteLength) => new Uint8Array(byteLength).fill(7));
    let link = buildShareLink("https://example.test/workspace?debug=1", credentials);
    let url = new URL(link);

    expect(url.pathname).toBe(`/share/${credentials.shareId}`);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#key=${credentials.guestSecret}`);
    expect(parseShareLink(link)).toEqual({
      guestSecret: credentials.guestSecret,
      shareId: credentials.shareId,
    });
  });

  it("rejects malformed share links", () => {
    expect(parseShareLink("https://example.test/share/not-valid#key=also-bad")).toBeNull();
    expect(parseShareLink("https://example.test/workspace#key=missing-route")).toBeNull();
  });

  it("computes explicit share expiration times", () => {
    let now = Date.UTC(2026, 5, 6);

    expect(shareExpiresAt("24h", now)).toBe(now + 24 * 60 * 60 * 1000);
    expect(shareExpiresAt("7d", now)).toBe(now + 7 * 24 * 60 * 60 * 1000);
    expect(shareExpiresAt("30d", now)).toBe(now + 30 * 24 * 60 * 60 * 1000);
    expect(shareExpiresAt("never", now)).toBeNull();
  });

  it("hashes secrets without returning the raw capability", async () => {
    let credentials = createShareCredentials((byteLength) => new Uint8Array(byteLength).fill(13));
    let hash = await hashShareSecret(credentials.guestSecret);

    expect(hash).toHaveLength(43);
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hash).not.toBe(credentials.guestSecret);
  });
});
