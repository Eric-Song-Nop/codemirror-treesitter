import { describe, expect, it } from "vite-plus/test";
import { workspaceErrorMessage } from "./workspace-errors.ts";

describe("workspace error messages", () => {
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

  it("classifies unsupported backend operations and preserves unknown errors", () => {
    expect(
      workspaceErrorMessage(
        new Error("OpenDAL backend does not support native rename or copy fallback."),
      ),
    ).toBe("This storage backend does not support that operation.");
    expect(workspaceErrorMessage(new Error("Something else"))).toBe("Something else");
  });
});
