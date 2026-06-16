import { describe, expect, it } from "vite-plus/test";
import {
  GOOGLE_DRIVE_APP_WORKSPACE_MANIFEST_PATH,
  ensureGoogleDriveAppWorkspaceManifest,
  ensureGoogleDriveAppWorkspaceRoot,
} from "./google-drive-app-workspace.ts";
import { GOOGLE_DRIVE_WORKSPACE_ROOT } from "./google-drive-config.ts";

describe("Google Drive app workspace bootstrap", () => {
  it("creates the fixed Grove workspace root", async () => {
    let created: string[] = [];

    await ensureGoogleDriveAppWorkspaceRoot({
      createDirectory: async (path) => {
        created.push(path);
      },
    });

    expect(created).toEqual([GOOGLE_DRIVE_WORKSPACE_ROOT]);
  });

  it("writes a manifest inside the rooted workspace when missing", async () => {
    let writes = new Map<string, string>();

    await ensureGoogleDriveAppWorkspaceManifest({
      stat: async (path) => ({
        exists: false,
        isDirectory: false,
        isFile: false,
        path,
      }),
      writeFile: async (path, value) => {
        writes.set(path, value);
      },
    });

    expect([...writes.keys()]).toEqual([GOOGLE_DRIVE_APP_WORKSPACE_MANIFEST_PATH]);
    expect(JSON.parse(writes.get(GOOGLE_DRIVE_APP_WORKSPACE_MANIFEST_PATH)!)).toEqual({
      kind: "grove.googleDriveWorkspace",
      root: GOOGLE_DRIVE_WORKSPACE_ROOT,
      version: 1,
    });
  });

  it("does not overwrite an existing manifest", async () => {
    let writeCount = 0;

    await ensureGoogleDriveAppWorkspaceManifest({
      stat: async (path) => ({
        exists: true,
        isDirectory: false,
        isFile: true,
        path,
      }),
      writeFile: async () => {
        writeCount += 1;
      },
    });

    expect(writeCount).toBe(0);
  });
});
