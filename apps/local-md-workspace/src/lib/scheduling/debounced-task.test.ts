import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDebouncedTask } from "./debounced-task.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("debounced tasks", () => {
  it("runs once after the trailing delay", async () => {
    vi.useFakeTimers();
    let runs = 0;
    let task = createDebouncedTask({
      delayMs: 100,
      run: () => {
        runs += 1;
      },
    });

    task.schedule();
    await vi.advanceTimersByTimeAsync(99);
    expect(runs).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    expect(task.pending()).toBe(false);
  });

  it("resets the trailing delay while keeping one max-wait timer", async () => {
    vi.useFakeTimers();
    let runs = 0;
    let task = createDebouncedTask({
      delayMs: 100,
      maxWaitMs: 250,
      run: () => {
        runs += 1;
      },
    });

    task.schedule();
    await vi.advanceTimersByTimeAsync(90);
    task.schedule();
    await vi.advanceTimersByTimeAsync(90);
    task.schedule();
    await vi.advanceTimersByTimeAsync(69);
    expect(runs).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
  });

  it("flushes immediately and cancels timers", async () => {
    vi.useFakeTimers();
    let runs = 0;
    let task = createDebouncedTask({
      delayMs: 100,
      maxWaitMs: 500,
      run: () => {
        runs += 1;
      },
    });

    task.schedule();
    await task.flush();
    expect(runs).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toBe(1);
  });

  it("cancels queued work without stopping an active run", async () => {
    vi.useFakeTimers();
    let runs = 0;
    let task = createDebouncedTask({
      delayMs: 100,
      run: () => {
        runs += 1;
      },
    });

    task.schedule();
    task.cancel();
    await vi.advanceTimersByTimeAsync(100);

    expect(runs).toBe(0);
    expect(task.pending()).toBe(false);
  });

  it("flushes queued work after an active run when the delay fires while running", async () => {
    vi.useFakeTimers();
    let resolveFirstRun: () => void = () => {
      throw new Error("First run did not start.");
    };
    let runs = 0;
    let task = createDebouncedTask({
      delayMs: 50,
      run: async () => {
        runs += 1;
        if (runs == 1) {
          await new Promise<void>((resolve) => {
            resolveFirstRun = resolve;
          });
        }
      },
    });

    task.schedule();
    await vi.advanceTimersByTimeAsync(50);
    expect(runs).toBe(1);

    task.schedule();
    await vi.advanceTimersByTimeAsync(50);
    expect(runs).toBe(1);

    resolveFirstRun();
    await vi.runAllTimersAsync();

    expect(runs).toBe(2);
  });
});
