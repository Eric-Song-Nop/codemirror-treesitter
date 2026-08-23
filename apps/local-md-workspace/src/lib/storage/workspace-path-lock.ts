export type WorkspacePathLockIntent = {
  mode: "exclusive" | "shared";
  path: string;
};

export interface WorkspacePathLock {
  run<T>(input: {
    execute: () => Promise<T>;
    intents: WorkspacePathLockIntent[];
    workspaceId: string;
  }): Promise<T>;
}

type BrowserLockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive" | "shared" },
    callback: () => Promise<T>,
  ): Promise<T>;
};

const inPageLocks = new Map<string, Promise<void>>();

export class BrowserWorkspacePathLock implements WorkspacePathLock {
  constructor(
    private readonly browserLocks: BrowserLockManager | undefined = globalThis.navigator?.locks,
  ) {}

  run<T>(input: {
    execute: () => Promise<T>;
    intents: WorkspacePathLockIntent[];
    workspaceId: string;
  }) {
    let locks = expandLockIntents(input.workspaceId, input.intents);
    if (this.browserLocks) return runWithBrowserLocks(this.browserLocks, locks, input.execute);
    return runWithInPageLocks(locks, input.execute);
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

async function runWithBrowserLocks<T>(
  manager: BrowserLockManager,
  locks: Array<{ key: string; mode: "exclusive" | "shared" }>,
  execute: () => Promise<T>,
): Promise<T> {
  let acquire = (index: number): Promise<T> => {
    let lock = locks[index];
    if (!lock) return execute();
    return manager.request(lock.key, { mode: lock.mode }, () => acquire(index + 1));
  };
  return acquire(0);
}

async function runWithInPageLocks<T>(locks: Array<{ key: string }>, execute: () => Promise<T>) {
  let releases: Array<() => void> = [];
  try {
    for (let lock of locks) releases.push(await acquireInPageLock(lock.key));
    return await execute();
  } finally {
    for (let release of releases.toReversed()) release();
  }
}

async function acquireInPageLock(key: string) {
  let previous = inPageLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  let current = new Promise<void>((resolve) => {
    release = resolve;
  });
  let tail = previous.then(() => current);
  inPageLocks.set(key, tail);
  await previous;
  return () => {
    release();
    if (inPageLocks.get(key) === tail) inPageLocks.delete(key);
  };
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
