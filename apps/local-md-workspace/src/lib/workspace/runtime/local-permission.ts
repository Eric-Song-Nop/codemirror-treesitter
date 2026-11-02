import { OpendalBrowserError } from "@codemirror-treesitter/opendal-wasm-browser";
import { Effect } from "effect";
import type {
  OpendalOperationClass,
  OpendalOperatorHost,
} from "../storage/opendal-operator-host.ts";
import { isPermissionDeniedError } from "../storage/errors.ts";
import type { WorkspaceHostPermission } from "./types.ts";

type PermissionMode = "read" | "readwrite";

export type PermissionHandle = {
  queryPermission?: (descriptor?: { mode?: PermissionMode }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: PermissionMode }) => Promise<PermissionState>;
};

type VisibilitySource = Pick<Document, "addEventListener" | "removeEventListener"> & {
  readonly visibilityState: DocumentVisibilityState;
};

const READ_WRITE = { mode: "readwrite" } as const;

/**
 * Tracks File System Access read/write permission for a workspace root handle.
 *
 * Browsers let the user revoke a granted handle mid-session from site controls.
 * The tracker re-queries permission when the page becomes visible again and
 * before the first write after the page was hidden, and records denials
 * observed from failing storage operations so the UI can offer a re-grant.
 */
export class FileSystemPermissionTracker implements WorkspaceHostPermission {
  private current: PermissionState = "granted";
  private disposed = false;
  private readonly listeners = new Set<(state: PermissionState) => void>();
  private pendingCheck: Promise<PermissionState> | null = null;
  private stale = false;
  private readonly visibility: VisibilitySource | null;

  constructor(
    private readonly handle: PermissionHandle,
    options: { visibility?: VisibilitySource | null } = {},
  ) {
    this.visibility =
      options.visibility === undefined
        ? typeof document == "undefined"
          ? null
          : document
        : options.visibility;
    this.visibility?.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  get state() {
    return this.current;
  }

  subscribe(listener: (state: PermissionState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  check(): Promise<PermissionState> {
    if (this.disposed) return Promise.resolve(this.current);
    if (!this.handle.queryPermission) {
      this.stale = false;
      return Promise.resolve(this.current);
    }
    this.pendingCheck ??= this.handle
      .queryPermission(READ_WRITE)
      .then(
        (state) => {
          this.stale = false;
          this.publish(state);
          return state;
        },
        () => this.current,
      )
      .finally(() => {
        this.pendingCheck = null;
      });
    return this.pendingCheck;
  }

  /** Requests access again. Browsers require this to run inside a user gesture. */
  async request(): Promise<PermissionState> {
    if (this.disposed) return this.current;
    if (!this.handle.requestPermission) return this.check();
    let state = await this.handle.requestPermission(READ_WRITE);
    this.stale = false;
    this.publish(state);
    return state;
  }

  /**
   * Succeeds when a write may proceed, or fails with a `permission-denied`
   * OpenDAL error (confirmed not applied) that the object store translates to
   * `WorkspacePermissionDenied`.
   */
  ensureWritable(operation: "delete" | "write"): Effect.Effect<void, OpendalBrowserError> {
    return Effect.gen({ self: this }, function* () {
      if (this.stale || this.current != "granted") yield* Effect.promise(() => this.check());
      if (this.current == "granted") return;
      return yield* Effect.fail(
        new OpendalBrowserError({
          code: "permission-denied",
          message:
            this.current == "prompt"
              ? "Workspace folder access needs to be granted again."
              : "Workspace folder access was revoked.",
          mutationOutcome: "not-applied",
          operation,
        }),
      );
    });
  }

  /** Records a failing operation. Returns true when it was a permission failure. */
  reportFailure(error: unknown) {
    if (!isPermissionDeniedError(error)) return false;
    // Trust the browser's permission state when it can be queried: other
    // failures (for example a locked file) can also read as "not allowed".
    if (this.handle.queryPermission) {
      this.stale = true;
      void this.check();
    } else {
      this.publish("denied");
    }
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.visibility?.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.listeners.clear();
  }

  private readonly handleVisibilityChange = () => {
    if (!this.visibility) return;
    if (this.visibility.visibilityState == "hidden") {
      this.stale = true;
    } else {
      void this.check();
    }
  };

  private publish(state: PermissionState) {
    if (this.current == state) return;
    this.current = state;
    for (let listener of this.listeners) listener(state);
  }
}

/**
 * Wraps a browser-local operator host so writes check folder permission first
 * and permission failures from any operator call surface as `permission-denied`.
 * The tracker's listeners are released by the runtime scope that created it.
 */
export function withLocalPermissionChecks(
  inner: OpendalOperatorHost,
  permission: FileSystemPermissionTracker,
): OpendalOperatorHost {
  return {
    get identity() {
      return inner.identity;
    },
    get operatorInfo() {
      return inner.operatorInfo;
    },
    run: (input) => {
      let run = Effect.suspend(() =>
        inner.run({
          execute: async (operator) => {
            try {
              return await input.execute(operator);
            } catch (error) {
              if (!permission.reportFailure(error)) throw error;
              throw asPermissionDeniedError(error, input.operation);
            }
          },
          operation: input.operation,
        }),
      );
      return input.operation == "read"
        ? run
        : Effect.andThen(permission.ensureWritable("write"), run);
    },
  };
}

function asPermissionDeniedError(error: unknown, operation: OpendalOperationClass) {
  if (error instanceof OpendalBrowserError) {
    if (error.code == "permission-denied") return error;
    return new OpendalBrowserError({
      cause: error,
      code: "permission-denied",
      message: error.message,
      mutationOutcome: error.mutationOutcome,
      operation: error.operation,
      path: error.path,
      reconcilePaths: error.reconcilePaths,
    });
  }
  return new OpendalBrowserError({
    cause: error,
    code: "permission-denied",
    message: error instanceof Error ? error.message : String(error),
    // A DOMException thrown before the operator touched storage is not applied;
    // anything else from a mutation may have partially started.
    mutationOutcome: operation == "read" ? undefined : "unknown",
    operation: operation == "read" ? "read" : "write",
  });
}
