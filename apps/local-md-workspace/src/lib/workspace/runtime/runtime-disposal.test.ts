import { describe, expect, it, vi } from "vite-plus/test";
import { createWorkspaceRuntimeDisposal } from "./runtime-disposal.ts";

describe("workspace runtime disposal", () => {
  it("closes documents before observers and the storage host", async () => {
    let order: string[] = [];
    let releaseDocuments = deferred();
    let dispose = createWorkspaceRuntimeDisposal({
      changes: {
        dispose() {
          order.push("changes");
        },
      },
      documents: {
        close: async () => {
          order.push("documents:start");
          await releaseDocuments.promise;
          order.push("documents:end");
        },
        document: vi.fn(),
      },
      host: {
        dispose: async () => {
          order.push("host");
        },
      },
    });

    let first = dispose();
    expect(dispose()).toBe(first);
    await vi.waitFor(() => expect(order).toEqual(["documents:start"]));
    releaseDocuments.resolve();
    await first;

    expect(order).toEqual(["documents:start", "documents:end", "changes", "host"]);
  });

  it("releases later resources after a document close failure", async () => {
    let changes = { dispose: vi.fn(() => {}) };
    let host = { dispose: vi.fn(async () => {}) };
    let dispose = createWorkspaceRuntimeDisposal({
      changes,
      documents: {
        close: async () => {
          throw new Error("document close failed");
        },
        document: vi.fn(),
      },
      host,
    });

    await expect(dispose()).rejects.toThrow("document close failed");
    expect(changes.dispose).toHaveBeenCalledOnce();
    expect(host.dispose).toHaveBeenCalledOnce();
  });
});

function deferred() {
  let resolve!: () => void;
  let promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
