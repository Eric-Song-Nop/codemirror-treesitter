import {
  OpendalBrowserError,
  type OpendalExactBrowserOperator,
  type OpendalOperatorInfo,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  RenewableOpendalOperatorHost,
  StaticOpendalOperatorHost,
} from "./opendal-operator-host.ts";

describe("RenewableOpendalOperatorHost", () => {
  it("renews and replays a read after confirmed authentication expiry", async () => {
    let initial = operator("initial");
    let disposeInitial = vi.spyOn(initial, "dispose");
    let renewed = operator("renewed");
    let renew = vi.fn(async () => renewed);
    let host = createHost(initial, renew);

    await expect(
      host.run({
        execute: async (operator) => {
          if (operator === initial) throw authError("read");
          return operator.info.root;
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
    let host = createHost(initial, renew);
    let execute = async (candidate: OpendalExactBrowserOperator) => {
      if (candidate === initial) throw authError("read");
      return candidate.info.root;
    };

    let first = host.run({ execute, operation: "read" });
    let second = host.run({ execute, operation: "read" });
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(["renewed", "renewed"]);
    expect(renew).toHaveBeenCalledOnce();
  });

  it("replays only a conditional mutation confirmed not applied", async () => {
    let initial = operator("initial");
    let renewed = operator("renewed");
    let host = createHost(
      initial,
      vi.fn(async () => renewed),
    );
    let calls = 0;

    await expect(
      host.run({
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
    let host = createHost(operator("initial"), renew);
    let error = authError("write", mutationOutcome);

    await expect(
      host.run({
        execute: async () => {
          throw error;
        },
        operation,
      }),
    ).rejects.toBe(error);
    expect(renew).not.toHaveBeenCalled();
  });

  it("disposes its operator and rejects later work", async () => {
    let initial = operator("initial");
    let dispose = vi.spyOn(initial, "dispose");
    let host = createHost(
      initial,
      vi.fn(async () => operator("renewed")),
    );

    await host.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    await expect(
      host.run({ execute: async () => "unexpected", operation: "read" }),
    ).rejects.toThrow("disposed");
  });
});

describe("StaticOpendalOperatorHost", () => {
  it("waits for in-flight work before releasing the WASM operator", async () => {
    let candidate = operator("local");
    let disposeOperator = vi.spyOn(candidate, "dispose");
    let host = new StaticOpendalOperatorHost(
      { id: "workspace", kind: "local", name: "Workspace" },
      candidate,
    );
    let release!: () => void;
    let operation = host.run({
      execute: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      operation: "read",
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    let disposal = host.dispose();
    await Promise.resolve();
    expect(disposeOperator).not.toHaveBeenCalled();
    release();
    await Promise.all([operation, disposal]);
    expect(disposeOperator).toHaveBeenCalledOnce();
  });
});

function createHost(
  initial: OpendalExactBrowserOperator,
  renew: () => Promise<OpendalExactBrowserOperator>,
) {
  return new RenewableOpendalOperatorHost(
    { id: "workspace", kind: "opendal-dropbox", name: "Workspace" },
    initial,
    renew,
  );
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
