import { describe, expect, it } from "vite-plus/test";
import type {
  OpendalBrowserOperator,
  OpendalBrowserOperatorConfig,
  OpendalBrowserWriteOptions,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { createOneDriveWorkspaceBackend } from "./onedrive-workspace-backend.ts";

describe("OneDrive workspace backend", () => {
  it("uses the last observed ETag as an OpenDAL conditional write", async () => {
    let createCalls: OpendalBrowserOperatorConfig[] = [];
    let writes: Array<{ options?: OpendalBrowserWriteOptions; value: string }> = [];
    let etag = '"first"';
    let backend = createOneDriveWorkspaceBackend({
      createOperator: async (config) => {
        createCalls.push(config);
        return fakeOperator({
          async readText() {
            return "# source\n";
          },
          async stat(path) {
            return { etag, isDirectory: false, isFile: true, path };
          },
          async writeText(path, value, options) {
            writes.push({ options, value });
            etag = '"second"';
            return { etag, isDirectory: false, isFile: true, path };
          },
        });
      },
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
      root: "/notes/",
    });

    await expect(backend.readFile("daily.md")).resolves.toBe("# source\n");
    await expect(backend.writeFile("daily.md", "# merged\n")).resolves.toEqual({
      revision: { etag: '"second"' },
    });
    await backend.writeFile("daily.md", "# merged again\n");

    expect(createCalls).toEqual([
      {
        accessToken: "token",
        provider: "onedrive",
        root: "notes",
      },
    ]);
    expect(writes).toEqual([
      { options: { ifMatch: '"first"' }, value: "# merged\n" },
      { options: { ifMatch: '"second"' }, value: "# merged again\n" },
    ]);
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
      nativeWriteWithIfMatch: true,
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
