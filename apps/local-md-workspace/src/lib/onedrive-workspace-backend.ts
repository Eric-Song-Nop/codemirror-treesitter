import {
  createOpendalWorkspaceBackend,
  type OpendalOperatorFactory,
  type OpendalWorkspaceAccessToken,
  type OpendalWorkspaceIdentity,
} from "./opendal-workspace-backend.ts";
import type { WorkspaceBackend } from "./workspace-backend.ts";

export type OneDriveWorkspaceBackendOptions = {
  createOperator?: OpendalOperatorFactory;
  getAccessToken: () => Promise<OpendalWorkspaceAccessToken>;
  identity?: OpendalWorkspaceIdentity;
  name?: string;
  refreshAccessToken: () => Promise<OpendalWorkspaceAccessToken>;
  root?: string;
};

export function createOneDriveWorkspaceBackend(
  options: OneDriveWorkspaceBackendOptions,
): WorkspaceBackend {
  return createOpendalWorkspaceBackend({
    ...options,
    defaultName: "OneDrive",
    expiredTokenPattern:
      /expired|invalid_grant|invalid_token|invalidauthenticationtoken|unauthorized|401/i,
    kind: "opendal-onedrive",
    notFoundPattern: /not.?found|not_found|itemnotfound|404/i,
    provider: "onedrive",
  });
}
