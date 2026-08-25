import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AccessDirectoryHandle } from "../file-system.ts";
import { WorkspaceDocumentChangeMonitor } from "./document-changes.ts";

describe("WorkspaceDocumentChangeMonitor polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses an atomic probe without reading content and emits one changed hint", async () => {
    let revision = "r1";
    let observe = vi.fn(async () => presentSnapshot("unused"));
    let listener = vi.fn();
    let subscription = new WorkspaceDocumentChangeMonitor({
      hintDebounceMs: 0,
      intervalMs: 100,
      maxIntervalMs: 800,
      observe,
      probe: async () => ({
        state: "present" as const,
        value: {
          kind: "file" as const,
          metadata: {},
          revision: { kind: "etag" as const, validation: "atomic" as const, value: revision },
        },
      }),
      random: () => 0.5,
    }).subscribe("note.md", listener);
    await settleStart();

    expect(listener).toHaveBeenCalledWith({ kind: "monitor-unavailable", path: "note.md" });
    expect(observe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    revision = "r2";
    await vi.advanceTimersByTimeAsync(100);
    await flushHintTimers();

    expect(listener.mock.calls.filter(([hint]) => hint.kind == "changed")).toHaveLength(1);
    expect(observe).not.toHaveBeenCalled();
    subscription.dispose();
  });

  it("reads and hashes when a probe has no atomic revision", async () => {
    let content = "one";
    let observe = vi.fn(async () => presentSnapshot(content));
    let listener = vi.fn();
    let subscription = new WorkspaceDocumentChangeMonitor({
      hintDebounceMs: 0,
      intervalMs: 100,
      observe,
      probe: async () => ({
        state: "present" as const,
        value: { kind: "file" as const, metadata: {} },
      }),
      random: () => 0.5,
    }).subscribe("note.md", listener);
    await settleStart();
    await vi.advanceTimersByTimeAsync(0);
    content = "two";
    await vi.advanceTimersByTimeAsync(100);
    await flushHintTimers();

    expect(observe).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenCalledWith({ kind: "changed", path: "note.md" });
    subscription.dispose();
  });

  it("never overlaps polls and ignores a late result after disposal", async () => {
    let resolvePoll!: (value: ReturnType<typeof presentProbe>) => void;
    let calls = 0;
    let probe = vi.fn(() => {
      calls += 1;
      if (calls == 1) return Promise.resolve(presentProbe("r1"));
      return new Promise<ReturnType<typeof presentProbe>>((resolve) => {
        resolvePoll = resolve;
      });
    });
    let listener = vi.fn();
    let subscription = new WorkspaceDocumentChangeMonitor({
      hintDebounceMs: 0,
      intervalMs: 100,
      observe: async () => presentSnapshot("unused"),
      probe,
      random: () => 0.5,
    }).subscribe("note.md", listener);
    await settleStart();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(2);

    subscription.dispose();
    resolvePoll(presentProbe("r2"));
    await Promise.resolve();
    await vi.runAllTimersAsync();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalledWith({ kind: "changed", path: "note.md" });
  });

  it("backs off unavailable samples and resumes detecting a present revision", async () => {
    let unavailable = true;
    let listener = vi.fn();
    let subscription = new WorkspaceDocumentChangeMonitor({
      hintDebounceMs: 0,
      intervalMs: 100,
      maxIntervalMs: 800,
      observe: async () => presentSnapshot("unused"),
      probe: async () =>
        unavailable
          ? {
              error: {
                code: "temporary" as const,
                retryable: true,
              } as never,
              state: "unavailable" as const,
            }
          : presentProbe("r2"),
      random: () => 0.5,
    }).subscribe("note.md", listener);
    await settleStart();
    await vi.advanceTimersByTimeAsync(0);
    unavailable = false;
    await vi.advanceTimersByTimeAsync(200);
    await flushHintTimers();

    expect(listener).toHaveBeenCalledWith({ kind: "changed", path: "note.md" });
    subscription.dispose();
  });
});

