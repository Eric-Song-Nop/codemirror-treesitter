import { describe, expect, it, vi } from "vite-plus/test";
import { createWorkspaceDocumentSessionKernel } from "@/app/document-session-coordinator";
import { createWorkspaceEffectRuntime } from "@/app/effect-runtime";
import { createWorkspaceAppStore } from "@/app/workspace-store";
import { transitionWorkspaceRuntime } from "./runtime-lifecycle.ts";
import type { WorkspaceRuntime } from "./types.ts";

describe("workspace runtime lifecycle", () => {
  it("closes the document before activation and disposes the replaced runtime last", async () => {
    let effectRuntime = createTestWorkspaceEffectRuntime();
    let events: string[] = [];
    let current = runtime("current", events);
    let next = runtime("next", events);

    await effectRuntime.runPromise(
      transitionWorkspaceRuntime({
        activate: () => events.push("activate:next"),
        closeActiveDocument: async () => {
          events.push("close-document");
        },
        current: () => current,
        next,
      }),
    );
    await effectRuntime.dispose();

    expect(events).toEqual(["close-document", "activate:next", "dispose:current"]);
  });

  it("still closes the active document when reusing the same runtime", async () => {
    let effectRuntime = createTestWorkspaceEffectRuntime();
    let events: string[] = [];
    let current = runtime("current", events);

    await effectRuntime.runPromise(
      transitionWorkspaceRuntime({
        activate: () => events.push("activate:current"),
        closeActiveDocument: async () => {
          events.push("close-document");
        },
        current: () => current,
        next: current,
      }),
    );
    await effectRuntime.dispose();

    expect(events).toEqual(["close-document", "activate:current"]);
  });

  it("disposes an unactivated runtime when closing the document fails", async () => {
    let effectRuntime = createTestWorkspaceEffectRuntime();
    let events: string[] = [];
    let next = runtime("next", events);

    await expect(
      effectRuntime.runPromise(
        transitionWorkspaceRuntime({
          activate: vi.fn(),
          closeActiveDocument: async () => {
            throw new Error("close failed");
          },
          current: () => runtime("current", events),
          next,
        }),
      ),
    ).rejects.toThrow("close failed");
    await effectRuntime.dispose();
    expect(events).toEqual(["dispose:next"]);
  });

  it("serializes competing runtime transitions", async () => {
    let effectRuntime = createTestWorkspaceEffectRuntime();
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let events: string[] = [];
    let active: WorkspaceRuntime | null = null;
    let firstRuntime = runtime("first", events);
    let secondRuntime = runtime("second", events);

    let first = effectRuntime.runPromise(
      transitionWorkspaceRuntime({
        activate: (next) => {
          active = next;
          events.push("first-activate");
        },
        closeActiveDocument: async () => {
          events.push("first-start");
          await gate;
          events.push("first-end");
        },
        current: () => null,
        next: firstRuntime,
      }),
    );
    let second = effectRuntime.runPromise(
      transitionWorkspaceRuntime({
        activate: (next) => {
          active = next;
          events.push("second");
        },
        closeActiveDocument: async () => {},
        current: () => active,
        next: secondRuntime,
      }),
    );
    await vi.waitFor(() => expect(events).toEqual(["first-start"]));
    release();
    await Promise.all([first, second]);
    await effectRuntime.dispose();
    expect(events).toEqual([
      "first-start",
      "first-end",
      "first-activate",
      "second",
      "dispose:first",
    ]);
  });

  it("disposes a pending candidate instead of activating it during app runtime disposal", async () => {
    let effectRuntime = createTestWorkspaceEffectRuntime();
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let events: string[] = [];
    let next = runtime("next", events);

    let transitionOutcome = effectRuntime
      .runPromise(
        transitionWorkspaceRuntime({
          activate: () => events.push("activate:next"),
          closeActiveDocument: async () => {
            events.push("close-start");
            await gate;
            events.push("close-end");
          },
          current: () => runtime("current", events),
          next,
        }),
      )
      .then(
        () => "fulfilled" as const,
        () => "rejected" as const,
      );
    await vi.waitFor(() => expect(events).toEqual(["close-start"]));

    events.push("dispose-requested");
    let disposal = effectRuntime.dispose();
    await vi.waitFor(() => expect(events).toContain("dispose:next"));
    expect(events).not.toContain("activate:next");

    release();
    await vi.waitFor(() => expect(events).toContain("close-end"));
    expect(await transitionOutcome).toBe("rejected");
    await disposal;
    expect(events).toEqual(["close-start", "dispose-requested", "dispose:next", "close-end"]);
  });

  it("disposes a candidate interrupted while waiting for the transition permit", async () => {
    let effectRuntime = createTestWorkspaceEffectRuntime();
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let events: string[] = [];
    let active: WorkspaceRuntime | null = null;
    let firstRuntime = runtime("first", events);
    let waitingRuntime = runtime("waiting", events);

    let first = effectRuntime
      .runPromise(
        transitionWorkspaceRuntime({
          activate: (next) => {
            active = next;
            events.push("activate:first");
          },
          closeActiveDocument: async () => {
            events.push("close-start");
            await gate;
            events.push("close-end");
          },
          current: () => active,
          next: firstRuntime,
        }),
      )
      .catch(() => {});
    let waiting = effectRuntime
      .runPromise(
        transitionWorkspaceRuntime({
          activate: (next) => {
            active = next;
            events.push("activate:waiting");
          },
          closeActiveDocument: async () => {},
          current: () => active,
          next: waitingRuntime,
        }),
      )
      .catch(() => {});
    await vi.waitFor(() => expect(events).toEqual(["close-start"]));

    let disposal = effectRuntime.dispose();
    await vi.waitFor(() => {
      expect(events).toContain("dispose:first");
      expect(events).toContain("dispose:waiting");
    });
    expect(events).not.toContain("activate:first");
    expect(events).not.toContain("activate:waiting");

    release();
    await Promise.all([first, waiting, disposal]);
  });
});

function createTestWorkspaceEffectRuntime() {
  return createWorkspaceEffectRuntime(
    createWorkspaceDocumentSessionKernel(createWorkspaceAppStore()),
  );
}

function runtime(id: string, events: string[]) {
  return {
    dispose: async () => {
      events.push(`dispose:${id}`);
    },
  } as WorkspaceRuntime;
}
