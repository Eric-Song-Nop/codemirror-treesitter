export const WORKSPACE_AGENT_CREDENTIAL_VAULT_ERROR_MESSAGES = {
  "credential-not-found": "No saved Agent credential is available.",
  "crypto-unavailable": "Secure browser cryptography is unavailable.",
  "invalid-api-key": "Enter a valid DeepSeek API key.",
  "invalid-passphrase": "Enter an unlock passphrase.",
  "invalid-record": "The saved Agent credential is invalid.",
  "storage-unavailable": "Secure browser credential storage is unavailable.",
  "unlock-failed": "The saved Agent credential could not be unlocked.",
} as const;

export type WorkspaceAgentCredentialVaultErrorCode =
  keyof typeof WORKSPACE_AGENT_CREDENTIAL_VAULT_ERROR_MESSAGES;

export type WorkspaceAgentCredentialVaultProbe =
  | { readonly status: "empty" }
  | { readonly status: "locked" };

export interface WorkspaceAgentCredentialVault {
  delete(): Promise<void>;
  probe(): Promise<WorkspaceAgentCredentialVaultProbe>;
  save(apiKey: string, passphrase: string): Promise<void>;
  unlock(passphrase: string): Promise<string>;
}

export class WorkspaceAgentCredentialVaultError extends Error {
  readonly code: WorkspaceAgentCredentialVaultErrorCode;

  constructor(code: WorkspaceAgentCredentialVaultErrorCode) {
    super(WORKSPACE_AGENT_CREDENTIAL_VAULT_ERROR_MESSAGES[code]);
    this.name = "WorkspaceAgentCredentialVaultError";
    this.code = code;
  }
}

export function isWorkspaceAgentCredentialVaultError(
  error: unknown,
): error is WorkspaceAgentCredentialVaultError {
  return error instanceof WorkspaceAgentCredentialVaultError;
}
