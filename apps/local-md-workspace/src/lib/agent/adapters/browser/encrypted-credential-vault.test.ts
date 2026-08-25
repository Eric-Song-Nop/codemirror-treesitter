import { describe, expect, it } from "vite-plus/test";
import {
  WORKSPACE_AGENT_CREDENTIAL_VAULT_ERROR_MESSAGES,
  WorkspaceAgentCredentialVaultError,
  type WorkspaceAgentCredentialVaultErrorCode,
} from "../../application/credential-vault.ts";
import {
  createEncryptedWorkspaceAgentCredentialVault,
  WORKSPACE_AGENT_CREDENTIAL_VAULT_DATABASE_NAME,
  WORKSPACE_AGENT_CREDENTIAL_VAULT_DATABASE_VERSION,
  WORKSPACE_AGENT_CREDENTIAL_VAULT_PBKDF2_ITERATIONS,
  type WorkspaceAgentCredentialRecordReadResult,
  type WorkspaceAgentCredentialRecordStorage,
  type WorkspaceAgentCredentialVaultCrypto,
} from "./encrypted-credential-vault.ts";

const secret = "sk-vault-test-secret-value";
const replacementSecret = "sk-vault-replacement-secret";
const passphrase = "correct horse battery staple";
const webCrypto = globalThis.crypto as WorkspaceAgentCredentialVaultCrypto;

describe("encrypted Workspace Agent credential vault", () => {
  it("uses a dedicated versioned browser database", () => {
    expect(WORKSPACE_AGENT_CREDENTIAL_VAULT_DATABASE_NAME).toBe("grove-agent-credentials");
    expect(WORKSPACE_AGENT_CREDENTIAL_VAULT_DATABASE_VERSION).toBe(1);
  });

  it("round-trips and atomically replaces a credential", async () => {
    let storage = new MemoryCredentialRecordStorage();
    let vault = createVault(storage);

    expect(await vault.probe()).toEqual({ status: "empty" });
    await vault.save(`  ${secret}  `, passphrase);
    expect(await vault.probe()).toEqual({ status: "locked" });
    expect(await vault.unlock(passphrase)).toBe(secret);

    await vault.save(replacementSecret, passphrase);
    expect(await vault.unlock(passphrase)).toBe(replacementSecret);
  });

  it("uses fresh salt, IV, and ciphertext without persisting plaintext", async () => {
    let storage = new MemoryCredentialRecordStorage();
    let vault = createVault(storage);

    await vault.save(secret, passphrase);
    let first = await storedRecord(storage);
    await vault.save(secret, passphrase);
    let second = await storedRecord(storage);

    expect([...first.keyDerivation.salt]).not.toEqual([...second.keyDerivation.salt]);
    expect([...first.initializationVector]).not.toEqual([...second.initializationVector]);
    expect([...first.ciphertext]).not.toEqual([...second.ciphertext]);
    expect(first.keyDerivation.salt).toHaveLength(16);
    expect(first.initializationVector).toHaveLength(12);
    expect(first.keyDerivation.iterations).toBe(600_000);
    expect(recordContains(first, secret)).toBe(false);
    expect(recordContains(first, passphrase)).toBe(false);
    expect(JSON.stringify(first)).not.toContain(secret);
    expect(JSON.stringify(first)).not.toContain(passphrase);
  });

  it("does not distinguish a wrong passphrase from authenticated-ciphertext tampering", async () => {
    let storage = new MemoryCredentialRecordStorage();
    let vault = createVault(storage);
    await vault.save(secret, passphrase);

    await expectVaultError(() => vault.unlock("wrong passphrase"), "unlock-failed", [
      secret,
      "wrong passphrase",
    ]);

    let tampered = await storedRecord(storage);
    tampered.ciphertext[0] ^= 1;
    storage.seed(tampered);
    await expectVaultError(() => vault.unlock(passphrase), "unlock-failed", [secret, passphrase]);
  });

  it("strictly rejects unknown versions, algorithms, parameters, and oversized fields", async () => {
    let storage = new MemoryCredentialRecordStorage();
    let vault = createVault(storage);
    await vault.save(secret, passphrase);
    let valid = await storedRecord(storage);
    let invalidRecords: unknown[] = [
      { ...valid, schemaVersion: 2 },
      { ...valid, cipher: "AES-CBC-256" },
      {
        ...valid,
        keyDerivation: {
          ...valid.keyDerivation,
          iterations: WORKSPACE_AGENT_CREDENTIAL_VAULT_PBKDF2_ITERATIONS + 1,
        },
      },
      {
        ...valid,
        keyDerivation: { ...valid.keyDerivation, salt: new Uint8Array(17) },
      },
      { ...valid, initializationVector: new Uint8Array(13) },
      { ...valid, ciphertext: new Uint8Array(4_096 + 16 + 1) },
      { ...valid, unexpected: true },
    ];

    for (let record of invalidRecords) {
      storage.seed(record);
      await expectVaultError(() => vault.probe(), "invalid-record");
    }
  });

  it("maps storage failures to a static error without retaining details", async () => {
    let storageErrorSecret = "storage-backend-secret-detail";
    let failingReadStorage: WorkspaceAgentCredentialRecordStorage = {
      delete: async () => {},
      read: async () => {
        throw new Error(storageErrorSecret);
      },
      write: async () => {},
    };
    await expectVaultError(() => createVault(failingReadStorage).probe(), "storage-unavailable", [
      storageErrorSecret,
    ]);

    let failingWriteStorage: WorkspaceAgentCredentialRecordStorage = {
      delete: async () => {},
      read: async () => ({ status: "empty" }),
      write: async () => {
        throw new Error(storageErrorSecret);
      },
    };
    await expectVaultError(
      () => createVault(failingWriteStorage).save(secret, passphrase),
      "storage-unavailable",
      [secret, passphrase, storageErrorSecret],
    );
  });

  it("fails closed when secure storage or cryptography is unavailable", async () => {
    let storage = new MemoryCredentialRecordStorage();
    let withoutCrypto = createEncryptedWorkspaceAgentCredentialVault({
      crypto: null,
      storage,
    });
    await expectVaultError(() => withoutCrypto.save(secret, passphrase), "crypto-unavailable", [
      secret,
      passphrase,
    ]);
    expect(await storage.read()).toEqual({ status: "empty" });

    let withoutStorage = createEncryptedWorkspaceAgentCredentialVault({
      crypto: webCrypto,
      storage: null,
    });
    await expectVaultError(() => withoutStorage.probe(), "storage-unavailable");
    await expectVaultError(() => withoutStorage.delete(), "storage-unavailable");
  });

  it("rejects invalid credential and passphrase inputs before persistence", async () => {
    let storage = new MemoryCredentialRecordStorage();
    let vault = createVault(storage);

    await expectVaultError(() => vault.save("   ", passphrase), "invalid-api-key");
    await expectVaultError(() => vault.save(secret, "too short"), "invalid-passphrase");
    await expectVaultError(() => vault.unlock("too short"), "invalid-passphrase");
    expect(await storage.read()).toEqual({ status: "empty" });
  });

  it("deletes the saved credential and reports an empty vault", async () => {
    let storage = new MemoryCredentialRecordStorage();
    let vault = createVault(storage);
    await vault.save(secret, passphrase);

    await vault.delete();

    expect(await vault.probe()).toEqual({ status: "empty" });
    await expectVaultError(() => vault.unlock(passphrase), "credential-not-found", [passphrase]);
  });
});

