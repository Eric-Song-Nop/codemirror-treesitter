import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { saveOneDriveRedirectDraft, takeOneDriveRedirectDraft } from "./onedrive-redirect-draft.ts";

describe("OneDrive redirect draft storage", () => {
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

  it("saves and takes normalized OneDrive redirect drafts once", () => {
    saveOneDriveRedirectDraft({
      clientId: " client-id ",
      dirtyValue: "# Unsaved\n",
      root: " \\notes\\daily/ ",
      selectedPath: "/drafts\\today.md",
    });

    expect(takeOneDriveRedirectDraft()).toEqual({
      clientId: "client-id",
      dirtyValue: "# Unsaved\n",
      root: "notes/daily",
      selectedPath: "drafts/today.md",
    });
    expect(takeOneDriveRedirectDraft()).toBeNull();
  });

  it("persists config even when no dirty editor value can be restored", () => {
    saveOneDriveRedirectDraft({
      clientId: "client-id",
      dirtyValue: "# Missing path\n",
      root: "notes",
    });

    expect(takeOneDriveRedirectDraft()).toEqual({
      clientId: "client-id",
      root: "notes",
    });
  });

  it("ignores invalid drafts", () => {
    saveOneDriveRedirectDraft({ clientId: " " });

    expect(values.size).toBe(0);
    expect(takeOneDriveRedirectDraft()).toBeNull();
  });
});
