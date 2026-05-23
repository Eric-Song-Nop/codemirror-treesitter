export { LSPClient, WorkspaceMapping } from "./client.js";
export type { LSPClientConfig, LSPClientExtension, Transport } from "./client.js";
export { LSPPlugin } from "./plugin.js";
export { Workspace } from "./workspace.js";
export type { WorkspaceFile } from "./workspace.js";
export { serverCompletion, serverCompletionSource } from "./completion.js";
export { hoverTooltips } from "./hover.js";
export { formatDocument, formatKeymap } from "./formatting.js";
export { renameSymbol, renameKeymap } from "./rename.js";
export {
  signatureHelp,
  nextSignature,
  prevSignature,
  showSignatureHelp,
  signatureKeymap,
} from "./signature.js";
export {
  jumpToDefinition,
  jumpToDeclaration,
  jumpToTypeDefinition,
  jumpToImplementation,
  jumpToDefinitionKeymap,
} from "./definition.js";
export { findReferences, closeReferencePanel, findReferencesKeymap } from "./references.js";
export { serverDiagnostics } from "./diagnostics.js";

import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { LSPClient, type LSPClientExtension } from "./client.js";
import { LSPPlugin } from "./plugin.js";
import { serverCompletion } from "./completion.js";
import { hoverTooltips } from "./hover.js";
import { formatKeymap } from "./formatting.js";
import { renameKeymap } from "./rename.js";
import { signatureHelp } from "./signature.js";
import { jumpToDefinitionKeymap } from "./definition.js";
import { findReferencesKeymap } from "./references.js";
import { serverDiagnostics } from "./diagnostics.js";

/// Returns an extension that enables the [LSP
/// plugin](#lsp-client.LSPPlugin) as well as LSP based
/// autocompletion, hover tooltips, and signature help, along with the
/// keymaps for reformatting, renaming symbols, jumping to definition,
/// and finding references.
///
/// This function is deprecated. Prefer to directly use
/// [`LSPPlugin.create`](#lsp-client.LSPPlugin^create) and either add
/// the extensions you need directly, or configure them in the client
/// via [`languageServerExtensions`](#lsp-client.languageServerExtensions).
export function languageServerSupport(
  client: LSPClient,
  uri: string,
  languageID?: string,
): Extension {
  return [
    LSPPlugin.create(client, uri, languageID),
    serverCompletion(),
    hoverTooltips(),
    keymap.of([
      ...formatKeymap,
      ...renameKeymap,
      ...jumpToDefinitionKeymap,
      ...findReferencesKeymap,
    ]),
    signatureHelp(),
  ];
}

/// This function bundles all the extensions defined in this package,
/// in a way that can be passed to the
/// [`extensions`](#lsp-client.LSPClientConfig.extensions) option to
/// `LSPClient`.
export function languageServerExtensions(): readonly (Extension | LSPClientExtension)[] {
  return [
    serverCompletion(),
    hoverTooltips(),
    keymap.of([
      ...formatKeymap,
      ...renameKeymap,
      ...jumpToDefinitionKeymap,
      ...findReferencesKeymap,
    ]),
    signatureHelp(),
    serverDiagnostics(),
  ];
}
