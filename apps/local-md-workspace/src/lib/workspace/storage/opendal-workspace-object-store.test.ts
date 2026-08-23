import {
  OpendalBrowserError,
  type OpendalExactBrowserOperator,
  type OpendalMetadata,
  type OpendalOperatorInfo,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { StaticOpendalOperatorHost } from "./opendal-operator-host.ts";
import {
  observedFingerprint,
  OpendalWorkspaceObjectStore,
  sha256ContentHash,
} from "./opendal-workspace-object-store.ts";
import { BrowserWorkspacePathLock, expandLockIntents } from "./workspace-path-lock.ts";

const encoder = new TextEncoder();

describe("OpendalWorkspaceObjectStore", () => {
  it("selects a response-bound provider version as an atomic revision", async () => {
    let operator = fakeOperator({
      info: operatorInfo({ ifVersion: true }),
      read: async (path) => ({
        bytes: encoder.encode("R1"),
        metadata: fileMetadata(path, { version: "v1" }),
        metadataBinding: "same-read",
      }),
    });
    let store = createStore(operator);

    await expect(store.read("note.md")).resolves.toMatchObject({
      state: "present",
      value: {
        capture: "bound",
        contentHash: "sha256:p5E2b29iASVO3KyexyAXsS2KaVE7Xh4poppASP-xbic",
        revision: { kind: "version", validation: "atomic", value: "v1" },
      },
    });
  });

  it("uses stat-read-stat without fabricating a same-read binding", async () => {
    let stats = [
      fileMetadata("note.md", { lastModified: "2026-08-23T00:00:00Z", size: 2 }),
      fileMetadata("note.md", { lastModified: "2026-08-23T00:00:00Z", size: 2 }),
    ];
    let read = vi.fn(async () => ({
      bytes: encoder.encode("R1"),
      metadataBinding: "none" as const,
    }));
    let operator = fakeOperator({
      read,
      stat: async () => stats.shift()!,
    });
    let store = createStore(operator);

    let observation = await store.read("note.md");

    expect(read).toHaveBeenCalledTimes(2);
    expect(observation).toMatchObject({
      state: "present",
      value: {
        capture: "observed",
        revision: { kind: "fingerprint", validation: "observed" },
      },
    });
  });

  it("retries a changed metadata sandwich and exhausts as unavailable", async () => {
    let revision = 0;
    let operator = fakeOperator({
      read: async () => ({ bytes: encoder.encode("value"), metadataBinding: "none" }),
      stat: async () => fileMetadata("note.md", { version: `v${revision++}` }),
    });
    let store = createStore(operator, { captureAttempts: 2 });

    await expect(store.read("note.md")).resolves.toMatchObject({
      error: { code: "temporary", retryable: true },
      state: "unavailable",
    });
  });

  it("distinguishes missing and unavailable observations", async () => {
    let missing = createStore(
      fakeOperator({ read: async () => Promise.reject(opendalError("not-found", "read")) }),
    );
    let unavailable = createStore(
      fakeOperator({
        read: async () => Promise.reject(opendalError("permission-denied", "read")),
      }),
    );

    await expect(missing.read("gone.md")).resolves.toEqual({ state: "missing" });
    await expect(unavailable.read("blocked.md")).resolves.toMatchObject({
      error: { code: "permission-denied" },
      state: "unavailable",
    });
  });

  it("maps an atomic revision to one conditional write and returns its next version", async () => {
    let writes: unknown[] = [];
    let operator = fakeOperator({
      info: operatorInfo({ ifVersion: true }),
      write: async (request) => {
        writes.push(request);
        return {
          metadata: fileMetadata(request.path, { version: "v2" }),
          metadataBinding: "write-response",
          status: "applied",
        };
      },
    });
    let store = createStore(operator);

    await expect(
      store.commit({
        bytes: encoder.encode("R2"),
        condition: {
          kind: "if-unchanged",
          revision: { kind: "version", validation: "atomic", value: "v1" },
        },
        path: "note.md",
      }),
    ).resolves.toEqual({
      revision: { kind: "version", validation: "atomic", value: "v2" },
      status: "committed",
    });
    expect(writes).toEqual([
      {
        bytes: encoder.encode("R2"),
        condition: { kind: "if-version", version: "v1" },
        path: "note.md",
      },
    ]);
  });

  it("detects an observed conflict before writing", async () => {
    let current = encoder.encode("R1");
    let write = vi.fn();
    let operator = fakeOperator({
      read: async (path) => ({
        bytes: current,
        metadata: fileMetadata(path, { lastModified: "2026-08-23T00:00:00Z" }),
        metadataBinding: "same-read",
      }),
      write,
    });
    let store = createStore(operator);
    let baseline = await presentRead(store, "note.md");
    current = encoder.encode("R2");

    await expect(
      store.commit({
        bytes: encoder.encode("ours"),
        condition: { kind: "if-unchanged", revision: baseline.revision },
        path: "note.md",
      }),
    ).resolves.toMatchObject({ status: "conflict" });
    expect(write).not.toHaveBeenCalled();
  });

  it("verifies an observed write by reading it back", async () => {
    let current = encoder.encode("R1");
    let operator = fakeOperator({
      read: async (path) => ({
        bytes: current,
        metadata: fileMetadata(path, {
          lastModified: current[0] == 82 && current[1] == 49 ? "t1" : "t2",
          size: current.byteLength,
        }),
        metadataBinding: "same-read",
      }),
      write: async (request) => {
        current = Uint8Array.from(request.bytes);
        return { metadataBinding: "none", status: "applied" };
      },
    });
    let store = createStore(operator);
    let baseline = await presentRead(store, "note.md");

    await expect(
      store.commit({
        bytes: encoder.encode("R2"),
        condition: { kind: "if-unchanged", revision: baseline.revision },
        path: "note.md",
      }),
    ).resolves.toMatchObject({
      revision: { kind: "fingerprint", validation: "observed" },
      status: "committed",
    });
  });

  it("returns unknown when a write cannot be authoritatively read back", async () => {
    let reads = 0;
    let operator = fakeOperator({
      read: async (path) => {
        reads++;
        if (reads <= 2) {
          return {
            bytes: encoder.encode("R1"),
            metadata: fileMetadata(path),
            metadataBinding: "same-read",
          };
        }
        throw opendalError("temporary", "read");
      },
      write: async () => ({ metadataBinding: "none", status: "applied" }),
    });
    let store = createStore(operator);
    let baseline = await presentRead(store, "note.md");

    await expect(
      store.commit({
        bytes: encoder.encode("R2"),
        condition: { kind: "if-unchanged", revision: baseline.revision },
        path: "note.md",
      }),
    ).resolves.toEqual({ reconcilePaths: ["note.md"], status: "unknown" });
  });

  it("preserves an indeterminate operator write as an unknown commit", async () => {
    let operator = fakeOperator({
      write: async () => {
        throw new OpendalBrowserError({
          code: "permission-denied",
          message: "stream close failed",
          mutationOutcome: "unknown",
          operation: "write",
          path: "note.md",
          reconcilePaths: ["note.md"],
        });
      },
    });

    await expect(
      createStore(operator).commit({
        bytes: encoder.encode("R2"),
        condition: { kind: "unconditional" },
        path: "note.md",
      }),
    ).resolves.toEqual({ reconcilePaths: ["note.md"], status: "unknown" });
  });

  it("preserves partial move phases for authoritative reconciliation", async () => {
    let operator = fakeOperator({
      rename: async () => ({
        phase: "source-remove",
        reconcilePaths: ["note.md", "renamed.md"],
        status: "partial",
      }),
      stat: async (path) => {
        if (path == "renamed.md") throw opendalError("not-found", "stat");
        return fileMetadata(path);
      },
    });

    await expect(
      createStore(operator).move({
        from: "note.md",
        kind: "file",
        sourceCondition: { kind: "unconditional" },
        targetCondition: { kind: "if-absent" },
        to: "renamed.md",
      }),
    ).resolves.toEqual({
      phase: "source-remove",
      reconcilePaths: ["note.md", "renamed.md"],
      status: "partial",
    });
  });

  it("preserves list metadata without promoting it to a revision", async () => {
    let operator = fakeOperator({
      list: async () => [
        fileMetadata("note.md", {
          etag: "etag-1",
          lastModified: "2026-08-23T01:00:00Z",
          size: 17,
          version: "version-1",
        }),
      ],
    });

    await expect(createStore(operator).listDirectory("")).resolves.toEqual([
      {
        kind: "file",
        metadata: {
          etag: "etag-1",
          lastModified: "2026-08-23T01:00:00Z",
          size: 17,
          version: "version-1",
        },
        path: "note.md",
      },
    ]);
  });

  it("treats unconditional directory creation as idempotent", async () => {
    let operator = fakeOperator({
      createDirectory: async () => {
        throw opendalError("already-exists", "create-directory");
      },
    });

    await expect(
      createStore(operator).createDirectory("assets", { kind: "unconditional" }),
    ).resolves.toEqual({ status: "applied" });
    await expect(
      createStore(operator).createDirectory("assets", { kind: "if-absent" }),
    ).resolves.toMatchObject({ reason: "target-exists", status: "conflict" });
  });
});

describe("storage hashes", () => {
  it("uses SHA-256 over exact bytes", async () => {
    await expect(sha256ContentHash(new Uint8Array())).resolves.toBe(
      "sha256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    );
    await expect(sha256ContentHash(encoder.encode("你好"))).resolves.toBe(
      "sha256:Zw2XQ1Qsrj6n6-Nq9WvVNkiwoRJhYueNgaMpNKcRMC4",
    );
  });

  it("builds a deterministic versioned fingerprint", () => {
    expect(
      observedFingerprint("sha256:abc", "file", {
        lastModified: "2026-08-23T00:00:00Z",
        size: 3,
      }),
    ).toEqual(
      observedFingerprint("sha256:abc", "file", {
        lastModified: "2026-08-23T00:00:00Z",
        size: 3,
      }),
    );
  });
});

describe("BrowserWorkspacePathLock", () => {
  it("expands ancestors and promotes duplicate intents to exclusive", () => {
    expect(
      expandLockIntents("workspace", [
        { mode: "shared", path: "notes/a.md" },
        { mode: "exclusive", path: "notes" },
      ]),
    ).toEqual([
      { key: "grove:workspace:workspace:path:", mode: "shared" },
      { key: "grove:workspace:workspace:path:notes", mode: "exclusive" },
      { key: "grove:workspace:workspace:path:notes/a.md", mode: "shared" },
    ]);
  });

  it("serializes overlapping in-page operations", async () => {
    let lockA = new BrowserWorkspacePathLock(undefined);
    let lockB = new BrowserWorkspacePathLock(undefined);
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let events: string[] = [];
    let first = lockA.run({
      execute: async () => {
        events.push("first-start");
        await gate;
        events.push("first-end");
      },
      intents: [{ mode: "exclusive", path: "notes" }],
      workspaceId: "workspace",
    });
    await vi.waitFor(() => expect(events).toEqual(["first-start"]));
    let second = lockB.run({
      execute: async () => {
        events.push("second");
      },
      intents: [{ mode: "shared", path: "notes/a.md" }],
      workspaceId: "workspace",
    });
    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });
});

function createStore(
  operator: OpendalExactBrowserOperator,
  options: { captureAttempts?: number } = {},
) {
  return new OpendalWorkspaceObjectStore(
    new StaticOpendalOperatorHost({ id: "workspace", kind: "local", name: "Workspace" }, operator),
    { ...options, lock: new BrowserWorkspacePathLock(undefined) },
  );
}

async function presentRead(store: OpendalWorkspaceObjectStore, path: string) {
  let observation = await store.read(path);
  if (observation.state != "present") throw new Error("expected a present observation");
  return observation.value;
}

function operatorInfo(
  writeConditions: { ifMatch?: boolean; ifNotExists?: boolean; ifVersion?: boolean } = {},
): OpendalOperatorInfo {
  return {
    capabilities: {
      createDirectory: true,
      delete: { recursive: "native", single: true },
      list: true,
      read: true,
      rename: { directory: "copy-delete", file: "copy-delete" },
      stat: true,
      write: true,
      writeConditions: {
        ifMatch: writeConditions.ifMatch ?? false,
        ifNotExists: writeConditions.ifNotExists ?? false,
        ifVersion: writeConditions.ifVersion ?? false,
      },
    },
    root: "/",
    scheme: "browser-local",
  };
}

function fakeOperator(
  overrides: Partial<OpendalExactBrowserOperator> = {},
): OpendalExactBrowserOperator {
  let info = overrides.info ?? operatorInfo();
  return {
    createDirectory: async () => {},
    delete: async () => ({ status: "applied" }),
    dispose: () => {},
    list: async () => [],
    read: async (path) => ({
      bytes: encoder.encode("value"),
      metadata: fileMetadata(path),
      metadataBinding: "same-read",
    }),
    rename: async () => ({ status: "applied" }),
    stat: async (path) => fileMetadata(path),
    write: async () => ({ metadataBinding: "none", status: "applied" }),
    ...overrides,
    info,
  };
}

function fileMetadata(path: string, overrides: Partial<OpendalMetadata> = {}): OpendalMetadata {
  return { kind: "file", path, ...overrides };
}

function opendalError(
  code: ConstructorParameters<typeof OpendalBrowserError>[0]["code"],
  operation: ConstructorParameters<typeof OpendalBrowserError>[0]["operation"],
) {
  return new OpendalBrowserError({ code, message: code, operation });
}
