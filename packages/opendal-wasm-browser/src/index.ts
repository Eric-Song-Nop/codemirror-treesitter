export type OpendalBrowserProvider = "dropbox" | "gdrive" | "onedrive" | "s3";

export type OpendalDropboxOperatorConfig = {
  accessToken: string;
  provider: "dropbox";
  root?: string;
};

export type OpendalGoogleDriveOperatorConfig = {
  accessToken: string;
  provider: "gdrive";
  root?: string;
};

export type OpendalS3OperatorConfig = {
  accessKeyId?: string;
  bucket: string;
  endpoint: string;
  provider: "s3";
  region: string;
  root?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export type OpendalOneDriveOperatorConfig = {
  accessToken: string;
  provider: "onedrive";
  root?: string;
};

export type OpendalBrowserOperatorConfig =
  | OpendalDropboxOperatorConfig
  | OpendalGoogleDriveOperatorConfig
  | OpendalOneDriveOperatorConfig
  | OpendalS3OperatorConfig;

export type OpendalBrowserCapabilities = {
  nativeCopy: boolean;
  nativeCreateDir: boolean;
  nativeDelete: boolean;
  nativeList: boolean;
  nativeRead: boolean;
  nativeRename: boolean;
  nativeStat: boolean;
  nativeWrite: boolean;
  nativeWriteWithIfMatch: boolean;
  nativeWriteWithIfNotExists?: boolean;
  nativeWriteWithVersion?: boolean;
};

export type OpendalBrowserEntry = {
  etag?: string;
  isDirectory: boolean;
  isFile: boolean;
  lastModified?: string;
  path: string;
  size?: number;
  version?: string;
};

export type OpendalBrowserWriteOptions = {
  ifMatch?: string;
  ifNotExists?: boolean;
  ifVersion?: string;
};

export type OpendalBrowserReadResult<T> = {
  entry: OpendalBrowserEntry;
  value: T;
};

export type OpendalBrowserOperator = {
  capabilities(): OpendalBrowserCapabilities;
  createDir(path: string): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix: string): Promise<OpendalBrowserEntry[]>;
  readBytes(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  readTextWithMetadata?(path: string): Promise<OpendalBrowserReadResult<string>>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<OpendalBrowserEntry>;
  writeBytes(
    path: string,
    bytes: Uint8Array,
    options?: OpendalBrowserWriteOptions,
  ): Promise<OpendalBrowserEntry | void>;
  writeText(
    path: string,
    value: string,
    options?: OpendalBrowserWriteOptions,
  ): Promise<OpendalBrowserEntry | void>;
};

export type CreateOpendalBrowserOperatorOptions = {
  generatedModuleUrl?: string;
  wasmModuleUrl?: string | URL | WebAssembly.Module | Response | Promise<Response>;
};

export type OpendalBrowserRuntimeAssetOptions = {
  generatedModuleUrl: string;
  wasmModuleUrl: string;
};

type GeneratedOperator = {
  capabilities(): unknown;
  createDir(path: string): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix: string): Promise<unknown>;
  readBytes(path: string): Promise<unknown>;
  readText(path: string): Promise<string>;
  readTextWithMetadata?(path: string): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<unknown>;
  writeBytes(
    path: string,
    bytes: Uint8Array,
    options?: OpendalBrowserWriteOptions,
  ): Promise<unknown>;
  writeText(path: string, value: string, options?: OpendalBrowserWriteOptions): Promise<unknown>;
};

type GeneratedOperatorConstructor = new (config: OpendalBrowserOperatorConfig) => GeneratedOperator;

type GeneratedModule = {
  default?: (moduleOrPath?: unknown) => Promise<unknown>;
  OpendalBrowserOperator: GeneratedOperatorConstructor;
};

export async function createOpendalBrowserOperator(
  config: OpendalBrowserOperatorConfig,
  options: CreateOpendalBrowserOperatorOptions = {},
): Promise<OpendalBrowserOperator> {
  let normalizedConfig = normalizeConfig(config);
  let generated = await loadGeneratedModule(options.generatedModuleUrl);
  await initializeGeneratedModule(generated, options.wasmModuleUrl);
  return new WasmOpendalBrowserOperator(
    new generated.OpendalBrowserOperator(normalizedConfig),
    normalizedConfig,
  );
}

export function defaultGeneratedModuleUrl() {
  return new URL("../pkg/opendal_wasm_browser.js", import.meta.url).href;
}

