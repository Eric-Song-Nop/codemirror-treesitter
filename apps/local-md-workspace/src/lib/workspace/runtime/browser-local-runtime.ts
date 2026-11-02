import type { CreateOpendalBrowserOperatorOptions } from "@codemirror-treesitter/opendal-wasm-browser";
import { Context, Effect, Layer, type Scope } from "effect";
import { findWorkspaceFilePathForHandle, type AccessDirectoryHandle } from "../file-system.ts";
import { makeStaticOpendalOperatorHost } from "../storage/opendal-operator-host.ts";
import { OpendalOperators } from "../storage/opendal-operators.ts";
import { OpendalWorkspaceObjectStore } from "../storage/opendal-workspace-object-store.ts";
import type { WorkspaceStorageError } from "../storage/errors.ts";
import { legacyLocalWorkspaceId, localWorkspaceSourceAliases } from "../source-identity.ts";
import { DefaultWorkspaceDocuments } from "../documents/workspace-documents.ts";
import { WorkspaceDocumentChangeMonitor } from "./document-changes.ts";
import { FileSystemPermissionTracker, withLocalPermissionChecks } from "./local-permission.ts";
import { acquireDisposable, makeScopedWorkspaceRuntime } from "./runtime-scope.ts";
import {
  OpendalWorkspaceAssetService,
  OpendalWorkspaceDocumentService,
  OpendalWorkspaceEntryService,
  OpendalWorkspaceTreeService,
} from "./services.ts";
import type { WorkspaceIdentity, WorkspaceRuntime } from "./types.ts";

export type BrowserLocalWorkspaceInput = {
  handle: AccessDirectoryHandle;
  runtimeOptions?: CreateOpendalBrowserOperatorOptions;
  workspaceId?: string;
};

/**
 * Opens a File System Access folder as a scoped workspace runtime. Resources
 * are released in reverse order (documents, change monitor, permission
 * listeners, operator host) when the scope closes or `dispose()` is called.
 */
export const openBrowserLocalWorkspaceRuntime = Effect.fn("openBrowserLocalWorkspaceRuntime")(
  function* (input: BrowserLocalWorkspaceInput) {
    let operators = yield* OpendalOperators;
    let identity: WorkspaceIdentity = {
      id: input.workspaceId ?? legacyLocalWorkspaceId(input.handle.name),
      kind: "local",
      name: input.handle.name || "Workspace",
    };
    identity.sourceAliases = localWorkspaceSourceAliases(input.handle.name, identity.id);

    return yield* makeScopedWorkspaceRuntime(
      Effect.gen(function* () {
        let run = Effect.runPromiseWith(yield* Effect.context<never>());
        let staticHost = yield* makeStaticOpendalOperatorHost(
          identity,
          operators.open(
            { kind: "browser-local", rootHandle: input.handle as FileSystemDirectoryHandle },
            input.runtimeOptions,
          ),
        );
        let permission = yield* acquireDisposable(
          () => new FileSystemPermissionTracker(input.handle),
        );
        void permission.check();
        let store = new OpendalWorkspaceObjectStore(
          withLocalPermissionChecks(staticHost, permission),
        );
        let documentSource = new OpendalWorkspaceDocumentService(store, run);
        let documentChanges = yield* acquireDisposable(
          () =>
            new WorkspaceDocumentChangeMonitor({
              localRoot: input.handle,
              observe: (path) => documentSource.observe(path),
              probe: (path) => run(store.probe(path)),
            }),
        );
        let documents = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new DefaultWorkspaceDocuments({ changes: documentChanges, documentSource, identity }),
          ),
          (documents) => Effect.promise(() => documents.close()),
        );

        return {
          assets: new OpendalWorkspaceAssetService(store, run),
          documentChanges,
          documentSource,
          documents,
          entries: new OpendalWorkspaceEntryService(store, run),
          host: {
            findFilePathForHandle: (handle: unknown) =>
              findWorkspaceFilePathForHandle(input.handle, handle),
            permission,
            queryPermission: () => permission.check(),
          },
          identity,
          tree: new OpendalWorkspaceTreeService(store, identity.name, run),
        };
      }),
    );
  },
);

/** Opens browser-local folder workspaces for the application. */
export class LocalWorkspaceStorage extends Context.Service<
  LocalWorkspaceStorage,
  {
    open(
      input: BrowserLocalWorkspaceInput,
    ): Effect.Effect<WorkspaceRuntime, WorkspaceStorageError, Scope.Scope>;
  }
>()("local-md-workspace/LocalWorkspaceStorage") {
  static readonly layerNoDeps = Layer.effect(
    LocalWorkspaceStorage,
    Effect.gen(function* () {
      let operators = yield* OpendalOperators;
      return LocalWorkspaceStorage.of({
        open: (input) =>
          openBrowserLocalWorkspaceRuntime(input).pipe(
            Effect.provideService(OpendalOperators, operators),
          ),
      });
    }),
  );

  static readonly layer = LocalWorkspaceStorage.layerNoDeps.pipe(
    Layer.provide(OpendalOperators.layer),
  );
}

/** Scoped effect opening a browser-local workspace on the application runtime. */
export const openLocalWorkspace = (input: BrowserLocalWorkspaceInput) =>
  LocalWorkspaceStorage.use((storage) => storage.open(input));