describe("WorkspaceDocumentChangeMonitor FileSystemObserver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("observes only the immediate parent non-recursively and filters active-file records", async () => {
    let observer = createObserverHarness();
    let root = directoryHandle("root", {
      folder: directoryHandle("folder"),
    });
    let listener = vi.fn();
    let subscription = new WorkspaceDocumentChangeMonitor({
      hintDebounceMs: 0,
      localRoot: root,
      observe: async () => presentSnapshot("one"),
      observerConstructor: observer.Constructor,
    }).subscribe("folder/note.md", listener);
    await settleStart();

    expect(observer.observe).toHaveBeenCalledWith(expect.objectContaining({ name: "folder" }), {
      recursive: false,
    });
    observer.callback([{ relativePathComponents: ["other.md"], type: "modified" }]);
    observer.callback([{ relativePathComponents: ["note.md"], type: "modified" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ kind: "changed", path: "folder/note.md" });

    observer.callback([{ relativePathMovedFrom: ["note.md"], type: "moved" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(2);
    subscription.dispose();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps unknown records as resync hints but falls back after a terminal error", async () => {
    let observer = createObserverHarness();
    let listener = vi.fn();
    let subscription = new WorkspaceDocumentChangeMonitor({
      hintDebounceMs: 0,
      intervalMs: 100,
      localRoot: directoryHandle("root"),
      observe: async () => presentSnapshot("one"),
      observerConstructor: observer.Constructor,
      random: () => 0.5,
    }).subscribe("note.md", listener);
    await settleStart();

    observer.callback([{ type: "unknown" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledWith({ kind: "resync-required", path: "note.md" });
    expect(observer.disconnect).not.toHaveBeenCalled();

    observer.callback([{ type: "errored" }]);
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ kind: "monitor-unavailable", path: "note.md" });
    subscription.dispose();
  });

  it("contains listener failures and still disconnects", async () => {
    let observer = createObserverHarness();
    let subscription = new WorkspaceDocumentChangeMonitor({
      hintDebounceMs: 0,
      localRoot: directoryHandle("root"),
      observe: async () => presentSnapshot("one"),
      observerConstructor: observer.Constructor,
    }).subscribe("note.md", () => {
      throw new Error("consumer failed");
    });
    await settleStart();

    observer.callback([{ relativePathComponents: ["note.md"], type: "modified" }]);
    await vi.advanceTimersByTimeAsync(0);
    subscription.dispose();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("disposes every active subscription with the source runtime", async () => {
    let observer = createObserverHarness();
    let source = new WorkspaceDocumentChangeMonitor({
      localRoot: directoryHandle("root"),
      observe: async () => presentSnapshot("one"),
      observerConstructor: observer.Constructor,
    });
    source.subscribe("note.md", vi.fn());
    await settleStart();

    source.dispose();

    expect(observer.disconnect).toHaveBeenCalledOnce();
  });
});

function presentSnapshot(value: string) {
  return {
    state: "present" as const,
    value: {
      bytes: new TextEncoder().encode(value),
      capture: "observed" as const,
      contentHash: `hash:${value}`,
      metadata: {},
      revision: {
        kind: "fingerprint" as const,
        validation: "observed" as const,
        value: `fingerprint:${value}`,
      },
      value,
    },
  };
}

function presentProbe(revision: string) {
  return {
    state: "present" as const,
    value: {
      kind: "file" as const,
      metadata: {},
      revision: { kind: "etag" as const, validation: "atomic" as const, value: revision },
    },
  };
}

async function settleStart() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushHintTimers() {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1);
}

function directoryHandle(
  name: string,
  children: Record<string, AccessDirectoryHandle> = {},
): AccessDirectoryHandle {
  return {
    getDirectoryHandle: async (childName) => {
      let child = children[childName];
      if (!child) throw new DOMException(`${childName} missing`, "NotFoundError");
      return child;
    },
    getFileHandle: async () => {
      throw new Error("not implemented");
    },
    kind: "directory",
    name,
    removeEntry: async () => {},
    values: async function* () {},
  };
}

function createObserverHarness() {
  let callback: (
    records: Array<{
      relativePathComponents?: string[];
      relativePathMovedFrom?: string[];
      type?: string;
    }>,
  ) => void = () => {};
  let observe = vi.fn(
    async (_handle: AccessDirectoryHandle, _options?: { recursive?: boolean }) => {},
  );
  let disconnect = vi.fn();
  class Constructor {
    constructor(nextCallback: typeof callback) {
      callback = nextCallback;
    }

    disconnect() {
      disconnect();
    }

    observe(handle: AccessDirectoryHandle, options?: { recursive?: boolean }) {
      return observe(handle, options);
    }
  }
  return {
    Constructor,
    get callback() {
      return callback;
    },
    disconnect,
    observe,
  };
}
