export type DebouncedTask = {
  cancel: () => void;
  dispose: () => void;
  flush: () => Promise<void>;
  pending: () => boolean;
  schedule: () => void;
};

export type DebouncedTaskOptions = {
  delayMs: number;
  maxWaitMs?: number;
  onError?: (error: unknown) => void;
  run: () => Promise<void> | void;
};

type Timer = ReturnType<typeof setTimeout>;

export function createDebouncedTask(options: DebouncedTaskOptions): DebouncedTask {
  let delayTimer: Timer | null = null;
  let disposed = false;
  let forceAfterRun = false;
  let maxWaitTimer: Timer | null = null;
  let queued = false;
  let running: Promise<void> | null = null;

  function clearDelayTimer() {
    if (delayTimer == null) return;
    clearTimeout(delayTimer);
    delayTimer = null;
  }

  function clearMaxWaitTimer() {
    if (maxWaitTimer == null) return;
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }

  function clearTimers() {
    clearDelayTimer();
    clearMaxWaitTimer();
  }

  async function execute() {
    try {
      await options.run();
    } catch (error) {
      options.onError?.(error);
      if (!options.onError) throw error;
    }
  }

  function runScheduledFlush() {
    void flush().catch((error: unknown) => {
      options.onError?.(error);
    });
  }

  function schedule() {
    if (disposed) return;
    queued = true;
    clearDelayTimer();
    delayTimer = setTimeout(() => {
      delayTimer = null;
      runScheduledFlush();
    }, options.delayMs);

    if (options.maxWaitMs == null || maxWaitTimer != null) return;
    maxWaitTimer = setTimeout(() => {
      maxWaitTimer = null;
      runScheduledFlush();
    }, options.maxWaitMs);
  }

  async function flush() {
    if (disposed) {
      cancel();
      return;
    }

    clearTimers();
    if (running) {
      forceAfterRun = true;
      await running;
      if (forceAfterRun && queued && !disposed) await flush();
      return;
    }

    if (!queued) return;

    queued = false;
    forceAfterRun = false;
    let currentRun = execute();
    running = currentRun;
    try {
      await currentRun;
    } finally {
      if (running == currentRun) running = null;
    }

    if (forceAfterRun && queued && !disposed) await flush();
  }

  function cancel() {
    clearTimers();
    queued = false;
    forceAfterRun = false;
  }

  function dispose() {
    disposed = true;
    cancel();
  }

  function pending() {
    return queued || delayTimer != null || maxWaitTimer != null || running != null;
  }

  return {
    cancel,
    dispose,
    flush,
    pending,
    schedule,
  };
}
