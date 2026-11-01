import { isValidShareId, isValidShareSecret } from "@codemirror-treesitter/relay-core/client";
import { describe, expect, it } from "vite-plus/test";
import { createShareCredentials, parseShareHash, shareHash, shareUrl } from "./share-link.ts";

describe("collab editor share links", () => {
  it("creates relay-compatible share ids and secrets", () => {
    let credentials = createShareCredentials();

    expect(isValidShareId(credentials.shareId)).toBe(true);
    expect(isValidShareSecret(credentials.guestSecret)).toBe(true);
    expect(isValidShareSecret(credentials.hostSecret)).toBe(true);
    expect(credentials.guestSecret).not.toBe(credentials.hostSecret);
  });

  it("round-trips the share id and guest key through the URL hash only", () => {
    let { guestSecret, shareId } = createShareCredentials();
    let url = new URL(shareUrl("https://collab.example/some/path?x=1", { guestSecret, shareId }));

    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(parseShareHash(url.hash)).toEqual({ guestSecret, shareId });
    expect(parseShareHash(shareHash({ guestSecret, shareId }))).toEqual({ guestSecret, shareId });
  });

  it("rejects legacy room hashes and malformed keys", () => {
    expect(parseShareHash("#Ab3kP9qLm2xZ")).toBeNull();
    expect(parseShareHash("#share=AAAAAAAAAAAAAAAAAAAAAA&key=short")).toBeNull();
    expect(parseShareHash("")).toBeNull();
  });
});
