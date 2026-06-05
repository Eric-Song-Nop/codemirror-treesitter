import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { saveDropboxRedirectDraft, takeDropboxRedirectDraft } from "./dropbox-redirect-draft.ts";

describe("Dropbox redirect draft storage", () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves and takes normalized Dropbox redirect drafts once", () => {
    saveDropboxRedirectDraft({
      appKey: " app-key ",
      dirtyValue: "# Unsaved\n",
      root: " \\notes\\daily/ ",
      selectedPath: "/drafts\\today.md",
    });

    expect(takeDropboxRedirectDraft()).toEqual({
      appKey: "app-key",
      dirtyValue: "# Unsaved\n",
      root: "notes/daily",
      selectedPath: "drafts/today.md",
    });
    expect(takeDropboxRedirectDraft()).toBeNull();
  });

  it("persists config even when no dirty editor value can be restored", () => {
    saveDropboxRedirectDraft({
      appKey: "app-key",
      dirtyValue: "# Missing path\n",
      root: "notes",
    });

    expect(takeDropboxRedirectDraft()).toEqual({
      appKey: "app-key",
      root: "notes",
    });
  });

  it("ignores invalid drafts", () => {
    saveDropboxRedirectDraft({ appKey: " " });

    expect(values.size).toBe(0);
    expect(takeDropboxRedirectDraft()).toBeNull();
  });
});