export function defaultWasmModuleUrl() {
  return new URL("../pkg/opendal_wasm_browser_bg.wasm", import.meta.url).href;
}

export function defaultOpendalBrowserRuntimeOptions(): OpendalBrowserRuntimeAssetOptions {
  return {
    generatedModuleUrl: defaultGeneratedModuleUrl(),
    wasmModuleUrl: defaultWasmModuleUrl(),
  };
}

async function loadGeneratedModule(generatedModuleUrl = defaultGeneratedModuleUrl()) {
  return (await import(/* @vite-ignore */ generatedModuleUrl)) as GeneratedModule;
}

async function initializeGeneratedModule(
  generated: GeneratedModule,
  wasmModuleUrl: CreateOpendalBrowserOperatorOptions["wasmModuleUrl"],
) {
  if (typeof generated.default == "function") {
    await generated.default(wasmModuleUrl == null ? undefined : { module_or_path: wasmModuleUrl });
  }
}

class WasmOpendalBrowserOperator implements OpendalBrowserOperator {
  constructor(
    private readonly operator: GeneratedOperator,
    private readonly config: OpendalBrowserOperatorConfig,
  ) {}

  capabilities() {
    let capabilities = parseCapabilities(this.operator.capabilities());
    if (this.config.provider != "dropbox") return capabilities;
    return {
      ...capabilities,
      nativeWriteWithIfNotExists: true,
      nativeWriteWithVersion: true,
    };
  }

  async createDir(path: string) {
    await this.operator.createDir(path);
  }

  async delete(path: string) {
    await this.operator.delete(path);
  }

  async list(prefix: string) {
    return parseEntries(await this.operator.list(prefix));
  }

  async readBytes(path: string) {
    return parseBytes(await this.operator.readBytes(path));
  }

  async readText(path: string) {
    return this.operator.readText(path);
  }

  async readTextWithMetadata(path: string) {
    if (this.config.provider == "dropbox") {
      return readDropboxText(this.config, path);
    }

    if (typeof this.operator.readTextWithMetadata == "function") {
      return parseReadTextResult(await this.operator.readTextWithMetadata(path));
    }

    let [value, entry] = await Promise.all([
      this.operator.readText(path),
      this.operator.stat(path),
    ]);
    return { entry: parseEntry(entry), value };
  }

  async rename(from: string, to: string) {
    await this.operator.rename(from, to);
  }

  async stat(path: string) {
    return parseEntry(await this.operator.stat(path));
  }

  async writeBytes(path: string, bytes: Uint8Array, options?: OpendalBrowserWriteOptions) {
    assertSupportedWriteOptions(this.capabilities(), options);
    if (this.config.provider == "dropbox" && hasDropboxWriteCondition(options)) {
      return writeDropboxBytes(this.config, path, Uint8Array.from(bytes).buffer, options!);
    }
    let result = await this.operator.writeBytes(path, bytes, options);
    if (result == null) return undefined;
    return parseEntry(result, "write result");
  }

  async writeText(path: string, value: string, options?: OpendalBrowserWriteOptions) {
    assertSupportedWriteOptions(this.capabilities(), options);
    if (this.config.provider == "dropbox" && hasDropboxWriteCondition(options)) {
      return writeDropboxBytes(this.config, path, value, options!);
    }
    let result = await this.operator.writeText(path, value, options);
    if (result == null) return undefined;
    return parseEntry(result, "write result");
  }
}

function assertSupportedWriteOptions(
  capabilities: OpendalBrowserCapabilities,
  options: OpendalBrowserWriteOptions | undefined,
) {
  if (!options) return;
  let conditions = [
    options.ifMatch != null,
    options.ifNotExists === true,
    options.ifVersion != null,
  ];
  if (conditions.filter(Boolean).length > 1) {
    throw new Error("OpenDAL browser writes accept only one atomic write condition.");
  }
  if (options.ifMatch != null && !capabilities.nativeWriteWithIfMatch) {
    throw new Error("OpenDAL backend does not support atomic ETag writes.");
  }
  if (options.ifNotExists && !capabilities.nativeWriteWithIfNotExists) {
    throw new Error("OpenDAL backend does not support atomic no-clobber writes.");
  }
  if (options.ifVersion != null && !capabilities.nativeWriteWithVersion) {
    throw new Error("OpenDAL backend does not support atomic version writes.");
  }
}

function hasDropboxWriteCondition(options: OpendalBrowserWriteOptions | undefined) {
  return options?.ifNotExists === true || options?.ifVersion != null;
}

