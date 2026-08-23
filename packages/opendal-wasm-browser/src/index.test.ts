import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { openOpendalBrowserOperator, OpendalBrowserError } from "./index.ts";

const exactGeneratedModuleUrl = `data:text/javascript,${encodeURIComponent(`
export default async function init() {}
const files = new Map([["source.md", new Uint8Array([35, 32, 65, 10])]])
class Operator {
  constructor(config = {}) { this.kind = config.provider ?? "browser-local" }
  capabilities() {
    return {
      nativeCopy: false,
      nativeCreateDir: true,
      nativeDelete: true,
      nativeDeleteWithRecursive: this.kind === "browser-local",
      nativeList: true,
      nativeListWithRecursive: false,
      nativeRead: true,
      nativeRename: false,
      nativeStat: true,
      nativeWrite: true,
      nativeWriteWithIfMatch: false,
      nativeWriteWithIfNotExists: false
    }
  }
  async createDir() {}
  async delete(path) { files.delete(path.endsWith("/") ? path.slice(0, -1) : path) }
  async list(prefix) {
    return [...files.keys()]
      .filter(path => path.startsWith(prefix))
      .map(path => ({ isDirectory: false, isFile: true, path }))
  }
  async readBytes(path) {
    let value = files.get(path)
    if (!value) throw new Error("NotFound: " + path)
    return value
  }
  async readBytesWithMetadata(path) {
    let value = await this.readBytes(path)
    return this.kind === "gdrive"
      ? { bytes: value }
      : {
          bytes: value,
          entry: {
            isDirectory: false,
            isFile: true,
            lastModified: "2026-08-23T01:02:03Z",
            path,
            size: value.byteLength
          }
        }
  }
  async rename() { throw new Error("native rename must not be used") }
  async stat(path) {
    let key = path.endsWith("/") ? path.slice(0, -1) : path
    let value = files.get(key)
    if (!value) throw new Error("NotFound: " + path)
    return { isDirectory: false, isFile: true, path, size: value.byteLength }
  }
  async writeBytes(path, bytes) {
    if (globalThis.__opendalBrowserLocalWriteError) {
      throw new Error(globalThis.__opendalBrowserLocalWriteError)
    }
    files.set(path, new Uint8Array(bytes))
    return {
      isDirectory: false,
      isFile: true,
      lastModified: "2026-08-23T01:02:04Z",
      path,
      size: bytes.byteLength
    }
  }
}
export class OpendalBrowserOperator extends Operator {}
export function openBrowserLocalOperator() { return new Operator() }
`)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dropbox browser transport", () => {
  it("reads bytes and Dropbox revision from the same response", async () => {
    let requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response("# note\n", {
          headers: {
            "Dropbox-API-Result": JSON.stringify({
              content_hash: "hash-a",
              rev: "rev-a",
              server_modified: "2026-07-17T01:02:03Z",
              size: 7,
            }),
          },
        });
      }),
    );
    let operator = await dropboxOperator();

    await expect(operator.read("notes/note.md")).resolves.toEqual({
      bytes: new TextEncoder().encode("# note\n"),
      metadata: {
        etag: "hash-a",
        kind: "file",
        lastModified: "2026-07-17T01:02:03Z",
        path: "notes/note.md",
        size: 7,
        version: "rev-a",
      },
      metadataBinding: "same-read",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://content.dropboxapi.com/2/files/download");
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer token");
    expect(JSON.parse(requests[0]!.headers.get("Dropbox-API-Arg")!)).toEqual({
      path: "/Grove/notes/note.md",
    });
  });

  it("rejects a Dropbox download that omits revision metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("# note\n", {
            headers: {
              "Dropbox-API-Result": JSON.stringify({
                content_hash: "hash-a",
                server_modified: "2026-07-17T01:02:03Z",
                size: 7,
              }),
            },
          }),
      ),
    );
    let operator = await dropboxOperator();

    await expect(operator.read("notes/note.md")).rejects.toThrow(
      "Dropbox download response did not include file revision metadata.",
    );
  });

  it("maps no-clobber and revision CAS to atomic Dropbox upload modes", async () => {
    let uploadArgs: unknown[] = [];
    let uploadBodies: string[] = [];
    let uploadRequests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        let request = new Request(input, init);
        uploadRequests.push(request);
        uploadArgs.push(JSON.parse(request.headers.get("Dropbox-API-Arg")!));
        uploadBodies.push(await request.clone().text());
        return Response.json({
          content_hash: `hash-${uploadArgs.length}`,
          rev: `rev-${uploadArgs.length}`,
          server_modified: "2026-07-17T01:02:03Z",
          size: 7,
        });
      }),
    );
    let operator = await dropboxOperator();

    await operator.write({
      bytes: new TextEncoder().encode("# new\n"),
      condition: { kind: "if-not-exists" },
      path: "new.md",
    });
    await operator.write({
      bytes: new TextEncoder().encode("# edit\n"),
      condition: { kind: "if-version", version: "rev-1" },
      path: "new.md",
    });

    expect(uploadArgs).toEqual([
      {
        autorename: false,
        mode: "add",
        mute: true,
        path: "/Grove/new.md",
        strict_conflict: true,
      },
      {
        autorename: false,
        mode: { ".tag": "update", update: "rev-1" },
        mute: true,
        path: "/Grove/new.md",
        strict_conflict: true,
      },
    ]);
    expect(uploadBodies).toEqual(["# new\n", "# edit\n"]);
    expect(uploadRequests.every((request) => request.method == "POST")).toBe(true);
    expect(
      uploadRequests.every((request) => request.headers.get("Authorization") == "Bearer token"),
    ).toBe(true);
    expect(
      uploadRequests.every(
        (request) => request.headers.get("Content-Type") == "application/octet-stream",
      ),
    ).toBe(true);
  });

  it("surfaces Dropbox conflict responses without falling back to overwrite", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error_summary: "path/conflict/file/.." },
          { status: 409, statusText: "Conflict" },
        ),
      ),
    );
    let operator = await dropboxOperator();

    await expect(
      operator.write({
        bytes: new TextEncoder().encode("# replacement\n"),
        condition: { kind: "if-not-exists" },
        path: "existing.md",
      }),
    ).rejects.toThrow("Dropbox no-clobber conflict: 409 Conflict: path/conflict/file/..");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects traversal before issuing direct Dropbox requests", async () => {
    vi.stubGlobal("fetch", vi.fn());
    let operator = await dropboxOperator();

    await expect(
      operator.write({
        bytes: new TextEncoder().encode("# outside\n"),
        condition: { kind: "if-not-exists" },
        path: "../outside.md",
      }),
    ).rejects.toThrow("OpenDAL paths cannot include . or .. segments");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("exact browser operator", () => {
  it("returns Dropbox bytes and version metadata from one response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([0, 255, 17]), {
            headers: {
              "Dropbox-API-Result": JSON.stringify({
                content_hash: "hash-binary",
                rev: "rev-binary",
                size: 3,
              }),
            },
          }),
      ),
    );
    let operator = await openOpendalBrowserOperator(
      { accessToken: "token", kind: "dropbox", root: "/Grove/" },
      { generatedModuleUrl: exactGeneratedModuleUrl },
    );

    await expect(operator.read("binary.dat")).resolves.toEqual({
      bytes: new Uint8Array([0, 255, 17]),
      metadata: {
        etag: "hash-binary",
        kind: "file",
        lastModified: undefined,
        path: "binary.dat",
        size: 3,
        version: "rev-binary",
      },
      metadataBinding: "same-read",
    });
  });

  it("does not attach an independent stat when read metadata is absent", async () => {
    let operator = await openOpendalBrowserOperator(
      { accessToken: "token", kind: "gdrive" },
      { generatedModuleUrl: exactGeneratedModuleUrl },
    );

    await expect(operator.read("source.md")).resolves.toEqual({
      bytes: new Uint8Array([35, 32, 65, 10]),
      metadataBinding: "none",
    });
  });

  it("reports BrowserLocal conditions as observed and emulates file rename", async () => {
    let operator = await openOpendalBrowserOperator(
      { kind: "browser-local", rootHandle: {} as FileSystemDirectoryHandle },
      { generatedModuleUrl: exactGeneratedModuleUrl },
    );

    expect(operator.info.capabilities.writeConditions).toEqual({
      ifMatch: false,
      ifNotExists: false,
      ifVersion: false,
    });
    expect(operator.info.capabilities.rename.file).toBe("copy-delete");
    await expect(
      operator.rename({ from: "source.md", kind: "file", to: "renamed.md" }),
    ).resolves.toEqual({ status: "applied" });
    await expect(operator.read("renamed.md")).resolves.toMatchObject({
      bytes: new Uint8Array([35, 32, 65, 10]),
    });
    await expect(operator.read("source.md")).rejects.toMatchObject({
      code: "not-found",
    } satisfies Partial<OpendalBrowserError>);
  });

  it("rejects unsupported conditions before invoking a write", async () => {
    let operator = await openOpendalBrowserOperator(
      { accessToken: "token", kind: "gdrive" },
      { generatedModuleUrl: exactGeneratedModuleUrl },
    );

    await expect(
      operator.write({
        bytes: new Uint8Array([1]),
        condition: { etag: "etag-1", kind: "if-match" },
        path: "source.md",
      }),
    ).rejects.toMatchObject({
      code: "unsupported",
      mutationOutcome: "not-applied",
    } satisfies Partial<OpendalBrowserError>);
  });

  it("treats BrowserLocal write failures as indeterminate after the native call starts", async () => {
    vi.stubGlobal("__opendalBrowserLocalWriteError", "Permission denied while closing stream");
    let operator = await openOpendalBrowserOperator(
      { kind: "browser-local", rootHandle: {} as FileSystemDirectoryHandle },
      { generatedModuleUrl: exactGeneratedModuleUrl },
    );

    await expect(
      operator.write({ bytes: new Uint8Array([1]), path: "source.md" }),
    ).rejects.toMatchObject({
      code: "permission-denied",
      mutationOutcome: "unknown",
      reconcilePaths: ["source.md"],
    } satisfies Partial<OpendalBrowserError>);
  });
});

async function dropboxOperator() {
  return openOpendalBrowserOperator(
    { accessToken: "token", kind: "dropbox", root: "/Grove/" },
    { generatedModuleUrl: exactGeneratedModuleUrl },
  );
}
