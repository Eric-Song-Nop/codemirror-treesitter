import { Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { createWorkspaceEffectRuntime } from "@/app/effect-runtime";
import { releaseWorkspaceRuntime, transitionWorkspaceRuntime } from "./runtime-lifecycle.ts";
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
        clearDocumentView: async () => {
          events.push("close-document");
        },
        current: () => current,
        next,
      }),
    );
    expect(events).toEqual(["close-document", "activate:next", "dispose:current"]);
    await effectRuntime.dispose();
    // Disposing the application runtime releases the active runtime.
    expect(events).toEqual(["close-document", "activate:next", "dispose:current", "dispose:next"]);
  });

  it("still clears the selected document view when reusing the same runtime", async () => {
    let effectRuntime = createTestWorkspaceEffectRuntime();
    let events: string[] = [];
    let current = runtime("current", events);

    await effectRuntime.runPromise(
      transitionWorkspaceRuntime({
        activate: () => events.push("activate:current"),
        clearDocumentView: async () => {
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
          clearDocumentView: async () => {
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
        clearDocumentView: async () => {
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
        clearDocumentView: async () => {},
        current: () => active,
        next: secondRuntime,
      }),
    );
    await vi.waitFor(() => expect(events).toEqual(["first-start"]));
    release();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first-start",
      "first-end",
      "first-activate",
      "second",
      "dispose:first",
    ]);
    await effectRuntime.dispose();
    expect(events.at(-1)).toBe("dispose:second");
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
          clearDocumentView: async () => {
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
          clearDocumentView: async () => {
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
          clearDocumentView: async () => {},
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

describe("scoped workspace runtime candidates", () => {
  it("releases a candidate whose opening fails after acquiring resources", async () => {
    let effectRuntime = createTestWorkspaceEffectRuntime();
    let events: string[] = [];
    let activate = vi.fn();

    await expect(
      effectRuntime.runPromise(
        transitionWorkspaceRuntime({
          activate,
          clearDocumentView: async () => {
            events.push("close-document");
          },
          current: () => null,
          next: Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => events.push("acquire:operator")),
              () => Effect.sync(() => events.push("release:operator")),
            );
            return yield* Effect.fail(new Error("token exchange failed"));
          }),
        }),
      ),
    ).rejects.toThrow("token exchange failed");

    expect(activate).not.toHaveBeenCalled();
    expect(events).toEqual(["acquire:operator", "release:operator"]);
    await effectRuntime.dispose();
  });

  it("releases a candidate when opening is interrupted", async () => {
    let effectRuntime = createTestWorkspaceEffectRuntime();
    let events: string[] = [];
    let fiber = effectRuntime.runFork(
      transitionWorkspaceRuntime({
        activate: () => events.push("activate"),
        clearDocumentView: async () => {},
        current: () => null,
        next: Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => events.push("acquire")),
            () => Effect.sync(() => events.push("release")),
          );
          return yield* Effect.never;
        }),
      }),
    );
    await vi.waitFor(() => expect(events).toEqual(["acquire"]));

    await effectRuntime.runPromise(Fiber.interrupt(fiber));

    expect(events).toEqual(["acquire", "release"]);
    await effectRuntime.dispose();
  });

  it("releases a scoped runtime when it is replaced", async () => {
    let effectRuntime = createTestWorkspaceEffectRuntime();
    let events: string[] = [];
    let active: WorkspaceRuntime | null = null;
    let open = (id: string) =>
      Effect.acquireRelease(Effect.succeed(runtime(id, events)), () =>
        Effect.sync(() => events.push(`release:${id}`)),
      );
    let transition = (id: string) =>
      effectRuntime.runPromise(
        transitionWorkspaceRuntime({
          activate: (next) => {
            active = next;
            events.push(`activate:${id}`);
          },
          clearDocumentView: async () => {},
          current: () => active,
          next: open(id),
        }),
      );

    await transition("first");
    await transition("second");

    expect(events).toEqual(["activate:first", "activate:second", "release:first"]);
    await effectRuntime.dispose();
    expect(events.at(-1)).toBe("release:second");
  });

  it("deactivates and releases the active runtime on release", async () => {
    let effectRuntime = createTestWorkspaceEffectRuntime();
    let events: string[] = [];
    let active: WorkspaceRuntime | null = null;
    await effectRuntime.runPromise(
      transitionWorkspaceRuntime({
        activate: (next) => {
          active = next;
        },
        clearDocumentView: async () => {},
        current: () => active,
        next: runtime("active", events),
      }),
    );

    await effectRuntime.runPromise(
      releaseWorkspaceRuntime({
        current: () => active,
        deactivate: () => {
          active = null;
          events.push("deactivate");
        },
      }),
    );

    expect(active).toBeNull();
    expect(events).toEqual(["deactivate", "dispose:active"]);
    await effectRuntime.dispose();
    expect(events).toEqual(["deactivate", "dispose:active"]);
  });
});

function createTestWorkspaceEffectRuntime() {
  return createWorkspaceEffectRuntime();
}

function runtime(id: string, events: string[]) {
  return {
    dispose: async () => {
      events.push(`dispose:${id}`);
    },
  } as WorkspaceRuntime;
}