async function readDropboxText(
  config: OpendalDropboxOperatorConfig,
  path: string,
): Promise<OpendalBrowserReadResult<string>> {
  let normalizedPath = normalizeStoragePath(path);
  let response = await fetch("https://content.dropboxapi.com/2/files/download", {
    headers: dropboxHeaders(config, {
      path: dropboxApiPath(config.root, normalizedPath),
    }),
    method: "POST",
  });
  if (!response.ok) throw await dropboxResponseError(response);

  let rawMetadata = response.headers.get("Dropbox-API-Result");
  if (!rawMetadata) {
    throw new Error("Dropbox download response did not include file revision metadata.");
  }

  return {
    entry: dropboxEntry(
      normalizedPath,
      parseJsonRecord(rawMetadata, "download metadata"),
      "download",
    ),
    value: await response.text(),
  };
}

async function writeDropboxBytes(
  config: OpendalDropboxOperatorConfig,
  path: string,
  body: BodyInit,
  options: OpendalBrowserWriteOptions,
) {
  let normalizedPath = normalizeStoragePath(path);
  let condition: "no-clobber" | "revision" = options.ifNotExists ? "no-clobber" : "revision";
  let mode = options.ifNotExists
    ? "add"
    : {
        ".tag": "update",
        update: requireText(options.ifVersion, "ifVersion"),
      };
  let response = await fetch("https://content.dropboxapi.com/2/files/upload", {
    body,
    headers: {
      ...dropboxHeaders(config, {
        autorename: false,
        mode,
        mute: true,
        path: dropboxApiPath(config.root, normalizedPath),
        strict_conflict: true,
      }),
      "Content-Type": "application/octet-stream",
    },
    method: "POST",
  });
  if (!response.ok) throw await dropboxResponseError(response, condition);

  return dropboxEntry(
    normalizedPath,
    requireRecord(await response.json(), "Dropbox upload metadata"),
    "upload",
  );
}

function dropboxHeaders(config: OpendalDropboxOperatorConfig, args: unknown) {
  return {
    Authorization: `Bearer ${config.accessToken}`,
    "Dropbox-API-Arg": JSON.stringify(args),
  };
}

function dropboxApiPath(root: string | undefined, path: string) {
  return `${root ?? ""}/${path}`.replace(/\/{2,}/g, "/");
}

function normalizeStoragePath(path: string) {
  let normalized = path.trim().replace(/\\/g, "/");
  let parts = normalized.split("/").filter(Boolean);
  if (!parts.length) throw new Error("expected a file path");
  if (parts.some((part) => part == "." || part == "..")) {
    throw new Error("paths cannot include . or .. segments");
  }
  return parts.join("/");
}

function dropboxEntry(
  path: string,
  metadata: Record<string, unknown>,
  operation: "download" | "upload",
): OpendalBrowserEntry {
  return {
    etag: optionalText(metadata.content_hash, "Dropbox metadata.content_hash"),
    isDirectory: false,
    isFile: true,
    lastModified: optionalText(
      metadata.server_modified ?? metadata.client_modified,
      "Dropbox metadata.server_modified",
    ),
    path,
    size: optionalNumber(metadata.size, "Dropbox metadata.size"),
    version: requireDropboxRevision(metadata.rev, operation),
  };
}

function requireDropboxRevision(value: unknown, operation: "download" | "upload") {
  let revision = optionalText(value, "Dropbox metadata.rev")?.trim();
  if (!revision) {
    throw new Error(`Dropbox ${operation} response did not include file revision metadata.`);
  }
  return revision;
}

async function dropboxResponseError(response: Response, condition?: "no-clobber" | "revision") {
  let responseText = await response.text();
  let detail = responseText;
  try {
    let payload = JSON.parse(responseText) as { error_summary?: unknown };
    if (typeof payload.error_summary == "string") detail = payload.error_summary;
  } catch {
    // Preserve non-JSON Dropbox error responses verbatim.
  }
  let prefix =
    condition && response.status == 409 ? `Dropbox ${condition} conflict: ` : "Dropbox API error: ";
  return new Error(
    `${prefix}${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
  );
}

function parseJsonRecord(value: string, label: string) {
  try {
    return requireRecord(JSON.parse(value), `Dropbox ${label}`);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Dropbox ${label} returned invalid JSON.`, { cause: error });
    }
    throw error;
  }
}

