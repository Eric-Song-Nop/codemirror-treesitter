import {
  OpendalBrowserError,
  type OpendalExactBrowserOperator,
  type OpendalOperatorInfo,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vite-plus/test";
import { WorkspaceAuthRenewalFailed } from "./errors.ts";
import {
  makeRenewableOpendalOperatorHost,
  makeStaticOpendalOperatorHost,
  opendalTransientRetrySchedule,
  type OpendalOperatorHost,
  type RenewableOpendalOperatorHostOptions,
} from "./opendal-operator-host.ts";

describe("makeRenewableOpendalOperatorHost", () => {
  it("renews and replays a read after confirmed authentication expiry", async () => {
    let initial = operator("initial");
    let disposeInitial = vi.spyOn(initial, "dispose");
    let renewed = operator("renewed");
    let renew = vi.fn(async () => renewed);
    let { host } = createHost(initial, renew);

    await expect(
      run(host, {
        execute: async (candidate) => {
          if (candidate === initial) throw authError("read");
          return candidate.info.root;
        },
        operation: "read",
      }),
    ).resolves.toBe("renewed");
    expect(renew).toHaveBeenCalledOnce();
    expect(host.operatorInfo.root).toBe("renewed");
    expect(disposeInitial).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent renewals for the same expired operator", async () => {
    let initial = operator("initial");
    let renewed = operator("renewed");
    let release!: () => void;
    let renew = vi.fn(
      () =>
        new Promise<OpendalExactBrowserOperator>((resolve) => {
          release = () => resolve(renewed);
        }),
    );
    let { host } = createHost(initial, renew);
    let execute = async (candidate: OpendalExactBrowserOperator) => {
      if (candidate === initial) throw authError("read");
      return candidate.info.root;
    };

    let first = run(host, { execute, operation: "read" });
    let second = run(host, { execute, operation: "read" });
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(["renewed", "renewed"]);
    expect(renew).toHaveBeenCalledOnce();
  });

  it("keeps a shared renewal running when one waiting caller is interrupted", async () => {
    let initial = operator("initial");
    let renewed = operator("renewed");
    let release!: () => void;
    let renew = vi.fn(
      () =>
        new Promise<OpendalExactBrowserOperator>((resolve) => {
          release = () => resolve(renewed);
        }),
    );
    let { host } = createHost(initial, renew);
    let execute = async (candidate: OpendalExactBrowserOperator) => {
      if (candidate === initial) throw authError("read");
      return candidate.info.root;
    };

    let interrupted = Effect.runFork(host.run({ execute, operation: "read" }));
    let survivor = run(host, { execute, operation: "read" });
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
    await Effect.runPromise(Fiber.interrupt(interrupted));
    release();

    await expect(survivor).resolves.toBe("renewed");
  });

  it("replays only a conditional mutation confirmed not applied", async () => {
    let initial = operator("initial");
    let renewed = operator("renewed");
    let { host } = createHost(
      initial,
      vi.fn(async () => renewed),
    );
    let calls = 0;

    await expect(
      run(host, {
        execute: async (candidate) => {
          calls += 1;
          if (candidate === initial) throw authError("write", "not-applied");
          return "committed";
        },
        operation: "conditional-mutation",
      }),
    ).resolves.toBe("committed");
    expect(calls).toBe(2);
  });

  it.each([
    ["conditional-mutation", "unknown"],
    ["unconditional-mutation", "not-applied"],
  ] as const)("does not replay a %s with a %s outcome", async (operation, mutationOutcome) => {
    let renew = vi.fn(async () => operator("renewed"));
    let { host } = createHost(operator("initial"), renew);
    let error = authError("write", mutationOutcome);

    await expect(
      run(host, {
        execute: async () => {
          throw error;
        },
        operation,
      }),
    ).rejects.toBe(error);
    expect(renew).not.toHaveBeenCalled();
  });

  it("disposes its operator when its scope closes and rejects later work", async () => {
    let initial = operator("initial");
    let dispose = vi.spyOn(initial, "dispose");
    let { host, scope } = createHost(
      initial,
      vi.fn(async () => operator("renewed")),
    );

    await Effect.runPromise(Scope.close(scope, Exit.void));

    expect(dispose).toHaveBeenCalledOnce();
    await expect(
      run(host, { execute: async () => "unexpected", operation: "read" }),
    ).rejects.toMatchObject({
      _tag: "WorkspaceHostDisposed",
      message: "OpenDAL operator host is disposed.",
    });
  });

  it("does not open a host whose operator failed to open", async () => {
    let exit = await Effect.runPromiseExit(
      Effect.scoped(
        makeRenewableOpendalOperatorHost({
          identity,
          open: Effect.fail("offline" as const),
          renew: Effect.die("unused"),
        }),
      ),
    );
    expect(exit).toMatchObject({ _tag: "Failure" });
  });
});

describe("transient OpenDAL retries", () => {
  it("retries a transient read with backoff on the test clock", async () => {
    let attempts = 0;
    let program = Effect.gen(function* () {
      let host = yield* makeRenewableOpendalOperatorHost({
        identity,
        open: Effect.succeed(operator("cloud")),
        renew: Effect.die("unused"),
      });
      let fiber = yield* Effect.forkChild(
        host.run({
          execute: async () => {
            attempts += 1;
            if (attempts < 3) throw transientError("read");
            return "read";
          },
          operation: "read",
        }),
      );
      // Real time passes, but the retry waits on the (virtual) test clock.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      expect(attempts).toBe(1);
      yield* TestClock.adjust("10 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()));

    await expect(Effect.runPromise(program)).resolves.toBe("read");
    expect(attempts).toBe(3);
  });

  it("gives up after three retries", async () => {
    let attempts = 0;
    let error = transientError("read");
    let program = Effect.gen(function* () {
      let host = yield* makeRenewableOpendalOperatorHost({
        identity,
        open: Effect.succeed(operator("cloud")),
        renew: Effect.die("unused"),
      });
      let fiber = yield* Effect.forkChild(
        host.run({
          execute: async () => {
            attempts += 1;
            throw error;
          },
          operation: "read",
        }),
      );
      yield* TestClock.adjust("1 minute");
      return yield* Fiber.await(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()));

    let exit = await Effect.runPromise(program);
    expect(attempts).toBe(4);
    expect(Exit.isFailure(exit) && Exit.findErrorOption(exit)).toMatchObject({ value: error });
  });

  it.each([
    ["unconditional-mutation", "not-applied"],
    ["conditional-mutation", "unknown"],
  ] as const)("never retries a %s with a %s outcome", async (operation, mutationOutcome) => {
    let attempts = 0;
    let error = transientError("write", mutationOutcome);
    let { host } = createHost(operator("cloud"), async () => operator("renewed"), {
      retrySchedule: opendalTransientRetrySchedule,
    });

    await expect(
      run(host, {
        execute: async () => {
          attempts += 1;
          throw error;
        },
        operation,
      }),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  it("does not retry non-transient failures", async () => {
    let attempts = 0;
    let error = new OpendalBrowserError({
      code: "permission-denied",
      message: "denied",
      operation: "read",
    });
    let { host } = createHost(operator("cloud"), async () => operator("renewed"));

    await expect(
      run(host, {
        execute: async () => {
          attempts += 1;
          throw error;
        },
        operation: "read",
      }),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  });
});

describe("makeStaticOpendalOperatorHost", () => {
  it("waits for in-flight work before releasing the WASM operator", async () => {
    let candidate = operator("local");
    let disposeOperator = vi.spyOn(candidate, "dispose");
    let scope = Scope.makeUnsafe();
    let host = Effect.runSync(
      makeStaticOpendalOperatorHost(
        { id: "workspace", kind: "local", name: "Workspace" },
        Effect.succeed(candidate),
      ).pipe(Scope.provide(scope)),
    );
    let release!: () => void;
    let operation = run(host, {
      execute: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      operation: "read",
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    let disposal = Effect.runPromise(Scope.close(scope, Exit.void));
    await Promise.resolve();
    expect(disposeOperator).not.toHaveBeenCalled();
    release();
    await Promise.all([operation, disposal]);
    expect(disposeOperator).toHaveBeenCalledOnce();
  });

  it("keeps the operator alive for a call whose caller was interrupted", async () => {
    let candidate = operator("local");
    let disposeOperator = vi.spyOn(candidate, "dispose");
    let scope = Scope.makeUnsafe();
    let host = Effect.runSync(
      makeStaticOpendalOperatorHost(identity, Effect.succeed(candidate)).pipe(Scope.provide(scope)),
    );
    let release!: () => void;
    let fiber = Effect.runFork(
      host.run({
        execute: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        operation: "read",
      }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await Effect.runPromise(Fiber.interrupt(fiber));

    let disposal = Effect.runPromise(Scope.close(scope, Exit.void));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(disposeOperator).not.toHaveBeenCalled();
    release();
    await disposal;
    expect(disposeOperator).toHaveBeenCalledOnce();
  });
});

const identity = { id: "workspace", kind: "opendal-dropbox" as const, name: "Workspace" };

function run<T>(
  host: OpendalOperatorHost,
  request: Parameters<OpendalOperatorHost["run"]>[0] & {
    execute: (operator: OpendalExactBrowserOperator) => Promise<T>;
  },
) {
  return Effect.runPromise(host.run(request));
}

function createHost(
  initial: OpendalExactBrowserOperator,
  renew: () => Promise<OpendalExactBrowserOperator>,
  options: RenewableOpendalOperatorHostOptions = { retrySchedule: null },
) {
  let scope = Scope.makeUnsafe();
  let host = Effect.runSync(
    makeRenewableOpendalOperatorHost({
      identity,
      open: Effect.succeed(initial),
      options,
      renew: Effect.tryPromise({ catch: WorkspaceAuthRenewalFailed.fromCause, try: renew }),
    }).pipe(Scope.provide(scope)),
  );
  return { host, scope };
}

function operator(root: string): OpendalExactBrowserOperator {
  return {
    createDirectory: async () => {},
    delete: async () => ({ status: "applied" }),
    dispose: vi.fn(),
    info: operatorInfo(root),
    list: async () => [],
    read: async () => ({ bytes: new Uint8Array(), metadataBinding: "none" }),
    rename: async () => ({ status: "applied" }),
    stat: async (path) => ({ kind: "file", path }),
    write: async () => ({ metadataBinding: "none", status: "applied" }),
  };
}

function operatorInfo(root: string): OpendalOperatorInfo {
  return {
    capabilities: {
      createDirectory: true,
      delete: { recursive: "native", single: true },
      list: true,
      read: true,
      rename: { directory: "native", file: "native" },
      stat: true,
      write: true,
      writeConditions: { ifMatch: false, ifNotExists: true, ifVersion: true },
    },
    root,
    scheme: "dropbox",
  };
}

function authError(operation: "read" | "write", mutationOutcome?: "not-applied" | "unknown") {
  return new OpendalBrowserError({
    code: "authentication-expired",
    message: "expired",
    mutationOutcome,
    operation,
  });
}

function transientError(operation: "read" | "write", mutationOutcome?: "not-applied" | "unknown") {
  return new OpendalBrowserError({
    code: "temporary",
    message: "Dropbox is temporarily unavailable.",
    mutationOutcome,
    operation,
  });
}
