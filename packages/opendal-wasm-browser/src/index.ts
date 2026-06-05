export type OpendalBrowserProvider = "s3";

export type OpendalBrowserOperatorConfig = {
  accessKeyId?: string;
  bucket: string;
  endpoint: string;
  provider: OpendalBrowserProvider;
  region: string;
  root?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export type OpendalBrowserCapabilities = {
  nativeCopy: boolean;
  nativeCreateDir: boolean;
  nativeDelete: boolean;
  nativeList: boolean;
  nativeRead: boolean;
  nativeRename: boolean;
  nativeStat: boolean;
  nativeWrite: boolean;
};

export type OpendalBrowserEntry = {
  isDirectory: boolean;
  isFile: boolean;
  path: string;
};

export type OpendalBrowserOperator = {
  capabilities(): OpendalBrowserCapabilities;
  delete(path: string): Promise<void>;
  list(prefix: string): Promise<OpendalBrowserEntry[]>;
  readText(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<OpendalBrowserEntry>;
  writeText(path: string, value: string): Promise<void>;
};

export type CreateOpendalBrowserOperatorOptions = {
  generatedModuleUrl?: string;
  wasmModuleUrl?: string | URL | WebAssembly.Module | Response | Promise<Response>;
};

type GeneratedOperator = {
  capabilities(): unknown;
  delete(path: string): Promise<void>;
  list(prefix: string): Promise<unknown>;
  readText(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<unknown>;
  writeText(path: string, value: string): Promise<void>;
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
    await generated.default(wasmModuleUrl);
  }
}

class WasmOpendalBrowserOperator implements OpendalBrowserOperator {
  constructor(private readonly operator: GeneratedOperator) {}

  capabilities() {
    return parseCapabilities(this.operator.capabilities());
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

  async writeText(path: string, value: string) {
    await this.operator.writeText(path, value);
  }
}

function normalizeConfig(config: OpendalBrowserOperatorConfig): OpendalBrowserOperatorConfig {
  let rawProvider = (config as { provider?: unknown }).provider;
  let provider = typeof rawProvider == "string" ? rawProvider : "";
  if (provider != "s3") {
    throw new Error(`Unsupported OpenDAL browser provider: ${provider}`);
  }

  return {
    accessKeyId: emptyToUndefined(config.accessKeyId),
    bucket: requireText(config.bucket, "bucket"),
    endpoint: requireText(config.endpoint, "endpoint"),
    provider: "s3",
    region: requireText(config.region, "region"),
    root: normalizeRoot(config.root),
    secretAccessKey: emptyToUndefined(config.secretAccessKey),
    sessionToken: emptyToUndefined(config.sessionToken),
  };
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
  };
}

function parseEntries(value: unknown) {
  if (!Array.isArray(value)) throw new Error("OpenDAL list returned a non-array value.");
  return value.map((entry, index) => parseEntry(entry, `entry ${index}`));
}

function parseEntry(value: unknown, label = "entry"): OpendalBrowserEntry {
  let record = requireRecord(value, label);
  return {
    isDirectory: Boolean(record.isDirectory),
    isFile: Boolean(record.isFile),
    path: requireText(record.path, `${label}.path`),
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
