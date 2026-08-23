import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { saveGoogleDriveRedirectDraft, takeGoogleDriveRedirectDraft } from "./redirect-draft.ts";

const GOOGLE_DRIVE_REDIRECT_DRAFT_KEY = "local-md-workspace:google-drive-redirect-draft";

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
      selectedPath: "/drafts\\today.md",
    });

    expect(takeGoogleDriveRedirectDraft()).toEqual({
      clientId: "client-id",
      dirtyValue: "# Unsaved\n",
      selectedPath: "drafts/today.md",
    });
    expect(takeGoogleDriveRedirectDraft()).toBeNull();
  });

  it("persists config even when no dirty editor value can be restored", () => {
    saveGoogleDriveRedirectDraft({
      clientId: "client-id",
      dirtyValue: "# Missing path\n",
    });

    expect(takeGoogleDriveRedirectDraft()).toEqual({
      clientId: "client-id",
    });
  });

  it("drops legacy Google Drive redirect roots", () => {
    values.set(
      GOOGLE_DRIVE_REDIRECT_DRAFT_KEY,
      JSON.stringify({
        clientId: "client-id",
        dirtyValue: "# Draft\n",
        root: "legacy/root",
        selectedPath: "/drafts\\today.md",
      }),
    );

    expect(takeGoogleDriveRedirectDraft()).toEqual({
      clientId: "client-id",
      dirtyValue: "# Draft\n",
      selectedPath: "drafts/today.md",
    });
  });

  it("ignores invalid drafts", () => {
    saveGoogleDriveRedirectDraft({ clientId: " " });

    expect(values.size).toBe(0);
    expect(takeGoogleDriveRedirectDraft()).toBeNull();
  });
});
