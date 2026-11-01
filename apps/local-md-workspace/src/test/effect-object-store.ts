import { Effect } from "effect";
import type { WorkspaceObjectStore } from "@/lib/workspace/storage/types";

type PromiseMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer S, infer _E, never>
    ? (...args: A) => Promise<S>
    : T[K];
};

/** Promise view of an object store, for tests that await store operations. */
export type PromiseObjectStore = PromiseMethods<WorkspaceObjectStore>;

const storeMethods = [
  "commit",
  "createDirectory",
  "delete",
  "listDirectory",
  "move",
  "probe",
  "read",
] as const;

export function promiseObjectStore(store: WorkspaceObjectStore): PromiseObjectStore {
  let view: Record<string, unknown> = { capabilities: store.capabilities, id: store.id };
  for (let method of storeMethods) {
    view[method] = (...args: unknown[]) =>
      Effect.runPromise(
        (store[method] as (...args: unknown[]) => Effect.Effect<unknown, unknown>)(...args),
      );
  }
  return view as PromiseObjectStore;
}

/**
 * Effect object store over Promise-returning functions, for in-memory stores
 * and mocks. A rejection becomes a defect, so the port facade rejects with the
 * same error.
 */
export function effectObjectStore(store: PromiseObjectStore): WorkspaceObjectStore {
  let view: Record<string, unknown> = {
    get capabilities() {
      return store.capabilities;
    },
    get id() {
      return store.id;
    },
  };
  for (let method of storeMethods) {
    view[method] = (...args: unknown[]) =>
      Effect.promise(() => (store[method] as (...args: unknown[]) => Promise<unknown>)(...args));
  }
  return view as unknown as WorkspaceObjectStore;
}
