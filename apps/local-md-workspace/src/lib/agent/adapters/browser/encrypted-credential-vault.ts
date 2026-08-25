import {
  WorkspaceAgentCredentialVaultError,
  type WorkspaceAgentCredentialVault,
} from "../../application/credential-vault.ts";

export const WORKSPACE_AGENT_CREDENTIAL_VAULT_DATABASE_NAME = "grove-agent-credentials";
export const WORKSPACE_AGENT_CREDENTIAL_VAULT_DATABASE_VERSION = 1;
export const WORKSPACE_AGENT_CREDENTIAL_VAULT_PBKDF2_ITERATIONS = 600_000;

const databaseStoreName = "credentials";
const deepSeekCredentialKey = "deepseek-api-key";
const recordSchemaVersion = 1;
const saltByteLength = 16;
const initializationVectorByteLength = 12;
const aesGcmTagByteLength = 16;
const maximumApiKeyByteLength = 4_096;
const maximumPassphraseByteLength = 1_024;
const maximumApiKeyCharacterLength = 512;
const maximumPassphraseCharacterLength = 256;
const minimumPassphraseCharacterLength = 12;
const cipherName = "AES-GCM-256";
const keyDerivationName = "PBKDF2-HMAC-SHA256";
const additionalAuthenticatedData: BrowserByteArray = new TextEncoder().encode(
  "grove/deepseek-api-key/v1",
);

type BrowserByteArray = Uint8Array<ArrayBuffer>;

type StoredEncryptedCredentialRecord = {
  cipher: typeof cipherName;
  ciphertext: BrowserByteArray;
  initializationVector: BrowserByteArray;
  keyDerivation: {
    algorithm: typeof keyDerivationName;
    iterations: typeof WORKSPACE_AGENT_CREDENTIAL_VAULT_PBKDF2_ITERATIONS;
    salt: BrowserByteArray;
  };
  schemaVersion: typeof recordSchemaVersion;
};

type ParsedEncryptedCredentialRecord = {
  ciphertext: BrowserByteArray;
  initializationVector: BrowserByteArray;
  salt: BrowserByteArray;
};

export type WorkspaceAgentCredentialRecordReadResult =
  | { readonly status: "empty" }
  | { readonly status: "stored"; readonly value: unknown };

export interface WorkspaceAgentCredentialRecordStorage {
  delete(): Promise<void>;
  read(): Promise<WorkspaceAgentCredentialRecordReadResult>;
  write(value: unknown): Promise<void>;
}

export type WorkspaceAgentCredentialVaultCrypto = Pick<Crypto, "getRandomValues"> & {
  readonly subtle: Pick<SubtleCrypto, "decrypt" | "deriveKey" | "encrypt" | "importKey">;
};

export type EncryptedWorkspaceAgentCredentialVaultOptions = {
  crypto?: WorkspaceAgentCredentialVaultCrypto | null;
  storage?: WorkspaceAgentCredentialRecordStorage | null;
};

export function createEncryptedWorkspaceAgentCredentialVault(
  options: EncryptedWorkspaceAgentCredentialVaultOptions = {},
): WorkspaceAgentCredentialVault {
  let cryptography = options.crypto === undefined ? browserCredentialVaultCrypto() : options.crypto;
  let storage =
    options.storage === undefined ? createIndexedDbCredentialRecordStorage() : options.storage;

  return new EncryptedWorkspaceAgentCredentialVault(cryptography, storage);
}

class EncryptedWorkspaceAgentCredentialVault implements WorkspaceAgentCredentialVault {
  constructor(
    private readonly cryptography: WorkspaceAgentCredentialVaultCrypto | null,
    private readonly storage: WorkspaceAgentCredentialRecordStorage | null,
  ) {}

  async probe() {
    let result = await this.readStoredRecord();
    if (result.status == "empty") return { status: "empty" } as const;
    parseStoredRecord(result.value);
    return { status: "locked" } as const;
  }

  async save(apiKey: string, passphrase: string) {
    let normalizedApiKey = apiKey.trim();
    validateApiKeyInput(normalizedApiKey);
    validatePassphraseInput(passphrase);
    let apiKeyBytes = new TextEncoder().encode(normalizedApiKey);
    let passphraseBytes = new TextEncoder().encode(passphrase);
    let record: StoredEncryptedCredentialRecord;

    try {
      validateApiKeyBytes(apiKeyBytes);
      validatePassphraseBytes(passphraseBytes);
      let cryptography = requireCryptography(this.cryptography);
      let salt = randomBytes(cryptography, saltByteLength);
      let initializationVector = randomBytes(cryptography, initializationVectorByteLength);
      let ciphertext: ArrayBuffer;

      try {
        let key = await deriveAesGcmKey(cryptography, passphraseBytes, salt, ["encrypt"]);
        ciphertext = await cryptography.subtle.encrypt(
          {
            additionalData: additionalAuthenticatedData,
            iv: initializationVector,
            name: "AES-GCM",
            tagLength: aesGcmTagByteLength * 8,
          },
          key,
          apiKeyBytes,
        );
      } catch {
        throw credentialVaultError("crypto-unavailable");
      }

      record = {
        cipher: cipherName,
        ciphertext: new Uint8Array(ciphertext),
        initializationVector,
        keyDerivation: {
          algorithm: keyDerivationName,
          iterations: WORKSPACE_AGENT_CREDENTIAL_VAULT_PBKDF2_ITERATIONS,
          salt,
        },
        schemaVersion: recordSchemaVersion,
      };
    } finally {
      apiKeyBytes.fill(0);
      passphraseBytes.fill(0);
    }

    await this.writeStoredRecord(record);
  }

