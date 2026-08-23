import {
  defaultOpendalBrowserRuntimeOptions,
  openOpendalBrowserOperator,
  type CreateOpendalBrowserOperatorOptions,
  type OpendalBrowserSource,
  type OpendalExactBrowserOperator,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { RenewableOpendalOperatorHost } from "../storage/opendal-operator-host.ts";
import { OpendalWorkspaceObjectStore } from "../storage/opendal-workspace-object-store.ts";
import { ActiveDocumentChangeSource } from "./current-document-changes.ts";
import {
  OpendalWorkspaceAssetService,
  OpendalWorkspaceDocumentService,
  OpendalWorkspaceEntryService,
  OpendalWorkspaceTreeService,
} from "./services.ts";
import type { WorkspaceIdentity, WorkspaceRuntime } from "./types.ts";

type CloudSource = Exclude<OpendalBrowserSource, { kind: "browser-local" }>;
type CloudOperatorFactory = (
  source: CloudSource,
  options: CreateOpendalBrowserOperatorOptions,
) => Promise<OpendalExactBrowserOperator>;

type CloudOperatorFactoryWindow = Window & {
  __localMdWorkspaceTestDropboxOperatorFactory?: CloudOperatorFactory;
};

export async function createCloudWorkspaceRuntime(input: {
  identity: WorkspaceIdentity;
  openOperator?: CloudOperatorFactory;
  renewSource: () => Promise<CloudSource>;
  runtimeOptions?: CreateOpendalBrowserOperatorOptions;
  source: CloudSource;
}): Promise<WorkspaceRuntime> {
  let runtimeOptions = input.runtimeOptions ?? defaultOpendalBrowserRuntimeOptions();
  let open =
    input.openOperator ?? devTestCloudOperatorFactory(input.source) ?? openOpendalBrowserOperator;
  let operator = await open(input.source, runtimeOptions);
  let host = new RenewableOpendalOperatorHost(input.identity, operator, async () =>
    open(await input.renewSource(), runtimeOptions),
  );
  let store = new OpendalWorkspaceObjectStore(host);
  let documents = new OpendalWorkspaceDocumentService(store);
  let currentDocumentChanges = new ActiveDocumentChangeSource({
    intervalMs: 10_000,
    observe: (path) => documents.observe(path),
    probe: (path) => store.probe(path),
  });

  return {
    assets: new OpendalWorkspaceAssetService(store),
    currentDocumentChanges,
    dispose: async () => {
      currentDocumentChanges.dispose();
      await host.dispose();
    },
    documents,
    entries: new OpendalWorkspaceEntryService(store),
    host: {},
    identity: input.identity,
    tree: new OpendalWorkspaceTreeService(store, input.identity.name),
  };
}

function devTestCloudOperatorFactory(source: CloudSource) {
  if (!import.meta.env.DEV || source.kind != "dropbox" || typeof window == "undefined") return null;
  let factory = (window as CloudOperatorFactoryWindow).__localMdWorkspaceTestDropboxOperatorFactory;
  return typeof factory == "function" ? factory : null;
}
