import { Effect } from "effect";

export type WorkspacePathLockIntent = {
  mode: "exclusive" | "shared";
  path: string;
};

/**
 * Cross-tab path locks for one workspace. `withLocks` acquires every expanded
 * lock in a stable order, runs the effect, and releases the locks when the
 * effect exits, fails, or is interrupted. Waiting for a lock is interruptible.
 */
export interface WorkspacePathLock {
  withLocks(input: {
    intents: WorkspacePathLockIntent[];
    workspaceId: string;
  }): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

type LockMode = "exclusive" | "shared";

type BrowserLockManager = {
  request<T>(
    name: string,
    options: { mode: LockMode; signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
};

const inPageLocks = new Map<string, Promise<void>>();

export class BrowserWorkspacePathLock implements WorkspacePathLock {
  constructor(
    private readonly browserLocks: BrowserLockManager | undefined = globalThis.navigator?.locks,
  ) {}

  withLocks(input: { intents: WorkspacePathLockIntent[]; workspaceId: string }) {
    return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        let locks = expandLockIntents(input.workspaceId, input.intents);
        let manager = this.browserLocks;
        return Effect.scoped(
          Effect.gen(function* () {
            for (let lock of locks) {
              yield* manager ? acquireBrowserLock(manager, lock) : acquireInPageLock(lock.key);
            }
            return yield* effect;
          }),
        );
      });
  }
}

export function expandLockIntents(workspaceId: string, intents: WorkspacePathLockIntent[]) {
  if (!workspaceId) throw new Error("Workspace path locks require an identity.");
  let workspaceKey = encodeURIComponent(workspaceId);
  let modes = new Map<string, "exclusive" | "shared">();
  for (let intent of intents) {
    let path = normalizeLockPath(intent.path);
    let parts = path ? path.split("/") : [];
    let ancestors = ["", ...parts.map((_part, index) => parts.slice(0, index + 1).join("/"))];
    for (let [index, ancestor] of ancestors.entries()) {
      let requested = index == ancestors.length - 1 ? intent.mode : "shared";
      let pathKey = ancestor.split("/").map(encodeURIComponent).join("/");
      let key = `grove:workspace:${workspaceKey}:path:${pathKey}`;
      let existing = modes.get(key);
      if (existing != "exclusive") modes.set(key, requested);
    }
  }
  return [...modes]
    .map(([key, mode]) => ({ key, mode }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Holds one Web Lock until the surrounding scope closes. The lock callback
 * returns a promise that resolves only when the scope releases it; a grant
 * that races an interruption is released immediately.
 */
function acquireBrowserLock(manager: BrowserLockManager, lock: { key: string; mode: LockMode }) {
  return Effect.uninterruptibleMask((restore) =>
    restore(
      Effect.callback<() => void>((resume, signal) => {
        manager
          .request(lock.key, { mode: lock.mode, signal }, () => {
            if (signal.aborted) return Promise.resolve();
            return new Promise<void>((release) => {
              resume(Effect.succeed(() => release()));
            });
          })
          .catch((error: unknown) => {
            if (!signal.aborted) resume(Effect.die(error));
          });
      }),
    ).pipe(Effect.tap((release) => Effect.addFinalizer(() => Effect.sync(release)))),
  );
}

/** Same-page FIFO lock used when the Web Locks API is unavailable. */
function acquireInPageLock(key: string) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      let previous = inPageLocks.get(key) ?? Promise.resolve();
      let release!: () => void;
      let current = new Promise<void>((resolve) => {
        release = resolve;
      });
      let tail = previous.then(() => current);
      inPageLocks.set(key, tail);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          release();
          if (inPageLocks.get(key) === tail) inPageLocks.delete(key);
        }),
      );
      yield* restore(Effect.promise(() => previous));
    }),
  );
}

function normalizeLockPath(rawPath: string) {
  let path = rawPath.trim().replace(/\\/g, "/");
  if (path.startsWith("/") && path != "/") {
    throw new Error("Workspace lock paths must be relative.");
  }
  let parts = path.split("/").filter(Boolean);
  if (parts.some((part) => part == "." || part == "..")) {
    throw new Error("Workspace lock paths cannot include . or .. segments.");
  }
  return parts.join("/");
}
