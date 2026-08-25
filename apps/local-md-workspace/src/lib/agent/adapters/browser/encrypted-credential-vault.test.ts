import { describe, expect, it } from "vite-plus/test";
import { WorkspaceAgentCredentialVaultError } from "../../application/credential-vault.ts";
import {
  createEncryptedWorkspaceAgentCredentialVault,
  type WorkspaceAgentCredentialRecordStorage,
  type WorkspaceAgentCredentialVaultCrypto,
} from "./encrypted-credential-vault.ts";

const secret = "sk-vault-test-secret-value";
const passphrase = "correct horse battery staple";
const webCrypto = globalThis.crypto as WorkspaceAgentCredentialVaultCrypto;

describe("encrypted Workspace Agent credential vault", () => {
  it("round-trips and replaces encrypted credentials without storing plaintext", async () => {
    let storage = new MemoryStorage();
    let vault = createVault(storage);

    expect(await vault.probe()).toEqual({ status: "empty" });
    await vault.save(`  ${secret}  `, passphrase);
    let record = (await storage.read()) as StoredRecord;
    expect(record).toMatchObject({
      cipher: "AES-GCM-256",
      keyDerivation: { algorithm: "PBKDF2-HMAC-SHA256", iterations: 600_000 },
      schemaVersion: 1,
    });
    expect(record.keyDerivation.salt).toHaveLength(16);
    expect(record.initializationVector).toHaveLength(12);
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(record)).not.toContain(passphrase);
    expect(await vault.unlock(passphrase)).toBe(secret);

    await vault.save("sk-replacement", passphrase);
    expect(await vault.unlock(passphrase)).toBe("sk-replacement");
  });

  it("uses the same static failure for a wrong passphrase or tampered ciphertext", async () => {
    let storage = new MemoryStorage();
    let vault = createVault(storage);
    await vault.save(secret, passphrase);

    await expectError(vault.unlock("wrong passphrase"), "unlock-failed");
    let record = (await storage.read()) as StoredRecord;
    record.ciphertext[0] ^= 1;
    storage.seed(record);
    await expectError(vault.unlock(passphrase), "unlock-failed");

    storage.seed({ ...record, schemaVersion: 2 });
    await expectError(vault.probe(), "invalid-record");
  });

  it("fails closed when cryptography or storage is unavailable", async () => {
    let storage = new MemoryStorage();
    let withoutCrypto = createEncryptedWorkspaceAgentCredentialVault({ crypto: null, storage });
    await expectError(withoutCrypto.save(secret, passphrase), "crypto-unavailable");
    expect(await storage.read()).toBeUndefined();

    let withoutStorage = createEncryptedWorkspaceAgentCredentialVault({
      crypto: webCrypto,
      storage: null,
    });
    await expectError(withoutStorage.probe(), "storage-unavailable");
    await expectError(withoutStorage.delete(), "storage-unavailable");
  });
});

function createVault(storage: WorkspaceAgentCredentialRecordStorage) {
  return createEncryptedWorkspaceAgentCredentialVault({ crypto: webCrypto, storage });
}

class MemoryStorage implements WorkspaceAgentCredentialRecordStorage {
  private value: unknown;

  async delete() {
    this.value = undefined;
  }

  async read() {
    return structuredClone(this.value);
  }

  async write(value: unknown) {
    this.value = structuredClone(value);
  }

  seed(value: unknown) {
    this.value = structuredClone(value);
  }
}

type StoredRecord = {
  cipher: string;
  ciphertext: Uint8Array;
  initializationVector: Uint8Array;
  keyDerivation: { algorithm: string; iterations: number; salt: Uint8Array };
  schemaVersion: number;
};

async function expectError(promise: Promise<unknown>, code: string) {
  let error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkspaceAgentCredentialVaultError);
  if (!(error instanceof WorkspaceAgentCredentialVaultError)) throw error;
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain(secret);
  expect(String(error)).not.toContain(passphrase);
  expect("cause" in error).toBe(false);
}
