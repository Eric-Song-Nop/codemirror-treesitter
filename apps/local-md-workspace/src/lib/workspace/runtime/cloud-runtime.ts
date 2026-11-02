import type {
  CreateOpendalBrowserOperatorOptions,
  OpendalBrowserSource,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { Context, Effect, Layer, type Scope } from "effect";
import {
  makeRenewableOpendalOperatorHost,
  type RenewableOpendalOperatorHostOptions,
} from "../storage/opendal-operator-host.ts";
import { OpendalOperators } from "../storage/opendal-operators.ts";
import { OpendalWorkspaceObjectStore } from "../storage/opendal-workspace-object-store.ts";
import { WorkspaceAuthRenewalFailed, type WorkspaceStorageError } from "../storage/errors.ts";
import { DefaultWorkspaceDocuments } from "../documents/workspace-documents.ts";
import { WorkspaceDocumentChangeMonitor } from "./document-changes.ts";
import { acquireDisposable, makeScopedWorkspaceRuntime } from "./runtime-scope.ts";
import {
  OpendalWorkspaceAssetService,
  OpendalWorkspaceDocumentService,
  OpendalWorkspaceEntryService,
  OpendalWorkspaceTreeService,
} from "./services.ts";
import type { WorkspaceIdentity, WorkspaceRuntime } from "./types.ts";

export type CloudSource = Exclude<OpendalBrowserSource, { kind: "browser-local" }>;

export type CloudWorkspaceInput = {
  host?: RenewableOpendalOperatorHostOptions;
  identity: WorkspaceIdentity;
  /** Produces fresh credentials after the provider rejected the current ones. */
  renewSource: Effect.Effect<CloudSource, WorkspaceAuthRenewalFailed>;
  runtimeOptions?: CreateOpendalBrowserOperatorOptions;
  source: CloudSource;
};

/**
 * Opens a cloud (OpenDAL) workspace as a scoped runtime. Operator calls renew
 * expired credentials once and retry transient failures with a bounded
 * schedule (see `makeRenewableOpendalOperatorHost`).
 */
export const openCloudWorkspaceRuntime = Effect.fn("openCloudWorkspaceRuntime")(function* (
  input: CloudWorkspaceInput,
) {
  let operators = yield* OpendalOperators;
  return yield* makeScopedWorkspaceRuntime(
    Effect.gen(function* () {
      let run = Effect.runPromiseWith(yield* Effect.context<never>());
      let host = yield* makeRenewableOpendalOperatorHost({
        identity: input.identity,
        open: operators.open(input.source, input.runtimeOptions),
        options: input.host,
        renew: input.renewSource.pipe(
          Effect.flatMap((source) =>
            operators
              .open(source, input.runtimeOptions)
              .pipe(Effect.mapError(WorkspaceAuthRenewalFailed.fromCause)),
          ),
        ),
      });
      let store = new OpendalWorkspaceObjectStore(host);
      let documentSource = new OpendalWorkspaceDocumentService(store, run);
      let documentChanges = yield* acquireDisposable(
        () =>
          new WorkspaceDocumentChangeMonitor({
            intervalMs: 10_000,
            observe: (path) => documentSource.observe(path),
            probe: (path) => run(store.probe(path)),
          }),
      );
      let documents = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new DefaultWorkspaceDocuments({
              changes: documentChanges,
              documentSource,
              identity: input.identity,
            }),
        ),
        (documents) => Effect.promise(() => documents.close()),
      );

      return {
        assets: new OpendalWorkspaceAssetService(store, run),
        documentChanges,
        documentSource,
        documents,
        entries: new OpendalWorkspaceEntryService(store, run),
        host: {},
        identity: input.identity,
        tree: new OpendalWorkspaceTreeService(store, input.identity.name, run),
      };
    }),
  );
});

/** Opens cloud (OpenDAL) workspaces for the application. */
export class CloudWorkspaceStorage extends Context.Service<
  CloudWorkspaceStorage,
  {
    open(
      input: CloudWorkspaceInput,
    ): Effect.Effect<WorkspaceRuntime, WorkspaceStorageError, Scope.Scope>;
  }
>()("local-md-workspace/CloudWorkspaceStorage") {
  static readonly layerNoDeps = Layer.effect(
    CloudWorkspaceStorage,
    Effect.gen(function* () {
      let operators = yield* OpendalOperators;
      return CloudWorkspaceStorage.of({
        open: (input) =>
          openCloudWorkspaceRuntime(input).pipe(Effect.provideService(OpendalOperators, operators)),
      });
    }),
  );

  static readonly layer = CloudWorkspaceStorage.layerNoDeps.pipe(
    Layer.provide(OpendalOperators.layer),
  );
}