  async unlock(passphrase: string) {
    validatePassphraseInput(passphrase);
    let passphraseBytes = new TextEncoder().encode(passphrase);
    let plaintext: BrowserByteArray | null = null;

    try {
      validatePassphraseBytes(passphraseBytes);
      let result = await this.readStoredRecord();
      if (result.status == "empty") throw credentialVaultError("credential-not-found");
      let record = parseStoredRecord(result.value);
      let cryptography = requireCryptography(this.cryptography);

      try {
        let key = await deriveAesGcmKey(cryptography, passphraseBytes, record.salt, ["decrypt"]);
        let decrypted = await cryptography.subtle.decrypt(
          {
            additionalData: additionalAuthenticatedData,
            iv: record.initializationVector,
            name: "AES-GCM",
            tagLength: aesGcmTagByteLength * 8,
          },
          key,
          record.ciphertext,
        );
        plaintext = new Uint8Array(decrypted);
        validateApiKeyBytes(plaintext);
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      } catch {
        throw credentialVaultError("unlock-failed");
      }
    } finally {
      passphraseBytes.fill(0);
      plaintext?.fill(0);
    }
  }

  async delete() {
    let storage = requireStorage(this.storage);
    try {
      await storage.delete();
    } catch {
      throw credentialVaultError("storage-unavailable");
    }
  }

  private async readStoredRecord() {
    let storage = requireStorage(this.storage);
    try {
      let result = await storage.read();
      if (result?.status == "empty") return result;
      if (result?.status == "stored" && "value" in result) return result;
      throw credentialVaultError("invalid-record");
    } catch (error) {
      if (error instanceof WorkspaceAgentCredentialVaultError) throw error;
      throw credentialVaultError("storage-unavailable");
    }
  }

  private async writeStoredRecord(record: StoredEncryptedCredentialRecord) {
    let storage = requireStorage(this.storage);
    try {
      await storage.write(record);
    } catch {
      throw credentialVaultError("storage-unavailable");
    }
  }
}

async function deriveAesGcmKey(
  cryptography: WorkspaceAgentCredentialVaultCrypto,
  passphrase: BrowserByteArray,
  salt: BrowserByteArray,
  usages: KeyUsage[],
) {
  let keyMaterial = await cryptography.subtle.importKey("raw", passphrase, "PBKDF2", false, [
    "deriveKey",
  ]);
  return cryptography.subtle.deriveKey(
    {
      hash: "SHA-256",
      iterations: WORKSPACE_AGENT_CREDENTIAL_VAULT_PBKDF2_ITERATIONS,
      name: "PBKDF2",
      salt,
    },
    keyMaterial,
    { length: 256, name: "AES-GCM" },
    false,
    usages,
  );
}

function randomBytes(cryptography: WorkspaceAgentCredentialVaultCrypto, byteLength: number) {
  try {
    return cryptography.getRandomValues(new Uint8Array(byteLength));
  } catch {
    throw credentialVaultError("crypto-unavailable");
  }
}

function parseStoredRecord(value: unknown): ParsedEncryptedCredentialRecord {
  try {
    return parseStoredRecordValue(value);
  } catch (error) {
    if (error instanceof WorkspaceAgentCredentialVaultError) throw error;
    throw credentialVaultError("invalid-record");
  }
}

function parseStoredRecordValue(value: unknown): ParsedEncryptedCredentialRecord {
  if (!isRecord(value) || !hasExactlyKeys(value, storedRecordKeys)) {
    throw credentialVaultError("invalid-record");
  }
  if (
    value.schemaVersion !== recordSchemaVersion ||
    value.cipher !== cipherName ||
    !isRecord(value.keyDerivation) ||
    !hasExactlyKeys(value.keyDerivation, keyDerivationKeys) ||
    value.keyDerivation.algorithm !== keyDerivationName ||
    value.keyDerivation.iterations !== WORKSPACE_AGENT_CREDENTIAL_VAULT_PBKDF2_ITERATIONS
  ) {
    throw credentialVaultError("invalid-record");
  }

  let salt = copyByteArray(value.keyDerivation.salt, saltByteLength, saltByteLength);
  let initializationVector = copyByteArray(
    value.initializationVector,
    initializationVectorByteLength,
    initializationVectorByteLength,
  );
  let ciphertext = copyByteArray(
    value.ciphertext,
    aesGcmTagByteLength + 1,
    maximumApiKeyByteLength + aesGcmTagByteLength,
  );
  if (!salt || !initializationVector || !ciphertext) {
    throw credentialVaultError("invalid-record");
  }
  return { ciphertext, initializationVector, salt };
}

