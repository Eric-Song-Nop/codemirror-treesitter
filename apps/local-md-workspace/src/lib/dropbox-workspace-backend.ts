import type { DropboxAccessToken } from "./dropbox-oauth.ts";
import {
  createOpendalWorkspaceBackend,
  type OpendalOperatorFactory,
  type OpendalWorkspaceIdentity,
} from "./opendal-workspace-backend.ts";
import type { WorkspaceBackend } from "./workspace-backend.ts";

export type DropboxWorkspaceBackendOptions = {
  createOperator?: OpendalOperatorFactory;
  getAccessToken: () => Promise<DropboxAccessToken>;
  identity?: OpendalWorkspaceIdentity;
  name?: string;
  refreshAccessToken: () => Promise<DropboxAccessToken>;
  root?: string;
};

export function createDropboxWorkspaceBackend(
  options: DropboxWorkspaceBackendOptions,
): WorkspaceBackend {
  return createOpendalWorkspaceBackend({
    ...options,
    defaultName: "Dropbox",
    expiredTokenPattern: /expired|expired_access_token|invalid_access_token/i,
    kind: "opendal-dropbox",
    notFoundPattern: /not.?found|not_found|404/i,
    provider: "dropbox",
  });
}
