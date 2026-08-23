import { describe, expect, it, vi } from "vite-plus/test";
import { enqueueRuntimeTransition, transitionWorkspaceRuntime } from "./runtime-lifecycle.ts";
import type { WorkspaceRuntime } from "./types.ts";

describe("workspace runtime lifecycle", () => {
  it("closes the document before activation and disposes the replaced runtime last", async () => {
    let events: string[] = [];
    let current = runtime("current", events);
    let next = runtime("next", events);

    await transitionWorkspaceRuntime({
      activate: () => events.push("activate:next"),
      closeActiveDocument: async () => {
        events.push("close-document");
      },
      current,
      next,
    });

    expect(events).toEqual(["close-document", "activate:next", "dispose:current"]);
  });

  it("still closes the active document when reusing the same runtime", async () => {
    let events: string[] = [];
    let current = runtime("current", events);

    await transitionWorkspaceRuntime({
      activate: () => events.push("activate:current"),
      closeActiveDocument: async () => {
        events.push("close-document");
      },
      current,
      next: current,
    });

    expect(events).toEqual(["close-document", "activate:current"]);
  });

  it("disposes an unactivated runtime when closing the document fails", async () => {
    let events: string[] = [];
    let next = runtime("next", events);

    await expect(
      transitionWorkspaceRuntime({
        activate: vi.fn(),
        closeActiveDocument: async () => {
          throw new Error("close failed");
        },
        current: runtime("current", events),
        next,
      }),
    ).rejects.toThrow("close failed");
    expect(events).toEqual(["dispose:next"]);
  });

  it("serializes competing runtime transitions", async () => {
    let queue = { current: Promise.resolve() };
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let events: string[] = [];

    let first = enqueueRuntimeTransition(queue, async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    let second = enqueueRuntimeTransition(queue, async () => {
      events.push("second");
    });
    await vi.waitFor(() => expect(events).toEqual(["first-start"]));
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });
});

function runtime(id: string, events: string[]) {
  return {
    dispose: async () => {
      events.push(`dispose:${id}`);
    },
  } as WorkspaceRuntime;
}
