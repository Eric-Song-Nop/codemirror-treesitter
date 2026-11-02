import { describe, expect, it } from "vite-plus/test";
import { workspaceErrorMessage } from "./errors.ts";
import { OAuthAuthorizationError, WorkspaceAccountChanged } from "./providers/oauth-errors.ts";
import {
  WorkspaceAuthRenewalFailed,
  WorkspaceMutationNotApplied,
  WorkspaceUnsupportedImage,
  isWorkspaceStorageError,
  workspaceStorageError,
} from "./storage/errors.ts";
import { translateKnownMessage } from "../i18n.tsx";

describe("typed workspace errors", () => {
  it("keeps the code and retryable contract on every storage error", () => {
    let cases = [
      ["permission-denied", "WorkspacePermissionDenied", false],
      ["authentication-expired", "WorkspaceAuthExpired", false],
      ["already-exists", "WorkspaceConflict", false],
      ["condition-failed", "WorkspaceConflict", false],
      ["rate-limited", "WorkspaceTransientFailure", true],
      ["temporary", "WorkspaceTransientFailure", true],
      ["unsupported", "WorkspaceUnsupported", false],
      ["unknown", "WorkspaceStorageFailure", false],
    ] as const;
    for (let [code, tag, retryable] of cases) {
      let error = workspaceStorageError({ code, message: code });
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ _tag: tag, code, message: code, retryable });
      expect(isWorkspaceStorageError(error)).toBe(true);
    }
    expect(isWorkspaceStorageError(new Error("plain"))).toBe(false);
  });

  it("maps typed OAuth errors through the existing message table", () => {
    let blocked = new OAuthAuthorizationError({
      message: "Dropbox authorization popup was blocked.",
      provider: "Dropbox",
      reason: "popup-blocked",
    });
    expect(workspaceErrorMessage(blocked)).toBe(
      "Dropbox authorization popup was blocked. Allow popups for this site and try again.",
    );
  });

  it("maps a failed credential renewal to the provider error behind it", () => {
    let renewal = WorkspaceAuthRenewalFailed.fromCause(
      new OAuthAuthorizationError({
        message: "Dropbox authorization was closed before it completed.",
        provider: "Dropbox",
        reason: "closed",
      }),
    );
    expect(workspaceErrorMessage(renewal)).toBe(
      "Dropbox authorization was closed before it completed. Reconnect Dropbox workspace to continue.",
    );
    expect(
      workspaceErrorMessage(
        WorkspaceAuthRenewalFailed.fromCause(
          new WorkspaceAccountChanged({
            message: "Dropbox account changed. Reconnect Dropbox workspace to continue.",
            provider: "Dropbox",
          }),
        ),
      ),
    ).toBe("Dropbox account changed. Reconnect Dropbox workspace to continue.");
  });

  it("keeps port failure messages that the i18n catalog localizes", () => {
    let t = ((key: string, values?: Record<string, string>) =>
      `${key}${values ? JSON.stringify(values) : ""}`) as Parameters<
      typeof translateKnownMessage
    >[1];
    let image = new WorkspaceUnsupportedImage({
      message: "photo.heic is not a supported image.",
      name: "photo.heic",
    });
    expect(translateKnownMessage(workspaceErrorMessage(image), t)).toBe(
      'errors.unsupportedImage{"name":"photo.heic"}',
    );
    expect(WorkspaceMutationNotApplied.forStatus("notes/a.md", "conflict").message).toBe(
      "Workspace mutation for notes/a.md ended with conflict.",
    );
  });
});

