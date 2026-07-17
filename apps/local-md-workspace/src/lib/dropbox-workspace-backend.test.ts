import { describe, expect, it } from "vite-plus/test";
import type {
  OpendalBrowserOperator,
  OpendalBrowserOperatorConfig,
  OpendalBrowserEntry,
  OpendalBrowserWriteOptions,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { createDropboxWorkspaceBackend } from "./dropbox-workspace-backend.ts";
import { documentSourceDocumentIdInput, documentSourceRef } from "./workspace/source-identity.ts";

describe("Dropbox workspace backend", () => {
  it("includes the Dropbox account identity in workspace source ids", () => {
    let first = createDropboxWorkspaceBackend({
      getAccessToken: async () => token("token-a"),
      identity: { id: "dbid:account-a", kind: "account" },
      refreshAccessToken: async () => token("token-a"),
      root: "Grove",
    });
    let second = createDropboxWorkspaceBackend({
      getAccessToken: async () => token("token-b"),
      identity: { id: "dbid:account-b", kind: "account" },
      refreshAccessToken: async () => token("token-b"),
      root: "Grove",
    });

    expect(first.id).toBe("dropbox:account:dbid%3Aaccount-a:Grove");
    expect(second.id).toBe("dropbox:account:dbid%3Aaccount-b:Grove");
    expect(first.id).not.toBe(second.id);
    expect(documentSourceDocumentIdInput(documentSourceRef(first, "notes/today.md"))).not.toBe(
      documentSourceDocumentIdInput(documentSourceRef(second, "notes/today.md")),
    );
  });

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

  it("creates files with an atomic no-clobber write", async () => {
    let writes: Array<{ options?: OpendalBrowserWriteOptions; path: string; value: string }> = [];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          capabilities: () => ({
            ...fakeCapabilities(),
            nativeWriteWithIfNotExists: true,
            nativeWriteWithVersion: true,
          }),
          async writeText(path, value, options) {
            writes.push({ options, path, value });
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await expect(backend.createFile("new.md")).resolves.toBe("new.md");

    expect(writes).toEqual([
      {
        options: { ifNotExists: true },
        path: "new.md",
        value: "# new\n",
      },
    ]);
  });

  it("fails closed instead of overwriting when no-clobber is unsupported", async () => {
    let writes = 0;
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          async writeText() {
            writes += 1;
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await expect(backend.createFile("existing.md")).rejects.toThrow(
      "does not support atomic no-clobber writes",
    );
    expect(writes).toBe(0);
  });

  it("reads content and revision from one snapshot and writes with Dropbox revision CAS", async () => {
    let reads: string[] = [];
    let statCalls = 0;
    let writes: Array<{ options?: OpendalBrowserWriteOptions; value: string }> = [];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          capabilities: () => ({
            ...fakeCapabilities(),
            nativeWriteWithIfNotExists: true,
            nativeWriteWithVersion: true,
          }),
          async readTextWithMetadata(path) {
            reads.push(path);
            return {
              entry: { isDirectory: false, isFile: true, path, version: "rev-a" },
              value: "# source\n",
            };
          },
          async stat(path) {
            statCalls += 1;
            return fileEntry(path);
          },
          async writeText(path, value, options) {
            writes.push({ options, value });
            return { isDirectory: false, isFile: true, path, version: "rev-b" };
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await expect(backend.readFile("note.md")).resolves.toBe("# source\n");
    await expect(backend.writeFile("note.md", "# update\n")).resolves.toEqual({
      revision: { version: "rev-b" },
    });

    expect(reads).toEqual(["note.md"]);
    expect(statCalls).toBe(0);
    expect(writes).toEqual([{ options: { ifVersion: "rev-a" }, value: "# update\n" }]);
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
      { isDirectory: true, isFile: false, path: ".livemd" },
      { isDirectory: false, isFile: true, path: ".livemd/manifest.json" },
      { isDirectory: false, isFile: true, path: "notes/tomorrow.txt" },
      { isDirectory: true, isFile: false, path: "notes" },
      { isDirectory: true, isFile: false, path: "drafts" },
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
          children: [],
          childrenLoaded: false,
          kind: "directory",
          name: "drafts",
          path: "drafts",
        },
        {
          children: [],
          childrenLoaded: false,
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

  it("keeps .b64 bytes compatible with base64 text files", async () => {
    let files = new Map<string, string | Uint8Array>();
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () => fakeMapOperator(files),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await backend.writeBytes!("state/doc.snapshot.b64", new Uint8Array([1, 2, 3, 255]));

    expect(files.get("state/doc.snapshot.b64")).toBe("AQID/w==");
    await expect(backend.readBytes!("state/doc.snapshot.b64")).resolves.toEqual(
      new Uint8Array([1, 2, 3, 255]),
    );
    await expect(backend.stat!("state/missing.snapshot.b64")).resolves.toMatchObject({
      exists: false,
      path: "state/missing.snapshot.b64",
    });
    expect([...files.keys()].filter((path) => path.includes(".next."))).toEqual([]);
  });

  it("stores ordinary bytes through OpenDAL binary IO", async () => {
    let files = new Map<string, string | Uint8Array>();
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () => fakeMapOperator(files),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });
    let pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);

    await backend.writeBytes!("images/pixel.png", pngBytes);

    expect(files.get("images/pixel.png")).toEqual(pngBytes);
    await expect(backend.readBytes!("images/pixel.png")).resolves.toEqual(pngBytes);
    expect(files.get("images/pixel.png")).not.toBe("iVBORwD/");
  });

  it("creates image assets as sibling binary files", async () => {
    let files = new Map<string, string | Uint8Array>([
      ["notes/assets/photo.png", new Uint8Array([1])],
    ]);
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () => fakeMapOperator(files),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });
    let pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10]);
    let imageFile = new File([pngBytes], "Photo.PNG", { type: "image/png" });

    let asset = await backend.createImageAsset!("notes/today.md", imageFile);

    expect(asset).toMatchObject({
      file: imageFile,
      markdownReference: "assets/photo-2.png",
      name: "photo-2.png",
      path: "notes/assets/photo-2.png",
    });
    expect(files.get("notes/assets/photo-2.png")).toEqual(pngBytes);
    await expect(backend.readBytes!("notes/assets/photo-2.png")).resolves.toEqual(pngBytes);
  });

  it("treats Dropbox 409 path-not-found responses as missing entries", async () => {
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          async stat() {
            throw new Error("Dropbox API error 409 Conflict: path/not_found");
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await expect(backend.stat!("missing.md")).resolves.toMatchObject({
      exists: false,
      path: "missing.md",
    });
  });

  it("creates missing parent directories before nested writes", async () => {
    let createdDirectories: string[] = [];
    let writes: string[] = [];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          capabilities: () => ({
            ...fakeCapabilities(),
            nativeWriteWithIfNotExists: true,
            nativeWriteWithVersion: true,
          }),
          async createDir(path) {
            createdDirectories.push(path);
          },
          async stat() {
            throw new Error("not_found");
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

    expect(createdDirectories).toEqual(["notes", "notes/daily"]);
    expect(writes).toEqual(["notes/daily/today.md", "notes/daily/today.md"]);
  });

  it("skips createDir for existing parent directories before writes", async () => {
    let createdDirectories: string[] = [];
    let statPaths: string[] = [];
    let writes: string[] = [];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          async createDir(path) {
            createdDirectories.push(path);
          },
          async stat(path) {
            statPaths.push(path);
            if (path == "notes") return directoryEntry(path);
            throw new Error("not_found");
          },
          async writeText(path) {
            writes.push(path);
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await backend.writeFile("notes/today.md", "# today\n");

    expect(statPaths).toEqual(["notes"]);
    expect(createdDirectories).toEqual([]);
    expect(writes).toEqual(["notes/today.md"]);
  });

  it("creates only missing nested parent directories before writes", async () => {
    let createdDirectories: string[] = [];
    let statPaths: string[] = [];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          async createDir(path) {
            createdDirectories.push(path);
          },
          async stat(path) {
            statPaths.push(path);
            if (path == "notes") return directoryEntry(path);
            throw new Error("not_found");
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await backend.writeFile("notes/daily/2026/today.md", "# today\n");

    expect(statPaths).toEqual(["notes", "notes/daily", "notes/daily/2026"]);
    expect(createdDirectories).toEqual(["notes/daily", "notes/daily/2026"]);
  });

  it("rejects writes when a parent path is a file", async () => {
    let createdDirectories: string[] = [];
    let writes: string[] = [];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          async createDir(path) {
            createdDirectories.push(path);
          },
          async stat(path) {
            if (path == "notes") return fileEntry(path);
            throw new Error("not_found");
          },
          async writeText(path) {
            writes.push(path);
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await expect(backend.writeFile("notes/today.md", "# today\n")).rejects.toThrow(
      "notes exists and is not a folder.",
    );
    expect(createdDirectories).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("does not recreate existing directories from explicit createDirectory calls", async () => {
    let createdDirectories: string[] = [];
    let statPaths: string[] = [];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          async createDir(path) {
            createdDirectories.push(path);
          },
          async stat(path) {
            statPaths.push(path);
            if (path == "notes") return directoryEntry(path);
            throw new Error("not_found");
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await backend.createDirectory!("notes");
    await backend.createDirectory!("notes");

    expect(statPaths).toEqual(["notes"]);
    expect(createdDirectories).toEqual([]);
  });

  it("creates folder paths from trailing-slash create targets", async () => {
    let createdDirectories: string[] = [];
    let writes: string[] = [];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          async createDir(path) {
            createdDirectories.push(path);
          },
          async stat() {
            throw new Error("not_found");
          },
          async writeText(path) {
            writes.push(path);
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await expect(backend.createFile("notes/daily/")).resolves.toBeNull();

    expect(createdDirectories).toEqual(["notes", "notes/daily"]);
    expect(writes).toEqual([]);
  });

  it("deletes folder paths", async () => {
    let deletes: string[] = [];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          async delete(path) {
            deletes.push(path);
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    expect(backend.deleteDirectory).toBeDefined();
    await backend.deleteDirectory!("notes/daily/");

    expect(deletes).toEqual(["notes/daily"]);
  });

  it("renames folder paths", async () => {
    let renames: Array<[string, string]> = [];
    let backend = createDropboxWorkspaceBackend({
      createOperator: async () =>
        fakeOperator({
          async rename(from, to) {
            renames.push([from, to]);
          },
          async stat(path) {
            if (path == "notes") return directoryEntry(path);
            throw new Error("not_found");
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    expect(backend.renameDirectory).toBeDefined();
    await expect(backend.renameDirectory!("notes/daily/", "archive")).resolves.toBe(
      "notes/archive",
    );

    expect(renames).toEqual([["notes/daily", "notes/archive"]]);
  });

  it("does not create parent directories when the operator cannot create them", async () => {
    let createDirCalls = 0;
    let statCalls = 0;
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
            nativeWriteWithIfMatch: false,
          }),
          async createDir() {
            createDirCalls += 1;
          },
          async stat() {
            statCalls += 1;
            throw new Error("not_found");
          },
          async writeText(path) {
            writes.push(path);
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await backend.writeFile("notes/today.md", "# today\n");

    expect(statCalls).toBe(0);
    expect(createDirCalls).toBe(0);
    expect(writes).toEqual(["notes/today.md"]);
  });

  it("rejects explicit createDirectory when the operator cannot create folders", async () => {
    let createDirCalls = 0;
    let statCalls = 0;
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
            nativeWriteWithIfMatch: false,
          }),
          async createDir() {
            createDirCalls += 1;
          },
          async stat() {
            statCalls += 1;
            throw new Error("not_found");
          },
        }),
      getAccessToken: async () => token("token"),
      refreshAccessToken: async () => token("token"),
    });

    await expect(backend.createDirectory!("notes")).rejects.toThrow(
      "OpenDAL backend does not support folder creation.",
    );
    expect(statCalls).toBe(0);
    expect(createDirCalls).toBe(0);
  });
});

function token(accessToken: string) {
  return {
    accessToken,
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
}

function fakeMapOperator(files: Map<string, string | Uint8Array>, operations: string[] = []) {
  return fakeOperator({
    async createDir(path) {
      operations.push(`createDir ${path}`);
    },
    async delete(path) {
      operations.push(`delete ${path}`);
      if (!files.delete(path)) throw new Error("not_found");
    },
    async readText(path) {
      let value = files.get(path);
      if (value == null) throw new Error("not_found");
      if (typeof value != "string") throw new Error("not_text");
      return value;
    },
    async readBytes(path) {
      let value = files.get(path);
      if (value == null) throw new Error("not_found");
      if (typeof value == "string") return new TextEncoder().encode(value);
      return new Uint8Array(value);
    },
    async rename(from, to) {
      operations.push(`rename ${from} ${to}`);
      let value = files.get(from);
      if (value == null) throw new Error("not_found");
      files.delete(from);
      files.set(to, value);
    },
    async stat(path) {
      let value = files.get(path);
      if (value == null) throw new Error("not_found");
      return {
        isDirectory: false,
        isFile: true,
        path,
        size: typeof value == "string" ? value.length : value.byteLength,
      };
    },
    async writeBytes(path, bytes) {
      operations.push(`writeBytes ${path}`);
      files.set(path, new Uint8Array(bytes));
    },
    async writeText(path, value) {
      operations.push(`write ${path}`);
      files.set(path, value);
    },
  });
}

function fakeOperator(overrides: Partial<OpendalBrowserOperator>): OpendalBrowserOperator {
  return {
    capabilities: fakeCapabilities,
    createDir: async () => {},
    delete: async () => {},
    list: async () => [],
    readBytes: async () => new Uint8Array(),
    readText: async () => "",
    rename: async () => {},
    stat: async (path) => ({ isDirectory: false, isFile: true, path }),
    writeBytes: async () => {},
    writeText: async () => {},
    ...overrides,
  };
}

function fakeCapabilities() {
  return {
    nativeCopy: true,
    nativeCreateDir: true,
    nativeDelete: true,
    nativeList: true,
    nativeRead: true,
    nativeRename: true,
    nativeStat: true,
    nativeWrite: true,
    nativeWriteWithIfMatch: false,
    nativeWriteWithIfNotExists: false,
    nativeWriteWithVersion: false,
  };
}

function directoryEntry(path: string): OpendalBrowserEntry {
  return { isDirectory: true, isFile: false, path };
}

function fileEntry(path: string): OpendalBrowserEntry {
  return { isDirectory: false, isFile: true, path };
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
