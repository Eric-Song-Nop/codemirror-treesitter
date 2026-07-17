import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createOpendalBrowserOperator } from "./index.ts";

const generatedModuleUrl = `data:text/javascript,${encodeURIComponent(`
export default async function init() {}
export class OpendalBrowserOperator {
  capabilities() {
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
      nativeWriteWithIfNotExists: false
    }
  }
  async createDir() {}
  async delete() {}
  async list() { return [] }
  async readBytes() { throw new Error("generated readBytes called") }
  async readText() { throw new Error("generated readText called") }
  async rename() {}
  async stat(path) { return { isDirectory: false, isFile: true, path } }
  async writeBytes() { throw new Error("generated writeBytes called") }
  async writeText() { throw new Error("generated writeText called") }
}
`)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dropbox browser transport", () => {
  it("reads text and Dropbox revision from the same response", async () => {
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

    await expect(operator.readTextWithMetadata!("notes/note.md")).resolves.toEqual({
      entry: {
        etag: "hash-a",
        isDirectory: false,
        isFile: true,
        lastModified: "2026-07-17T01:02:03Z",
        path: "notes/note.md",
        size: 7,
        version: "rev-a",
      },
      value: "# note\n",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://content.dropboxapi.com/2/files/download");
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer token");
    expect(JSON.parse(requests[0]!.headers.get("Dropbox-API-Arg")!)).toEqual({
      path: "/Grove/notes/note.md",
    });
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

    await operator.writeText("new.md", "# new\n", { ifNotExists: true });
    await operator.writeText("new.md", "# edit\n", { ifVersion: "rev-1" });

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
      operator.writeText("existing.md", "# replacement\n", { ifNotExists: true }),
    ).rejects.toThrow("Dropbox no-clobber conflict: 409 Conflict: path/conflict/file/..");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects traversal before issuing direct Dropbox requests", async () => {
    vi.stubGlobal("fetch", vi.fn());
    let operator = await dropboxOperator();

    await expect(
      operator.writeText("../outside.md", "# outside\n", { ifNotExists: true }),
    ).rejects.toThrow("paths cannot include . or .. segments");
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function dropboxOperator() {
  return createOpendalBrowserOperator(
    { accessToken: "token", provider: "dropbox", root: "/Grove/" },
    { generatedModuleUrl },
  );
}
