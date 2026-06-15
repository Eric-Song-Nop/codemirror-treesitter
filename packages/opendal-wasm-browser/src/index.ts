export type OpendalBrowserProvider = "dropbox" | "onedrive" | "s3";

export type OpendalDropboxOperatorConfig = {
  accessToken: string;
  provider: "dropbox";
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
};

export type OpendalBrowserOperator = {
  capabilities(): OpendalBrowserCapabilities;
  createDir(path: string): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix: string): Promise<OpendalBrowserEntry[]>;
  readText(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<OpendalBrowserEntry>;
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

type GeneratedOperator = {
  capabilities(): unknown;
  createDir(path: string): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix: string): Promise<unknown>;
  readText(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<unknown>;
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
  return new WasmOpendalBrowserOperator(new generated.OpendalBrowserOperator(normalizedConfig));
}

export function defaultGeneratedModuleUrl() {
  return new URL("../pkg/opendal_wasm_browser.js", import.meta.url).href;
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
  constructor(private readonly operator: GeneratedOperator) {}

  capabilities() {
    return parseCapabilities(this.operator.capabilities());
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

  async readText(path: string) {
    return this.operator.readText(path);
  }

  async rename(from: string, to: string) {
    await this.operator.rename(from, to);
  }

  async stat(path: string) {
    return parseEntry(await this.operator.stat(path));
  }

  async writeText(path: string, value: string, options?: OpendalBrowserWriteOptions) {
    let result = await this.operator.writeText(path, value, options);
    if (result == null) return undefined;
    return parseEntry(result, "write result");
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