const storedRecordKeys = [
  "cipher",
  "ciphertext",
  "initializationVector",
  "keyDerivation",
  "schemaVersion",
] as const;
const keyDerivationKeys = ["algorithm", "iterations", "salt"] as const;

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]) {
  let keys = Object.keys(value).toSorted();
  return keys.length == expected.length && keys.every((key, index) => key == expected[index]);
}

function copyByteArray(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): BrowserByteArray | null {
  if (
    !isUint8Array(value) ||
    value.byteLength < minimumLength ||
    value.byteLength > maximumLength
  ) {
    return null;
  }
  let copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) && Object.prototype.toString.call(value) == "[object Uint8Array]"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value == "object" && !Array.isArray(value);
}

function validateApiKeyBytes(value: BrowserByteArray) {
  if (!value.byteLength || value.byteLength > maximumApiKeyByteLength) {
    throw credentialVaultError("invalid-api-key");
  }
}

function validateApiKeyInput(value: string) {
  if (!value || value.length > maximumApiKeyCharacterLength) {
    throw credentialVaultError("invalid-api-key");
  }
}

function validatePassphraseBytes(value: BrowserByteArray) {
  if (!value.byteLength || value.byteLength > maximumPassphraseByteLength) {
    throw credentialVaultError("invalid-passphrase");
  }
}

function validatePassphraseInput(value: string) {
  if (
    value.length < minimumPassphraseCharacterLength ||
    value.length > maximumPassphraseCharacterLength
  ) {
    throw credentialVaultError("invalid-passphrase");
  }
}

function requireCryptography(
  cryptography: WorkspaceAgentCredentialVaultCrypto | null,
): WorkspaceAgentCredentialVaultCrypto {
  try {
    if (
      cryptography &&
      typeof cryptography.getRandomValues == "function" &&
      cryptography.subtle &&
      typeof cryptography.subtle.decrypt == "function" &&
      typeof cryptography.subtle.deriveKey == "function" &&
      typeof cryptography.subtle.encrypt == "function" &&
      typeof cryptography.subtle.importKey == "function"
    ) {
      return cryptography;
    }
  } catch {
    // Capability access can itself be denied by the browser environment.
  }
  throw credentialVaultError("crypto-unavailable");
}

function requireStorage(
  storage: WorkspaceAgentCredentialRecordStorage | null,
): WorkspaceAgentCredentialRecordStorage {
  if (!storage) throw credentialVaultError("storage-unavailable");
  return storage;
}

function browserCredentialVaultCrypto(): WorkspaceAgentCredentialVaultCrypto | null {
  try {
    if (typeof globalThis.isSecureContext == "boolean" && !globalThis.isSecureContext) return null;
    return globalThis.crypto?.subtle ? globalThis.crypto : null;
  } catch {
    return null;
  }
}

function credentialVaultError(
  code: ConstructorParameters<typeof WorkspaceAgentCredentialVaultError>[0],
) {
  return new WorkspaceAgentCredentialVaultError(code);
}

function createIndexedDbCredentialRecordStorage(): WorkspaceAgentCredentialRecordStorage {
  return {
    async delete() {
      let db = await openCredentialDatabase();
      try {
        let transaction = db.transaction(databaseStoreName, "readwrite");
        let done = transactionComplete(transaction);
        let request = transaction.objectStore(databaseStoreName).delete(deepSeekCredentialKey);
        await Promise.all([requestResult(request), done]);
      } finally {
        db.close();
      }
    },
    async read() {
      let db = await openCredentialDatabase();
      try {
        let transaction = db.transaction(databaseStoreName, "readonly");
        let done = transactionComplete(transaction);
        let request = transaction.objectStore(databaseStoreName).get(deepSeekCredentialKey);
        let [value] = await Promise.all([requestResult<unknown>(request), done]);
        return value === undefined
          ? ({ status: "empty" } as const)
          : ({ status: "stored", value } as const);
      } finally {
        db.close();
      }
    },
    async write(value) {
      let db = await openCredentialDatabase();
      try {
        let transaction = db.transaction(databaseStoreName, "readwrite");
        let done = transactionComplete(transaction);
        let request = transaction.objectStore(databaseStoreName).put(value, deepSeekCredentialKey);
        await Promise.all([requestResult(request), done]);
      } finally {
        db.close();
      }
    },
  };
}

function openCredentialDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }

    let settled = false;
    let request = globalThis.indexedDB.open(
      WORKSPACE_AGENT_CREDENTIAL_VAULT_DATABASE_NAME,
      WORKSPACE_AGENT_CREDENTIAL_VAULT_DATABASE_VERSION,
    );
    request.onupgradeneeded = () => {
      let db = request.result;
      if (!db.objectStoreNames.contains(databaseStoreName)) {
        db.createObjectStore(databaseStoreName);
      }
    };
    request.onsuccess = () => {
      let db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("IndexedDB open failed."));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("IndexedDB open was blocked."));
    };
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("IndexedDB request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(new Error("IndexedDB transaction aborted."));
  });
}
