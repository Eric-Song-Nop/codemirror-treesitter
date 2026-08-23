import {
  OpendalBrowserError,
  type OpendalExactBrowserOperator,
  type OpendalOperatorInfo,
} from "@codemirror-treesitter/opendal-wasm-browser";
import type { WorkspaceStorageIdentity } from "./types.ts";

export type OpendalOperationClass = "conditional-mutation" | "read" | "unconditional-mutation";

export interface OpendalOperatorHost {
  readonly identity: WorkspaceStorageIdentity;
  readonly operatorInfo: OpendalOperatorInfo;

  dispose(): Promise<void>;
  run<T>(input: {
    execute: (operator: OpendalExactBrowserOperator) => Promise<T>;
    operation: OpendalOperationClass;
  }): Promise<T>;
}

export class StaticOpendalOperatorHost implements OpendalOperatorHost {
  readonly operatorInfo: OpendalOperatorInfo;
  private disposed = false;
  private disposeRequest: Promise<void> | null = null;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    readonly identity: WorkspaceStorageIdentity,
    private readonly operator: OpendalExactBrowserOperator,
  ) {
    this.operatorInfo = operator.info;
  }

  run<T>(input: {
    execute: (operator: OpendalExactBrowserOperator) => Promise<T>;
    operation: OpendalOperationClass;
  }) {
    if (this.disposed) return Promise.reject(new Error("OpenDAL operator host is disposed."));
    let task = Promise.resolve().then(() => input.execute(this.operator));
    return trackHostOperation(this.inflight, task);
  }

  dispose() {
    if (this.disposeRequest) return this.disposeRequest;
    this.disposed = true;
    this.disposeRequest = (async () => {
      await Promise.allSettled(this.inflight);
      this.operator.dispose();
    })();
    return this.disposeRequest;
  }
}

export class RenewableOpendalOperatorHost implements OpendalOperatorHost {
  private operator: OpendalExactBrowserOperator;
  private renewal: Promise<OpendalExactBrowserOperator> | null = null;
  private disposed = false;
  private disposeRequest: Promise<void> | null = null;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly retired = new Set<OpendalExactBrowserOperator>();

  constructor(
    readonly identity: WorkspaceStorageIdentity,
    operator: OpendalExactBrowserOperator,
    private readonly renew: () => Promise<OpendalExactBrowserOperator>,
  ) {
    this.operator = operator;
  }

  get operatorInfo() {
    return this.operator.info;
  }

  run<T>(input: {
    execute: (operator: OpendalExactBrowserOperator) => Promise<T>;
    operation: OpendalOperationClass;
  }): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("OpenDAL operator host is disposed."));
    let task = this.runActive(input);
    return trackHostOperation(this.inflight, task, () => this.disposeRetiredIfIdle());
  }

  private async runActive<T>(input: {
    execute: (operator: OpendalExactBrowserOperator) => Promise<T>;
    operation: OpendalOperationClass;
  }) {
    let attempted = this.operator;
    try {
      return await input.execute(attempted);
    } catch (error) {
      if (!canRenewAndReplay(error, input.operation)) throw error;
    }

    let renewed = await this.renewOperator(attempted);
    return input.execute(renewed);
  }

  dispose() {
    if (this.disposeRequest) return this.disposeRequest;
    this.disposed = true;
    this.disposeRequest = (async () => {
      await Promise.allSettled(this.inflight);
      this.disposeRetired();
      this.operator.dispose();
    })();
    return this.disposeRequest;
  }

  private async renewOperator(attempted: OpendalExactBrowserOperator) {
    if (this.disposed) throw new Error("OpenDAL operator host is disposed.");
    if (this.operator !== attempted) return this.operator;
    this.renewal ??= this.renew().finally(() => {
      this.renewal = null;
    });
    let renewed = await this.renewal;
    if (this.disposed) {
      renewed.dispose();
      throw new Error("OpenDAL operator host is disposed.");
    }
    if (renewed !== attempted) this.retired.add(attempted);
    this.operator = renewed;
    return this.operator;
  }

  private disposeRetiredIfIdle() {
    if (!this.inflight.size && !this.disposed) this.disposeRetired();
  }

  private disposeRetired() {
    for (let operator of this.retired) operator.dispose();
    this.retired.clear();
  }
}

function canRenewAndReplay(error: unknown, operation: OpendalOperationClass) {
  if (!(error instanceof OpendalBrowserError) || error.code != "authentication-expired") {
    return false;
  }
  if (operation == "read") return true;
  return operation == "conditional-mutation" && error.mutationOutcome == "not-applied";
}

function trackHostOperation<T>(
  inflight: Set<Promise<unknown>>,
  task: Promise<T>,
  afterSettled?: () => void,
) {
  inflight.add(task);
  void task.then(
    () => {
      inflight.delete(task);
      afterSettled?.();
    },
    () => {
      inflight.delete(task);
      afterSettled?.();
    },
  );
  return task;
}
