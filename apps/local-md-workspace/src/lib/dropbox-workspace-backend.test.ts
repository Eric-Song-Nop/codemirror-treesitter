import { describe, expect, it } from "vite-plus/test";
import type {
  OpendalBrowserOperator,
  OpendalBrowserOperatorConfig,
  OpendalBrowserEntry,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { createDropboxWorkspaceBackend } from "./dropbox-workspace-backend.ts";

describe("Dropbox workspace backend", () => {
  it("coalesces pending writes while keeping same-path writes serialized", async () => {
    let firstWriteStarted = deferred<void>();
    let releaseFirstWrite = deferred<void>();
    let writes: string[] = [];
    let operator = fakeOperator({
      async writeText(_path, value) {
        writes.push(value);
        if (writes.length == 1) {
          firstWriteStarted.resolve();
          await releaseFirstWrite.promise;
        }
      },
    });
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () => operator,
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    let first = backend.writeFile("note.md", "first");
    await firstWriteStarted.promise;
    let second = backend.writeFile("note.md", "second");
    let third = backend.writeFile("note.md", "third");

    expect(writes).toEqual(["first"]);
    releaseFirstWrite.resolve();
    await Promise.all([first, second, third]);

    expect(writes).toEqual(["first", "third"]);
  });

  it("refreshes an expired token and retries once", async () => {
    let createCalls: OpendalBrowserOperatorConfig[] = [];
    let createCount = 0;
    let refreshCount = 0;
    let backend = createDropboxWorkspaceBackend({
      createOperator: async (config) => {
        createCalls.push(config);
        createCount += 1;
        return fakeOperator({
          async readText() {
            if (createCount == 1) throw new Error("expired_access_token");
            return "# ok\n";
          },
        });
      },
      getAccessToken: async () => token("old-token"),
      refreshAccessToken: async () => {
        refreshCount += 1;
        return token("new-token");
      },
      root: "/workspace/",
    });

    await expect(backend.readFile("note.md")).resolves.toBe("# ok\n");

    expect(refreshCount).toBe(1);
    expect(
      createCalls.map((config) => (config.provider == "dropbox" ? config.accessToken : "")),
    ).toEqual(["old-token", "new-token"]);
    expect(createCalls.map((config) => config.root)).toEqual(["workspace", "workspace"]);
  });

  it("builds a Markdown-only tree from Dropbox entries", async () => {
    let entries: OpendalBrowserEntry[] = [
      { isDirectory: false, isFile: true, path: "notes/today.md" },
      { isDirectory: false, isFile: true, path: "notes/tomorrow.txt" },
      { isDirectory: true, isFile: false, path: "notes" },
      { isDirectory: false, isFile: true, path: "root.md" },
    ];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          async list() {
            return entries;
          },
        }),
      getAccessToken: async () => token("token"),
      name: "Dropbox Test",
      refreshAccessToken: async () => token("token"),
    });

    await expect(backend.readTree()).resolves.toMatchObject({
      children: [
        {
          children: [{ kind: "file", name: "today.md", path: "notes/today.md" }],
          kind: "directory",
          name: "notes",
          path: "notes",
        },
        { kind: "file", name: "root.md", path: "root.md" },
      ],
      kind: "directory",
      name: "Dropbox Test",
      path: "",
    });
  });

  it("creates missing parent directories before nested writes", async () => {
    let createdDirectories: string[] = [];
    let writes: string[] = [];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          async createDir(path) {
            createdDirectories.push(path);
          },
          async writeText(path) {
            writes.push(path);
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await backend.createFile("notes/daily/today.md");
    await backend.writeFile("notes/daily/today.md", "# updated\n");

    expect(createdDirectories).toEqual(["notes/daily"]);
    expect(writes).toEqual(["notes/daily/today.md", "notes/daily/today.md"]);
  });

  it("does not create parent directories when the operator cannot create them", async () => {
    let createDirCalls = 0;
    let writes: string[] = [];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          capabilities: () => ({
            nativeCopy: true,
            nativeCreateDir: false,
            nativeDelete: true,
            nativeList: true,
            nativeRead: true,
            nativeRename: true,
            nativeStat: true,
            nativeWrite: true,
          }),
          async createDir() {
            createDirCalls += 1;
          },
          async writeText(path) {
            writes.push(path);
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await backend.writeFile("notes/today.md", "# today\n");

    expect(createDirCalls).toBe(0);
    expect(writes).toEqual(["notes/today.md"]);
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
    }),
    createDir: async () => {},
    delete: async () => {},
    list: async () => [],
    readText: async () => "",
    rename: async () => {},
    stat: async (path) => ({ isDirectory: false, isFile: true, path }),
    writeText: async () => {},
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, reject, resolve };
}
