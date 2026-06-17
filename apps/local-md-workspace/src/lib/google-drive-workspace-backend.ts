import {
  createOpendalWorkspaceBackend,
  type OpendalOperatorFactory,
  type OpendalWorkspaceAccessToken,
  type OpendalWorkspaceIdentity,
} from "./opendal-workspace-backend.ts";
import type { WorkspaceBackend } from "./workspace-backend.ts";

export type GoogleDriveWorkspaceBackendOptions = {
  createOperator?: OpendalOperatorFactory;
  getAccessToken: () => Promise<OpendalWorkspaceAccessToken>;
  identity?: OpendalWorkspaceIdentity;
  name?: string;
  refreshAccessToken: () => Promise<OpendalWorkspaceAccessToken>;
  root?: string;
};

export function createGoogleDriveWorkspaceBackend(
  options: GoogleDriveWorkspaceBackendOptions,
): WorkspaceBackend {
  return createOpendalWorkspaceBackend({
    ...options,
    defaultName: "Google Drive",
    expiredTokenPattern: /expired|invalid_grant|invalid_token|unauthorized|401/i,
    kind: "opendal-gdrive",
    notFoundPattern: /not.?found|not_found|filenotfound|404/i,
    provider: "gdrive",
  });
}
