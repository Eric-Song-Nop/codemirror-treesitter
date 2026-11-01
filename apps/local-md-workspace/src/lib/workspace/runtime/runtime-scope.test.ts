import { Effect, Exit, Fiber, Scope } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  acquireDisposable,
  makeScopedWorkspaceRuntime,
  type WorkspaceRuntimeParts,
} from "./runtime-scope.ts";

describe("makeScopedWorkspaceRuntime", () => {
  it("releases documents before observers and the storage host, once", async () => {
    let order: string[] = [];
    let releaseDocuments = deferred();
    let runtime = await Effect.runPromise(
      makeScopedWorkspaceRuntime(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => order.push("host")));
          yield* acquireDisposable(() => ({ dispose: () => order.push("changes") }));
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              order.push("documents:start");
              await releaseDocuments.promise;
              order.push("documents:end");
            }),
          );
          return parts();
        }),
      ).pipe(Scope.provide(Scope.makeUnsafe())),
    );

    let first = runtime.dispose();
    expect(runtime.dispose()).toBe(first);
    await vi.waitFor(() => expect(order).toEqual(["documents:start"]));
    releaseDocuments.resolve();
    await first;

    expect(order).toEqual(["documents:start", "documents:end", "changes", "host"]);
  });

  it("releases later resources after a release failure and rejects with it", async () => {
    let changes = vi.fn();
    let host = vi.fn();
    let runtime = await Effect.runPromise(
      makeScopedWorkspaceRuntime(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(host));
          yield* acquireDisposable(() => ({ dispose: changes }));
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              throw new Error("document close failed");
            }),
          );
          return parts();
        }),
      ).pipe(Scope.provide(Scope.makeUnsafe())),
    );

    await expect(runtime.dispose()).rejects.toThrow("document close failed");
    expect(changes).toHaveBeenCalledOnce();
    expect(host).toHaveBeenCalledOnce();
  });

  it("aggregates several release failures", async () => {
    let runtime = await Effect.runPromise(
      makeScopedWorkspaceRuntime(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.die(new Error("host failed")));
          yield* Effect.addFinalizer(() => Effect.die(new Error("documents failed")));
          return parts();
        }),
      ).pipe(Scope.provide(Scope.makeUnsafe())),
    );

    let error = await runtime.dispose().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((cause: Error) => cause.message)).toEqual([
      "documents failed",
      "host failed",
    ]);
  });

  it("releases what was acquired when building fails", async () => {
    let released: string[] = [];
    let exit = await Effect.runPromiseExit(
      makeScopedWorkspaceRuntime(
        Effect.gen(function* () {
          yield* acquireDisposable(() => ({ dispose: () => released.push("operator") }));
          yield* acquireDisposable(() => ({ dispose: () => released.push("permission") }));
          return yield* Effect.fail("monitor failed" as const);
        }),
      ).pipe(Effect.scoped),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(released).toEqual(["permission", "operator"]);
  });

  it("releases what was acquired when building is interrupted", async () => {
    let released = vi.fn();
    let fiber = Effect.runFork(
      makeScopedWorkspaceRuntime(
        Effect.gen(function* () {
          yield* acquireDisposable(() => ({ dispose: released }));
          return yield* Effect.never;
        }),
      ).pipe(Effect.scoped),
    );
    await vi.waitFor(() => expect(fiber.pollUnsafe()).toBeUndefined());
    await Effect.runPromise(Effect.yieldNow);
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(released).toHaveBeenCalledOnce();
  });

  it("is released when the surrounding scope closes", async () => {
    let released = vi.fn();
    let scope = Scope.makeUnsafe();
    let runtime = await Effect.runPromise(
      makeScopedWorkspaceRuntime(
        acquireDisposable(() => ({ dispose: released })).pipe(Effect.as(parts())),
      ).pipe(Scope.provide(scope)),
    );

    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(released).toHaveBeenCalledOnce();
    await runtime.dispose();
    expect(released).toHaveBeenCalledOnce();
  });
});

function parts() {
  return {} as WorkspaceRuntimeParts;
}

function deferred() {
  let resolve!: () => void;
  let promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