function normalizeConfig(config: OpendalBrowserOperatorConfig): OpendalBrowserOperatorConfig {
  let rawProvider = (config as { provider?: unknown }).provider;
  let provider = typeof rawProvider == "string" ? rawProvider : "";

  if (provider == "dropbox") {
    return {
      accessToken: requireText((config as OpendalDropboxOperatorConfig).accessToken, "accessToken"),
      provider: "dropbox",
      root: normalizeRoot(config.root),
    };
  }

  if (provider == "gdrive") {
    return {
      accessToken: requireText(
        (config as OpendalGoogleDriveOperatorConfig).accessToken,
        "accessToken",
      ),
      provider: "gdrive",
      root: normalizeRoot(config.root),
    };
  }

  if (provider == "onedrive") {
    return {
      accessToken: requireText(
        (config as OpendalOneDriveOperatorConfig).accessToken,
        "accessToken",
      ),
      provider: "onedrive",
      root: normalizeRoot(config.root),
    };
  }

  if (provider == "s3") {
    let s3Config = config as OpendalS3OperatorConfig;
    return {
      accessKeyId: emptyToUndefined(s3Config.accessKeyId),
      bucket: requireText(s3Config.bucket, "bucket"),
      endpoint: requireText(s3Config.endpoint, "endpoint"),
      provider: "s3",
      region: requireText(s3Config.region, "region"),
      root: normalizeRoot(s3Config.root),
      secretAccessKey: emptyToUndefined(s3Config.secretAccessKey),
      sessionToken: emptyToUndefined(s3Config.sessionToken),
    };
  }

  throw new Error(`Unsupported OpenDAL browser provider: ${provider}`);
}

function parseCapabilities(value: unknown): OpendalBrowserCapabilities {
  let record = requireRecord(value, "capabilities");
  return {
    nativeCopy: Boolean(record.nativeCopy),
    nativeCreateDir: Boolean(record.nativeCreateDir),
    nativeDelete: Boolean(record.nativeDelete),
    nativeList: Boolean(record.nativeList),
    nativeRead: Boolean(record.nativeRead),
    nativeRename: Boolean(record.nativeRename),
    nativeStat: Boolean(record.nativeStat),
    nativeWrite: Boolean(record.nativeWrite),
    nativeWriteWithIfMatch: Boolean(record.nativeWriteWithIfMatch),
    nativeWriteWithIfNotExists: Boolean(record.nativeWriteWithIfNotExists),
    nativeWriteWithVersion: false,
  };
}

function parseReadTextResult(value: unknown): OpendalBrowserReadResult<string> {
  let record = requireRecord(value, "readTextWithMetadata");
  if (typeof record.value != "string") {
    throw new Error("OpenDAL readTextWithMetadata.value returned a non-string value.");
  }
  return {
    entry: parseEntry(record.entry, "readTextWithMetadata.entry"),
    value: record.value,
  };
}

function parseEntries(value: unknown) {
  if (!Array.isArray(value)) throw new Error("OpenDAL list returned a non-array value.");
  return value.map((entry, index) => parseEntry(entry, `entry ${index}`));
}

function parseEntry(value: unknown, label = "entry"): OpendalBrowserEntry {
  let record = requireRecord(value, label);
  return {
    etag: optionalText(record.etag, `${label}.etag`),
    isDirectory: Boolean(record.isDirectory),
    isFile: Boolean(record.isFile),
    lastModified: optionalText(record.lastModified, `${label}.lastModified`),
    path: requireText(record.path, `${label}.path`),
    size: optionalNumber(record.size, `${label}.size`),
    version: optionalText(record.version, `${label}.version`),
  };
}

function parseBytes(value: unknown) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    let view = value as ArrayBufferView;
    return new Uint8Array(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  throw new Error("OpenDAL readBytes returned a non-byte value.");
}

function requireRecord(value: unknown, label: string) {
  if (!value || typeof value != "object" || Array.isArray(value)) {
    throw new Error(`OpenDAL ${label} returned an invalid value.`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string) {
  if (typeof value != "string" || !value.trim()) {
    throw new Error(`OpenDAL browser config requires ${label}.`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string) {
  if (value == null) return undefined;
  if (typeof value != "string") {
    throw new Error(`OpenDAL ${label} returned a non-string value.`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string) {
  if (value == null) return undefined;
  if (typeof value != "number" || !Number.isFinite(value)) {
    throw new Error(`OpenDAL ${label} returned a non-number value.`);
  }
  return value;
}

function emptyToUndefined(value: null | string | undefined) {
  let trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRoot(value: null | string | undefined) {
  let root = emptyToUndefined(value);
  if (!root) return undefined;
  let trimmed = root.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : undefined;
}
