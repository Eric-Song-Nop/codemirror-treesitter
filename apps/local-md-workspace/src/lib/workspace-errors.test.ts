import { describe, expect, it } from "vite-plus/test";
import { workspaceErrorMessage } from "./workspace-errors.ts";

describe("workspace error messages", () => {
  it("classifies Dropbox OAuth failures", () => {
    expect(workspaceErrorMessage(new Error("Dropbox authorization popup was blocked."))).toBe(
      "Dropbox authorization popup was blocked. Allow popups for this site and try again.",
    );
    expect(
      workspaceErrorMessage(new Error("Dropbox authorization was closed before it completed.")),
    ).toBe("Dropbox authorization was closed before it completed. Reconnect Dropbox to continue.");
    expect(workspaceErrorMessage(new Error("access_denied"))).toBe(
      "Dropbox authorization was denied.",
    );
  });

  it("classifies Dropbox expired-token and revoked-token failures", () => {
    expect(workspaceErrorMessage(new Error("expired_access_token"))).toBe(
      "Dropbox access token expired. Reconnect Dropbox to continue.",
    );
    expect(workspaceErrorMessage(new Error("invalid_access_token"))).toBe(
      "Dropbox authorization is invalid or was revoked. Reconnect Dropbox to continue.",
    );
  });

  it("classifies missing Dropbox file scopes", () => {
    expect(workspaceErrorMessage(new Error("missing_scope/files.content.write"))).toBe(
      "Dropbox app is missing required file permissions: files.metadata.read, files.content.read, files.content.write. Enable those scopes and reconnect Dropbox.",
    );
    expect(workspaceErrorMessage(new Error("not enough permissions for files.metadata.read"))).toBe(
      "Dropbox app is missing required file permissions: files.metadata.read, files.content.read, files.content.write. Enable those scopes and reconnect Dropbox.",
    );
  });

  it("classifies Dropbox token exchange failures", () => {
    expect(workspaceErrorMessage(new Error("invalid_grant"))).toBe(
      "Dropbox token exchange failed. Check the app key and reconnect Dropbox.",
    );
    expect(workspaceErrorMessage(new Error("Dropbox token exchange failed (400)."))).toBe(
      "Dropbox token exchange failed. Check the app key and reconnect Dropbox.",
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
