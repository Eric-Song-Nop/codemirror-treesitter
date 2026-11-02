import {
  defaultOpendalBrowserRuntimeOptions,
  OpendalBrowserError,
  openOpendalBrowserOperator,
  type CreateOpendalBrowserOperatorOptions,
  type OpendalBrowserSource,
  type OpendalExactBrowserOperator,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { Context, Effect, Layer, Predicate } from "effect";
import {
  storageErrorFromOpendal,
  workspaceStorageError,
  type WorkspaceStorageError,
} from "./errors.ts";

type OperatorFactory = (
  source: OpendalBrowserSource,
  options: CreateOpendalBrowserOperatorOptions,
) => Promise<OpendalExactBrowserOperator>;

type OperatorFactoryWindow = Window & {
  __localMdWorkspaceTestDropboxOperatorFactory?: OperatorFactory;
};

/**
 * Opens OpenDAL WASM operators. The browser layer loads the WASM runtime; tests
 * provide fake operators through {@link OpendalOperators.layerFrom}. Callers own
 * the returned operator and must dispose it (the operator hosts do).
 */
export class OpendalOperators extends Context.Service<
  OpendalOperators,
  {
    open(
      source: OpendalBrowserSource,
      options?: CreateOpendalBrowserOperatorOptions,
    ): Effect.Effect<OpendalExactBrowserOperator, WorkspaceStorageError>;
  }
>()("local-md-workspace/OpendalOperators") {
  static layerFrom(factory: OperatorFactory) {
    return Layer.succeed(
      OpendalOperators,
      OpendalOperators.of({
        open: Effect.fn("OpendalOperators.open")((source, options) =>
          Effect.tryPromise({
            catch: operatorOpenError,
            try: () => factory(source, options ?? defaultOpendalBrowserRuntimeOptions()),
          }),
        ),
      }),
    );
  }

  static readonly layer = OpendalOperators.layerFrom((source, options) =>
    (devTestOperatorFactory(source) ?? openOpendalBrowserOperator)(source, options),
  );
}

function operatorOpenError(cause: unknown): WorkspaceStorageError {
  if (cause instanceof OpendalBrowserError) return storageErrorFromOpendal(cause);
  return workspaceStorageError({
    cause,
    code: "unknown",
    message: Predicate.isError(cause) ? cause.message : String(cause),
  });
}

/** Dev-only hook the UI smoke test uses to stand in for Dropbox. */
function devTestOperatorFactory(source: OpendalBrowserSource) {
  if (!import.meta.env.DEV || source.kind != "dropbox" || typeof window == "undefined") return null;
  let factory = (window as OperatorFactoryWindow).__localMdWorkspaceTestDropboxOperatorFactory;
  return Predicate.isFunction(factory) ? factory : null;
}
