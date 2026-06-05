import { describe, expect, it } from "vite-plus/test";
import {
  createWorkspaceProviderStatus,
  dropboxRootLabel,
  dropboxTokenExpiryStatus,
} from "./workspace-status.ts";
import type { WorkspaceBackend } from "./workspace-backend.ts";

describe("workspace provider status", () => {
  it("describes a local workspace", () => {
    expect(createWorkspaceProviderStatus(backend("local"), null, 1000)).toEqual({
      icon: "folder",
      label: "Local folder",
      state: "connected",
    });
  });

  it("describes Dropbox root and token expiry", () => {
    expect(
      createWorkspaceProviderStatus(
        backend("opendal-dropbox"),
        {
          expiresAt: 1000 + 125 * 60_000,
          root: "notes",
        },
        1000,
      ),
    ).toEqual({
      icon: "cloud",
      label: "Dropbox · notes · token 2h 5m",
      state: "connected",
    });
  });

  it("uses the app root label for the default Dropbox root", () => {
    expect(dropboxRootLabel(undefined)).toBe("app root");
    expect(dropboxRootLabel(" notes ")).toBe("notes");
  });

  it("formats short, expired, and unknown Dropbox token states", () => {
    expect(dropboxTokenExpiryStatus(1000 + 30_000, 1000)).toEqual({
      label: "token 1m",
      state: "connected",
    });
    expect(dropboxTokenExpiryStatus(1000, 1000)).toEqual({
      label: "token expired",
      state: "expired",
    });
    expect(dropboxTokenExpiryStatus(undefined, 1000)).toEqual({
      label: "token unknown",
      state: "unknown",
    });
  });
});

function backend(kind: WorkspaceBackend["kind"]): WorkspaceBackend {
  return {
    createFile: async () => "",
    deleteFile: async () => {},
    id: kind,
    kind,
    name: kind,
    readFile: async () => "",
    readTree: async () => ({
      children: [],
      kind: "directory",
      name: kind,
      path: "",
    }),
    renameFile: async () => "",
    writeFile: async () => {},
  };
}
