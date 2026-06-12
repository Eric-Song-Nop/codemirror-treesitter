import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clearStoredWorkspaceSelectedPath,
  loadStoredDropboxWorkspaceConfig,
  loadStoredWorkspaceSelectedPath,
  loadStoredWorkspaceKind,
  saveStoredDropboxWorkspaceConfig,
  saveStoredWorkspaceSelectedPath,
  saveStoredWorkspaceKind,
} from "./workspace-store.ts";

const DROPBOX_CONFIG_KEY = "local-md-workspace:dropbox-config";
const WORKSPACE_KIND_KEY = "local-md-workspace:workspace-kind";

describe("Dropbox workspace config storage", () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
        removeItem: vi.fn((key: string) => values.delete(key)),
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

  it("saves and restores the last workspace kind", () => {
    saveStoredWorkspaceKind("dropbox");
    expect(values.get(WORKSPACE_KIND_KEY)).toBe("dropbox");
    expect(loadStoredWorkspaceKind()).toBe("dropbox");

    saveStoredWorkspaceKind("local");
    expect(values.get(WORKSPACE_KIND_KEY)).toBe("local");
    expect(loadStoredWorkspaceKind()).toBe("local");
  });

  it("ignores unknown stored workspace kinds", () => {
    values.set(WORKSPACE_KIND_KEY, "other");

    expect(loadStoredWorkspaceKind()).toBeNull();
  });
});

describe("workspace selected path storage", () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
        removeItem: vi.fn((key: string) => values.delete(key)),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("isolates selected paths between local and Dropbox workspace contexts", () => {
    let localContext = { kind: "local" as const, workspaceId: "/Users/test/notes" };
    let dropboxContext = { kind: "dropbox" as const, workspaceId: "/Users/test/notes" };

    saveStoredWorkspaceSelectedPath(localContext, "local.md");
    saveStoredWorkspaceSelectedPath(dropboxContext, "dropbox.md");

    expect(loadStoredWorkspaceSelectedPath(localContext)).toBe("local.md");
    expect(loadStoredWorkspaceSelectedPath(dropboxContext)).toBe("dropbox.md");
  });

  it("isolates selected paths between workspace ids within the same kind", () => {
    let firstContext = { kind: "dropbox" as const, workspaceId: "team-a" };
    let secondContext = { kind: "dropbox" as const, workspaceId: "team-b" };

    saveStoredWorkspaceSelectedPath(firstContext, "daily.md");
    saveStoredWorkspaceSelectedPath(secondContext, "weekly.md");

    expect(loadStoredWorkspaceSelectedPath(firstContext)).toBe("daily.md");
    expect(loadStoredWorkspaceSelectedPath(secondContext)).toBe("weekly.md");
  });

  it("normalizes selected paths before saving and loading", () => {
    let context = { kind: "local" as const, workspaceId: "notes" };

    saveStoredWorkspaceSelectedPath(context, " \\daily\\today.md ");

    expect(loadStoredWorkspaceSelectedPath(context)).toBe("daily/today.md");

    saveStoredWorkspaceSelectedPath(context, " /nested\\note.txt ");

    expect(loadStoredWorkspaceSelectedPath(context)).toBe("nested/note.txt");
  });

  it("does not save empty selected paths", () => {
    let context = { kind: "local" as const, workspaceId: "notes" };

    saveStoredWorkspaceSelectedPath(context, " / ");

    expect(values.size).toBe(0);
    expect(loadStoredWorkspaceSelectedPath(context)).toBeNull();
  });

  it("returns null for invalid stored selected paths", () => {
    let context = { kind: "dropbox" as const, workspaceId: "team" };

    saveStoredWorkspaceSelectedPath(context, "readme.md");
    let [key] = values.keys();
    values.set(key, " / ");

    expect(loadStoredWorkspaceSelectedPath(context)).toBeNull();
  });

  it("ignores localStorage failures for selected paths", () => {
    let context = { kind: "local" as const, workspaceId: "notes" };
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error("unavailable");
        }),
        setItem: vi.fn(() => {
          throw new Error("full");
        }),
        removeItem: vi.fn(() => {
          throw new Error("unavailable");
        }),
      },
    });

    expect(loadStoredWorkspaceSelectedPath(context)).toBeNull();
    expect(() => saveStoredWorkspaceSelectedPath(context, "readme.md")).not.toThrow();
    expect(() => clearStoredWorkspaceSelectedPath(context)).not.toThrow();
  });

  it("clears stored selected paths", () => {
    let context = { kind: "local" as const, workspaceId: "notes" };

    saveStoredWorkspaceSelectedPath(context, "readme.md");
    clearStoredWorkspaceSelectedPath(context);

    expect(loadStoredWorkspaceSelectedPath(context)).toBeNull();
  });
});
