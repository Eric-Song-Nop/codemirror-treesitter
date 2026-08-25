import { describe, expect, it } from "vite-plus/test";
import {
  isWorkspaceAgentCredentialVaultError,
  WORKSPACE_AGENT_CREDENTIAL_VAULT_ERROR_MESSAGES,
  WorkspaceAgentCredentialVaultError,
  type WorkspaceAgentCredentialVaultErrorCode,
} from "./credential-vault.ts";

describe("WorkspaceAgentCredentialVaultError", () => {
  it("exposes only static typed messages without a cause", () => {
    let codes = Object.keys(
      WORKSPACE_AGENT_CREDENTIAL_VAULT_ERROR_MESSAGES,
    ) as WorkspaceAgentCredentialVaultErrorCode[];

    for (let code of codes) {
      let error = new WorkspaceAgentCredentialVaultError(code);
      expect(error).toMatchObject({
        code,
        message: WORKSPACE_AGENT_CREDENTIAL_VAULT_ERROR_MESSAGES[code],
        name: "WorkspaceAgentCredentialVaultError",
      });
      expect("cause" in error).toBe(false);
      expect(isWorkspaceAgentCredentialVaultError(error)).toBe(true);
    }

    expect(isWorkspaceAgentCredentialVaultError(new Error("storage details"))).toBe(false);
  });
});
