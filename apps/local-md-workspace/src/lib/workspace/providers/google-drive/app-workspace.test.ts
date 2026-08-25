import { describe, expect, it } from "vite-plus/test";
import {
  GOOGLE_DRIVE_APP_WORKSPACE_MANIFEST_PATH,
  ensureGoogleDriveAppWorkspaceManifest,
  ensureGoogleDriveAppWorkspaceRoot,
} from "./app-workspace.ts";
import { GOOGLE_DRIVE_WORKSPACE_ROOT } from "./config.ts";

describe("Google Drive app workspace bootstrap", () => {
  it("creates the fixed Grove workspace root", async () => {
    let created: string[] = [];

    await ensureGoogleDriveAppWorkspaceRoot({
      entries: {
        create: async (path) => {
          created.push(path);
          return null;
        },
      },
    });

    expect(created).toEqual([`${GOOGLE_DRIVE_WORKSPACE_ROOT}/`]);
  });

  it("writes a manifest inside the rooted workspace when missing", async () => {
    let writes = new Map<string, string>();

    await ensureGoogleDriveAppWorkspaceManifest({
      documentSource: {
        commit: async ({ path, value }) => {
          writes.set(path, value);
          return {
            revision: { kind: "fingerprint", validation: "observed", value: "manifest:1" },
            status: "committed",
          };
        },
        observe: async () => ({ state: "missing" }),
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
      documentSource: {
        commit: async () => {
          writeCount += 1;
          return {
            revision: { kind: "fingerprint", validation: "observed", value: "manifest:2" },
            status: "committed",
          };
        },
        observe: async () => ({
          state: "present",
          value: {
            bytes: new Uint8Array(),
            capture: "observed",
            contentHash: "sha256:existing",
            metadata: {},
            revision: {
              kind: "fingerprint",
              validation: "observed",
              value: "manifest:existing",
            },
            value: "{}",
          },
        }),
      },
    });

    expect(writeCount).toBe(0);
  });
});