function createVault(storage: WorkspaceAgentCredentialRecordStorage) {
  return createEncryptedWorkspaceAgentCredentialVault({ crypto: webCrypto, storage });
}

class MemoryCredentialRecordStorage implements WorkspaceAgentCredentialRecordStorage {
  private value: unknown = missingRecord;

  async delete() {
    this.value = missingRecord;
  }

  async read(): Promise<WorkspaceAgentCredentialRecordReadResult> {
    return this.value === missingRecord
      ? { status: "empty" }
      : { status: "stored", value: structuredClone(this.value) };
  }

  async write(value: unknown) {
    this.value = structuredClone(value);
  }

  seed(value: unknown) {
    this.value = structuredClone(value);
  }
}

const missingRecord = Symbol("missing credential record");

type TestStoredRecord = {
  cipher: string;
  ciphertext: Uint8Array;
  initializationVector: Uint8Array;
  keyDerivation: {
    algorithm: string;
    iterations: number;
    salt: Uint8Array;
  };
  schemaVersion: number;
};

function storedRecord(storage: MemoryCredentialRecordStorage) {
  let result = storage.read();
  return result.then((stored) => {
    if (stored.status != "stored") throw new Error("Expected a stored credential record.");
    return stored.value as TestStoredRecord;
  });
}

function recordContains(record: TestStoredRecord, value: string) {
  let target = new TextEncoder().encode(value);
  return [record.ciphertext, record.initializationVector, record.keyDerivation.salt].some((bytes) =>
    containsBytes(bytes, target),
  );
}

function containsBytes(bytes: Uint8Array, target: Uint8Array) {
  if (!target.byteLength || target.byteLength > bytes.byteLength) return false;
  for (let offset = 0; offset <= bytes.byteLength - target.byteLength; offset += 1) {
    if (target.every((byte, index) => bytes[offset + index] == byte)) return true;
  }
  return false;
}

async function expectVaultError(
  action: () => Promise<unknown>,
  code: WorkspaceAgentCredentialVaultErrorCode,
  forbiddenValues: string[] = [],
) {
  let error: unknown;
  try {
    await action();
  } catch (cause) {
    error = cause;
  }

  expect(error).toBeInstanceOf(WorkspaceAgentCredentialVaultError);
  let vaultError = error as WorkspaceAgentCredentialVaultError;
  expect(vaultError.code).toBe(code);
  expect(vaultError.message).toBe(WORKSPACE_AGENT_CREDENTIAL_VAULT_ERROR_MESSAGES[code]);
  expect("cause" in vaultError).toBe(false);
  for (let value of forbiddenValues) {
    expect(String(vaultError)).not.toContain(value);
    expect(JSON.stringify(vaultError)).not.toContain(value);
  }
}
