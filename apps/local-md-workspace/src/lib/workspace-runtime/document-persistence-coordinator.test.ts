import { describe, expect, it, vi } from "vite-plus/test";
import { DocumentPersistenceCoordinator } from "./document-persistence-coordinator.ts";

describe("DocumentPersistenceCoordinator", () => {
  it("persists the first and latest burst generations before resolving superseded callers", async () => {
    let coordinator = new DocumentPersistenceCoordinator();
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes: number[] = [];
    let secondSettled = false;
    let first = schedule(coordinator, 1, async () => {
      writes.push(1);
      await gate;
      return 1;
    });
    let second = schedule(coordinator, 2, async () => {
      writes.push(2);
      return 2;
    }).finally(() => {
      secondSettled = true;
    });
    let third = schedule(coordinator, 3, async () => {
      writes.push(3);
      return 3;
    });

    await Promise.resolve();
    expect(secondSettled).toBe(false);
    release();
    await expect(first).resolves.toEqual({ status: "completed", value: 1 });
    await expect(third).resolves.toEqual({ status: "completed", value: 3 });
    await expect(second).resolves.toEqual({ durableGeneration: 3, status: "superseded" });
    expect(writes).toEqual([1, 3]);
  });

  it("rejects duplicate or decreasing generations before storage work", async () => {
    let coordinator = new DocumentPersistenceCoordinator();
    let duplicate = vi.fn(async () => "duplicate");
    await schedule(coordinator, 2, async () => "done");

    await expect(schedule(coordinator, 2, duplicate)).resolves.toEqual({
      status: "rejected-generation",
    });
    await expect(schedule(coordinator, 1, duplicate)).resolves.toEqual({
      status: "rejected-generation",
    });
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("returns busy for a replacement session until the previous fence closes", async () => {
    let coordinator = new DocumentPersistenceCoordinator();
    await schedule(coordinator, 1, async () => "old");
    let replacementRun = vi.fn(async () => "next");

    await expect(
      coordinator.schedule({
        epoch: 2,
        generation: 0,
        path: "note.md",
        run: replacementRun,
        sessionId: "next-session",
        workspaceId: "workspace",
      }),
    ).resolves.toEqual({ status: "busy" });
    expect(replacementRun).not.toHaveBeenCalled();

    await expect(
      coordinator.close({
        epoch: 1,
        path: "note.md",
        sessionId: "session",
        workspaceId: "workspace",
      }),
    ).resolves.toEqual({ status: "closed" });
    await expect(
      coordinator.schedule({
        epoch: 2,
        generation: 0,
        path: "note.md",
        run: replacementRun,
        sessionId: "next-session",
        workspaceId: "workspace",
      }),
    ).resolves.toEqual({ status: "completed", value: "next" });
  });

  it("does not let a stale close tear down the current session", async () => {
    let coordinator = new DocumentPersistenceCoordinator();
    await schedule(coordinator, 1, async () => "current");

    await expect(
      coordinator.close({
        epoch: 0,
        path: "note.md",
        sessionId: "old",
        workspaceId: "workspace",
      }),
    ).resolves.toEqual({ status: "stale" });
    expect(coordinator.busy({ path: "note.md", workspaceId: "workspace" })).toBe(true);
  });

  it("blocks pre-refresh pending projections and runs the barrier after the in-flight write", async () => {
    let coordinator = new DocumentPersistenceCoordinator();
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let events: string[] = [];
    let first = schedule(coordinator, 1, async () => {
      events.push("write-1");
      await gate;
    });
    let pending = schedule(coordinator, 2, async () => {
      events.push("write-2");
    });
    let barrier = coordinator.barrier({
      path: "note.md",
      run: async () => {
        events.push("refresh");
      },
      workspaceId: "workspace",
    });

    await expect(pending).resolves.toEqual({ reason: "refresh", status: "blocked" });
    release();
    await first;
    await barrier;
    expect(events).toEqual(["write-1", "refresh"]);
  });

  it("coalesces barriers waiting behind one write", async () => {
    let coordinator = new DocumentPersistenceCoordinator();
    let release!: () => void;
    let first = schedule(
      coordinator,
      1,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let refresh = vi.fn(async () => {});
    let ignoredRefresh = vi.fn(async () => {});
    let firstBarrier = coordinator.barrier({
      path: "note.md",
      run: refresh,
      workspaceId: "workspace",
    });
    let secondBarrier = coordinator.barrier({
      path: "note.md",
      run: ignoredRefresh,
      workspaceId: "workspace",
    });

    release();
    await Promise.all([first, firstBarrier, secondBarrier]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(ignoredRefresh).not.toHaveBeenCalled();
  });

  it("runs one follow-up barrier when a hint arrives during reconciliation", async () => {
    let coordinator = new DocumentPersistenceCoordinator();
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let events: string[] = [];
    let first = coordinator.barrier({
      path: "note.md",
      run: async () => {
        events.push("first");
        await gate;
      },
      workspaceId: "workspace",
    });
    await vi.waitFor(() => expect(events).toEqual(["first"]));
    let second = coordinator.barrier({
      path: "note.md",
      run: async () => {
        events.push("second");
      },
      workspaceId: "workspace",
    });
    let third = coordinator.barrier({
      path: "note.md",
      run: async () => {
        events.push("third");
      },
      workspaceId: "workspace",
    });

    release();
    await Promise.all([first, second, third]);
    expect(events).toEqual(["first", "second"]);
  });

  it("blocks pending work when a session closes", async () => {
    let coordinator = new DocumentPersistenceCoordinator();
    let release!: () => void;
    let first = schedule(
      coordinator,
      1,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let pending = schedule(coordinator, 2, async () => {});
    let close = coordinator.close({
      epoch: 1,
      path: "note.md",
      sessionId: "session",
      workspaceId: "workspace",
    });

    await expect(pending).resolves.toEqual({ reason: "closed", status: "blocked" });
    release();
    await expect(first).resolves.toEqual({ status: "stale" });
    await expect(close).resolves.toEqual({ status: "closed" });
  });
});

function schedule<T>(
  coordinator: DocumentPersistenceCoordinator,
  generation: number,
  run: () => Promise<T>,
) {
  return coordinator.schedule({
    epoch: 1,
    generation,
    path: "note.md",
    run,
    sessionId: "session",
    workspaceId: "workspace",
  });
}
