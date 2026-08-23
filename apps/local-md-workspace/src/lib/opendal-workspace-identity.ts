import type { OpendalBrowserProvider } from "@codemirror-treesitter/opendal-wasm-browser";

export type OpendalWorkspaceProvider = Extract<
  OpendalBrowserProvider,
  "dropbox" | "gdrive" | "onedrive"
>;

export type OpendalWorkspaceIdentity = {
  id: string;
  kind: "account" | "drive";
};

export function opendalWorkspaceId(
  provider: OpendalWorkspaceProvider,
  root: string | undefined,
  identity?: OpendalWorkspaceIdentity,
) {
  let rootPart = root || "/";
  let identityId = identity?.id.trim();
  if (!identity || !identityId) return `${provider}:${rootPart}`;
  return `${provider}:${identity.kind}:${encodeURIComponent(identityId)}:${rootPart}`;
}

export function sameOpendalWorkspaceIdentity(
  left: OpendalWorkspaceIdentity,
  right: OpendalWorkspaceIdentity,
) {
  return left.kind == right.kind && left.id == right.id;
}
