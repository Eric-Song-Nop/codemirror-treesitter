import { describe, expect, it } from "vite-plus/test";
import type {
  OpendalBrowserOperator,
  OpendalBrowserOperatorConfig,
  OpendalBrowserWriteOptions,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { createGoogleDriveWorkspaceBackend } from "./google-drive-workspace-backend.ts";

describe("Google Drive workspace backend", () => {
  it("uses the shared OpenDAL backend without conditional writes", async () => {
    let createCalls: OpendalBrowserOperatorConfig[] = [];
    let writes: Array<{ options?: OpendalBrowserWriteOptions; value: string }> = [];
    let backend = createGoogleDriveWorkspaceBackend({
      createOperator: async (config) => {
        createCalls.push(config);
        return fakeOperator({
          async stat(path) {
            return {
              isDirectory: false,
              isFile: true,
              lastModified: "2026-06-15T10:00:00Z",
              path,
              size: 10,
            };
          },
          async writeText(path, value, options) {
            writes.push({ options, value });
            return {
              isDirectory: false,
              isFile: true,
              lastModified: "2026-06-15T10:00:01Z",
              path,
              size: value.length,
            };
          },
        });
      },
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
      root: "/notes/",
    });

    await expect(backend.stat!("daily.md")).resolves.toMatchObject({
      exists: true,
      mtime: Date.parse("2026-06-15T10:00:00Z"),
      path: "daily.md",
      size: 10,
    });
    await expect(backend.writeFile("daily.md", "# update\n")).resolves.toBeUndefined();

    expect(createCalls).toEqual([
      {
        accessToken: "token",
        provider: "gdrive",
        root: "notes",
      },
    ]);
    expect(writes).toEqual([{ options: undefined, value: "# update\n" }]);
  });
});

function token(accessToken: string) {
  return {
    accessToken,
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
}

function fakeOperator(overrides: Partial<OpendalBrowserOperator>): OpendalBrowserOperator {
  return {
    capabilities: () => ({
      nativeCopy: true,
      nativeCreateDir: true,
      nativeDelete: true,
      nativeList: true,
      nativeRead: true,
      nativeRename: true,
      nativeStat: true,
      nativeWrite: true,
      nativeWriteWithIfMatch: false,
    }),
    createDir: async () => {},
    delete: async () => {},
    list: async () => [],
    readBytes: async () => new Uint8Array(),
    readText: async () => "",
    rename: async () => {},
    stat: async (path) => ({ isDirectory: false, isFile: true, path }),
    writeBytes: async (path) => ({ isDirectory: false, isFile: true, path }),
    writeText: async (path) => ({ isDirectory: false, isFile: true, path }),
    ...overrides,
  };
}
