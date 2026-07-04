import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clearSharedMarkdownDraftLaunchParams,
  readSharedMarkdownDraftLaunch,
  sharedMarkdownDraftLaunchErrorMessage,
  sharedMarkdownImportFailedMessage,
  sharedMarkdownUnsupportedMessage,
} from "./share-target.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("share target launch params", () => {
  it("reads a shared draft id", () => {
    stubWindow("https://example.com/?shared-draft=draft-1");

    expect(readSharedMarkdownDraftLaunch()).toEqual({ draftId: "draft-1" });
  });

  it("reads supported launch errors", () => {
    stubWindow("https://example.com/?shared-draft-error=unsupported");

    expect(readSharedMarkdownDraftLaunch()).toEqual({ error: "unsupported" });
    expect(sharedMarkdownDraftLaunchErrorMessage("unsupported")).toBe(
      sharedMarkdownUnsupportedMessage,
    );
    expect(sharedMarkdownDraftLaunchErrorMessage("failed")).toBe(sharedMarkdownImportFailedMessage);
  });

  it("clears launch params without changing other url parts", () => {
    let replaceState = vi.fn();
    stubWindow("https://example.com/?shared-draft=draft-1&theme=dark#editor", replaceState);

    clearSharedMarkdownDraftLaunchParams();

    expect(replaceState).toHaveBeenCalledWith({}, "", "/?theme=dark#editor");
  });
});

function stubWindow(href: string, replaceState = vi.fn()) {
  vi.stubGlobal("window", {
    history: {
      replaceState,
      state: {},
    },
    location: {
      href,
    },
  });
}
