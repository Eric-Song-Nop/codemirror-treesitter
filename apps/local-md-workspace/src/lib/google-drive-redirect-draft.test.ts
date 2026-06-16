import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  saveGoogleDriveRedirectDraft,
  takeGoogleDriveRedirectDraft,
} from "./google-drive-redirect-draft.ts";

describe("Google Drive redirect draft storage", () => {
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

  it("saves and takes normalized Google Drive redirect drafts once", () => {
    saveGoogleDriveRedirectDraft({
      clientId: " client-id ",
      dirtyValue: "# Unsaved\n",
      root: " \\notes\\daily/ ",
      selectedPath: "/drafts\\today.md",
    });

    expect(takeGoogleDriveRedirectDraft()).toEqual({
      clientId: "client-id",
      dirtyValue: "# Unsaved\n",
      root: "notes/daily",
      selectedPath: "drafts/today.md",
    });
    expect(takeGoogleDriveRedirectDraft()).toBeNull();
  });

  it("persists config even when no dirty editor value can be restored", () => {
    saveGoogleDriveRedirectDraft({
      clientId: "client-id",
      dirtyValue: "# Missing path\n",
      root: "notes",
    });

    expect(takeGoogleDriveRedirectDraft()).toEqual({
      clientId: "client-id",
      root: "notes",
    });
  });

  it("ignores invalid drafts", () => {
    saveGoogleDriveRedirectDraft({ clientId: " " });

    expect(values.size).toBe(0);
    expect(takeGoogleDriveRedirectDraft()).toBeNull();
  });
});
