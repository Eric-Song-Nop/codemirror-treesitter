import { OpendalBrowserError } from "@codemirror-treesitter/opendal-wasm-browser";
import { describe, expect, it, vi } from "vite-plus/test";
import type { OpendalOperatorHost } from "../storage/opendal-operator-host.ts";
import { isPermissionDeniedError, storageErrorFromOpendal } from "../storage/types.ts";
import {
  FileSystemPermissionTracker,
  PermissionAwareOperatorHost,
  type PermissionHandle,
} from "./local-permission.ts";

describe("FileSystemPermissionTracker", () => {
  it("re-queries permission when the page becomes visible again", async () => {
    let handle = fakeHandle("granted");
    let visibility = fakeVisibility();
    let tracker = new FileSystemPermissionTracker(handle, { visibility });
    let states: PermissionState[] = [];
    tracker.subscribe((state) => states.push(state));

    handle.state = "prompt";
    visibility.set("hidden");
    expect(handle.queryPermission).not.toHaveBeenCalled();
    visibility.set("visible");
    await vi.waitFor(() => expect(tracker.state).toBe("prompt"));

    expect(handle.queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
    expect(states).toEqual(["prompt"]);
    tracker.dispose();
  });

  it("checks before the first write after the page was hidden and blocks when denied", async () => {
    let handle = fakeHandle("granted");
    let visibility = fakeVisibility();
    let tracker = new FileSystemPermissionTracker(handle, { visibility });
    let inner = fakeHost();
    let host = new PermissionAwareOperatorHost(inner, tracker);

    await host.run({ execute: async () => "ok", operation: "unconditional-mutation" });
    expect(handle.queryPermission).not.toHaveBeenCalled();

    // Hidden without a visible transition yet: the next write must query first.
    visibility.set("hidden", { dispatch: true });
    handle.state = "denied";
    let error = await host
      .run({ execute: async () => "ok", operation: "conditional-mutation" })
      .catch((cause: unknown) => cause);

    expect(handle.queryPermission).toHaveBeenCalledOnce();
    expect(inner.run).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(OpendalBrowserError);
    expect(error).toMatchObject({ code: "permission-denied", mutationOutcome: "not-applied" });
    expect(storageErrorFromOpendal(error as OpendalBrowserError).code).toBe("permission-denied");
    expect(tracker.state).toBe("denied");
  });

  it("blocks writes while permission is prompt and resumes after re-grant", async () => {
    let handle = fakeHandle("prompt");
    let tracker = new FileSystemPermissionTracker(handle, { visibility: null });
    await tracker.check();
    let inner = fakeHost();
    let host = new PermissionAwareOperatorHost(inner, tracker);

    await expect(
      host.run({ execute: async () => "ok", operation: "unconditional-mutation" }),
    ).rejects.toMatchObject({ code: "permission-denied" });
    expect(inner.run).not.toHaveBeenCalled();

    // Reads are not gated; the browser decides.
    await expect(host.run({ execute: async () => "read", operation: "read" })).resolves.toBe(
      "read",
    );

    handle.grantOnRequest = true;
    await expect(tracker.request()).resolves.toBe("granted");
    await expect(
      host.run({ execute: async () => "written", operation: "unconditional-mutation" }),
    ).resolves.toBe("written");
  });

  it("maps NotAllowedError and SecurityError from operations to permission-denied", async () => {
    let handle = fakeHandle("granted");
    let tracker = new FileSystemPermissionTracker(handle, { visibility: null });
    let host = new PermissionAwareOperatorHost(
      fakeHost(async () => {
        handle.state = "denied";
        throw new DOMException("The request is not allowed.", "NotAllowedError");
      }),
      tracker,
    );

    let readError = await host
      .run({ execute: async () => "unused", operation: "read" })
      .catch((cause: unknown) => cause);
    expect(readError).toMatchObject({ code: "permission-denied", operation: "read" });
    await vi.waitFor(() => expect(tracker.state).toBe("denied"));

    let wrapped = new OpendalBrowserError({
      cause: new DOMException("blocked", "SecurityError"),
      code: "unknown",
      message: "blocked",
      operation: "write",
    });
    expect(isPermissionDeniedError(wrapped)).toBe(true);
    expect(storageErrorFromOpendal(wrapped).code).toBe("permission-denied");
    expect(isPermissionDeniedError(new Error("disk full"))).toBe(false);
  });

  it("keeps a granted state when the browser still reports access", async () => {
    let handle = fakeHandle("granted");
    let tracker = new FileSystemPermissionTracker(handle, { visibility: null });
    expect(tracker.reportFailure(new DOMException("locked", "NotAllowedError"))).toBe(true);
    await vi.waitFor(() => expect(handle.queryPermission).toHaveBeenCalled());
    expect(tracker.state).toBe("granted");
  });
});

type FakeHandle = Required<PermissionHandle> & {
  grantOnRequest: boolean;
  queryPermission: ReturnType<typeof vi.fn<() => Promise<PermissionState>>>;
  state: PermissionState;
};

function fakeHandle(initial: PermissionState): FakeHandle {
  let handle: FakeHandle = {
    grantOnRequest: false,
    queryPermission: vi.fn(async () => handle.state),
    requestPermission: vi.fn(async () => {
      if (handle.grantOnRequest) handle.state = "granted";
      return handle.state;
    }),
    state: initial,
  };
  return handle;
}

function fakeVisibility() {
  let target = new EventTarget();
  let source = Object.assign(target, {
    set(state: DocumentVisibilityState, options: { dispatch?: boolean } = { dispatch: true }) {
      source.visibilityState = state;
      if (options.dispatch ?? true) target.dispatchEvent(new Event("visibilitychange"));
    },
    visibilityState: "visible" as DocumentVisibilityState,
  });
  return source;
}

function fakeHost(execute?: () => Promise<unknown>) {
  let host = {
    dispose: vi.fn(async () => {}),
    identity: { id: "local:test", kind: "local" as const, name: "Test" },
    operatorInfo: {} as OpendalOperatorHost["operatorInfo"],
    run: vi.fn((input: Parameters<OpendalOperatorHost["run"]>[0]) =>
      execute ? execute() : input.execute({} as never),
    ),
  };
  return host as typeof host & OpendalOperatorHost;
}