describe("workspace error messages", () => {
  it("distinguishes Dropbox write conflicts from missing paths", () => {
    expect(
      workspaceErrorMessage(
        new Error("Dropbox no-clobber conflict: 409 Conflict: path/conflict/file/already_exists"),
      ),
    ).toBe("A file already exists at that Dropbox path. Choose another name.");
    expect(
      workspaceErrorMessage(
        new Error("Dropbox revision conflict: 409 Conflict: path/conflict/file/rev_mismatch"),
      ),
    ).toBe("This Dropbox file changed elsewhere. Reload it before saving again.");
    expect(workspaceErrorMessage(new Error("Dropbox API error 409 Conflict: path/not_found"))).toBe(
      "Dropbox app folder or workspace path is no longer available. Check the Dropbox app folder setting, then reconnect Dropbox workspace.",
    );
  });

  it("classifies Dropbox OAuth failures", () => {
    expect(workspaceErrorMessage(new Error("Dropbox authorization popup was blocked."))).toBe(
      "Dropbox authorization popup was blocked. Allow popups for this site and try again.",
    );
    expect(
      workspaceErrorMessage(new Error("Dropbox authorization was closed before it completed.")),
    ).toBe(
      "Dropbox authorization was closed before it completed. Reconnect Dropbox workspace to continue.",
    );
    expect(workspaceErrorMessage(new Error("access_denied"))).toBe(
      "Dropbox authorization was denied.",
    );
  });

  it("classifies OneDrive OAuth failures", () => {
    expect(workspaceErrorMessage(new Error("OneDrive authorization popup was blocked."))).toBe(
      "OneDrive authorization popup was blocked. Allow popups for this site and try again.",
    );
    expect(
      workspaceErrorMessage(new Error("OneDrive authorization was closed before it completed.")),
    ).toBe(
      "OneDrive authorization was closed before it completed. Reconnect OneDrive workspace to continue.",
    );
    expect(workspaceErrorMessage(new Error("OneDrive authorization failed: access_denied"))).toBe(
      "OneDrive authorization was denied.",
    );
  });

  it("classifies Google Drive OAuth failures", () => {
    expect(workspaceErrorMessage(new Error("Google Drive authorization popup was blocked."))).toBe(
      "Google Drive authorization popup was blocked. Allow popups for this site and try again.",
    );
    expect(
      workspaceErrorMessage(
        new Error("Google Drive authorization timed out. Reconnect Google Drive workspace."),
      ),
    ).toBe(
      "Google Drive authorization was closed before it completed. Reconnect Google Drive workspace to continue.",
    );
    expect(
      workspaceErrorMessage(new Error("Google Drive authorization failed: access_denied")),
    ).toBe(
      "Google Drive authorization was denied or blocked by Google OAuth app settings. If this is a development app, add your Google account as a test user and check the Drive scope before reconnecting.",
    );
    expect(
      workspaceErrorMessage(new Error("Google Drive authorization failed: org_internal")),
    ).toBe(
      "Google Drive authorization was denied or blocked by Google OAuth app settings. If this is a development app, add your Google account as a test user and check the Drive scope before reconnecting.",
    );
  });

  it("classifies Dropbox expired-token and revoked-token failures", () => {
    expect(workspaceErrorMessage(new Error("expired_access_token"))).toBe(
      "Dropbox access token expired. Reconnect Dropbox workspace to continue.",
    );
    expect(workspaceErrorMessage(new Error("invalid_access_token"))).toBe(
      "Dropbox authorization is invalid or was revoked. Reconnect Dropbox workspace to continue.",
    );
  });

  it("classifies OneDrive expired-token and revoked-token failures", () => {
    expect(workspaceErrorMessage(new Error("OneDrive expired_access_token"))).toBe(
      "OneDrive access token expired. Reconnect OneDrive workspace to continue.",
    );
    expect(workspaceErrorMessage(new Error("OneDrive InvalidAuthenticationToken"))).toBe(
      "OneDrive authorization is invalid or was revoked. Reconnect OneDrive workspace to continue.",
    );
  });

  it("classifies Google Drive expired-token and revoked-token failures", () => {
    expect(workspaceErrorMessage(new Error("Google Drive expired_access_token"))).toBe(
      "Google Drive access token expired. Reconnect Google Drive workspace to continue.",
    );
    expect(workspaceErrorMessage(new Error("Google Drive invalid_token"))).toBe(
      "Google Drive authorization is invalid or was revoked. Reconnect Google Drive workspace to continue.",
    );
  });

  it("classifies missing Dropbox file scopes", () => {
    expect(workspaceErrorMessage(new Error("missing_scope/files.content.write"))).toBe(
      "Dropbox app is missing required file permissions: files.metadata.read, files.content.read, files.content.write. Enable those scopes and reconnect Dropbox workspace.",
    );
    expect(workspaceErrorMessage(new Error("not enough permissions for files.metadata.read"))).toBe(
      "Dropbox app is missing required file permissions: files.metadata.read, files.content.read, files.content.write. Enable those scopes and reconnect Dropbox workspace.",
    );
  });

  it("classifies missing OneDrive file scopes", () => {
    expect(workspaceErrorMessage(new Error("OneDrive missing scope Files.ReadWrite"))).toBe(
      "OneDrive app is missing required file permissions: Files.ReadWrite. Enable those scopes and reconnect OneDrive workspace.",
    );
    expect(workspaceErrorMessage(new Error("OneDrive insufficient privileges"))).toBe(
      "OneDrive app is missing required file permissions: Files.ReadWrite. Enable those scopes and reconnect OneDrive workspace.",
    );
  });

  it("classifies missing Google Drive file scopes", () => {
    expect(
      workspaceErrorMessage(
        new Error("Google Drive missing scope https://www.googleapis.com/auth/drive.file"),
      ),
    ).toBe(
      "Google Drive app is missing required file permissions: https://www.googleapis.com/auth/drive.file. Enable those scopes and reconnect Google Drive workspace.",
    );
    expect(workspaceErrorMessage(new Error("Google Drive insufficient permissions"))).toBe(
      "Google Drive app is missing required file permissions: https://www.googleapis.com/auth/drive.file. Enable those scopes and reconnect Google Drive workspace.",
    );
  });

  it("classifies Dropbox token exchange failures", () => {
    expect(workspaceErrorMessage(new Error("invalid_grant"))).toBe(
      "Dropbox token exchange failed. Check the app key and reconnect Dropbox workspace.",
    );
    expect(workspaceErrorMessage(new Error("Dropbox token exchange failed (400)."))).toBe(
      "Dropbox token exchange failed. Check the app key and reconnect Dropbox workspace.",
    );
  });

  it("classifies OneDrive token exchange failures", () => {
    expect(workspaceErrorMessage(new Error("OneDrive token exchange failed: invalid_grant"))).toBe(
      "OneDrive token exchange failed. Check the client ID and reconnect OneDrive workspace.",
    );
    expect(workspaceErrorMessage(new Error("OneDrive token exchange failed (400)."))).toBe(
      "OneDrive token exchange failed. Check the client ID and reconnect OneDrive workspace.",
    );
  });

  it("classifies Google Drive token exchange failures", () => {
    expect(
      workspaceErrorMessage(new Error("Google Drive token exchange failed: invalid_grant")),
    ).toBe(
      "Google Drive token exchange failed. Check the client ID and reconnect Google Drive workspace.",
    );
    expect(workspaceErrorMessage(new Error("Google Drive token exchange failed (400)."))).toBe(
      "Google Drive token exchange failed. Check the client ID and reconnect Google Drive workspace.",
    );
  });

  it("classifies Google Drive token client configuration failures", () => {
    expect(
      workspaceErrorMessage(new Error("Google Drive token request failed: invalid_client")),
    ).toBe(
      "Google Drive authorization failed. Check the Web client ID, authorized JavaScript origin, and OAuth consent screen, then reconnect Google Drive workspace.",
    );
    expect(workspaceErrorMessage(new Error("Google Drive Identity Services failed to load."))).toBe(
      "Google Drive authorization failed. Check the Web client ID, authorized JavaScript origin, and OAuth consent screen, then reconnect Google Drive workspace.",
    );
  });

  it("classifies unavailable Dropbox app folders and workspace paths", () => {
    expect(
      workspaceErrorMessage(new Error("OpenDAL Dropbox API error 409 Conflict: path/not_found")),
    ).toBe(
      "Dropbox app folder or workspace path is no longer available. Check the Dropbox app folder setting, then reconnect Dropbox workspace.",
    );
    expect(
      workspaceErrorMessage(
        new Error("POST https://api.dropboxapi.com/2/files/list_folder 409 Conflict"),
      ),
    ).toBe(
      "Dropbox app folder or workspace path is no longer available. Check the Dropbox app folder setting, then reconnect Dropbox workspace.",
    );
  });

  it("classifies unavailable OneDrive workspace paths", () => {
    expect(workspaceErrorMessage(new Error("OpenDAL OneDrive API error 404 itemNotFound"))).toBe(
      "OneDrive workspace path is no longer available. Check the OneDrive root setting, then reconnect OneDrive workspace.",
    );
    expect(
      workspaceErrorMessage(new Error("GET https://graph.microsoft.com/v1.0/me/drive 404")),
    ).toBe(
      "OneDrive workspace path is no longer available. Check the OneDrive root setting, then reconnect OneDrive workspace.",
    );
  });

  it("classifies unavailable Google Drive workspace paths", () => {
    expect(
      workspaceErrorMessage(new Error("OpenDAL Google Drive API error 404 file not found")),
    ).toBe(
      "Grove Google Drive workspace is no longer available. Reconnect Google Drive workspace; this app can only access files it creates or that Google Drive grants to it.",
    );
    expect(
      workspaceErrorMessage(new Error("GET https://www.googleapis.com/drive/v3/files/root 404")),
    ).toBe(
      "Grove Google Drive workspace is no longer available. Reconnect Google Drive workspace; this app can only access files it creates or that Google Drive grants to it.",
    );
  });

  it("classifies unsupported backend operations and preserves unknown errors", () => {
    expect(
      workspaceErrorMessage(
        new Error("OpenDAL backend does not support native rename or copy fallback."),
      ),
    ).toBe("This storage backend does not support that operation.");
    expect(workspaceErrorMessage(new Error("Something else"))).toBe("Something else");
  });
});
