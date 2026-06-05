import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  loadStoredDropboxWorkspaceConfig,
  saveStoredDropboxWorkspaceConfig,
} from "./workspace-store.ts";

const DROPBOX_CONFIG_KEY = "local-md-workspace:dropbox-config";

describe("Dropbox workspace config storage", () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves and restores normalized non-secret Dropbox config", () => {
    saveStoredDropboxWorkspaceConfig({
      appKey: " test-app-key ",
      root: " \\notes\\daily/ ",
    });

    expect(values.get(DROPBOX_CONFIG_KEY)).toBe(
      JSON.stringify({
        appKey: "test-app-key",
        root: "notes/daily",
      }),
    );
    expect(loadStoredDropboxWorkspaceConfig()).toEqual({
      appKey: "test-app-key",
      root: "notes/daily",
    });
  });

  it("ignores malformed or empty stored Dropbox config", () => {
    values.set(DROPBOX_CONFIG_KEY, JSON.stringify({ appKey: " " }));
    expect(loadStoredDropboxWorkspaceConfig()).toBeNull();

    values.set(DROPBOX_CONFIG_KEY, "{");
    expect(loadStoredDropboxWorkspaceConfig()).toBeNull();
  });

  it("does not persist invalid Dropbox app keys", () => {
    saveStoredDropboxWorkspaceConfig({ appKey: " " });

    expect(values.has(DROPBOX_CONFIG_KEY)).toBe(false);
  });
});
