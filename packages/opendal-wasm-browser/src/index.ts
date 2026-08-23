export type OpendalS3Credentials = {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export type OpendalBrowserSource =
  | { kind: "browser-local"; rootHandle: FileSystemDirectoryHandle }
  | { accessToken: string; kind: "dropbox"; root?: string }
  | { accessToken: string; kind: "gdrive"; root?: string }
  | { accessToken: string; kind: "onedrive"; root?: string }
  | {
      bucket: string;
      credentials?: OpendalS3Credentials;
      endpoint: string;
      kind: "s3";
      region: string;
      root?: string;
    };

export type OpendalEntryKind = "directory" | "file";

export type OpendalMetadata = {
  etag?: string;
  kind: OpendalEntryKind;
  lastModified?: string;
  path: string;
  size?: number;
  version?: string;
};

export type OpendalCapabilities = {
  createDirectory: boolean;
  delete: {
    recursive: "emulated" | "native" | "unsupported";
    single: boolean;
  };
  list: boolean;
  read: boolean;
  rename: {
    directory: "copy-delete" | "native" | "unsupported";
    file: "copy-delete" | "native" | "unsupported";
  };
  stat: boolean;
  write: boolean;
  writeConditions: {
    ifMatch: boolean;
    ifNotExists: boolean;
    ifVersion: boolean;
  };
};

export type OpendalOperatorInfo = {
  capabilities: OpendalCapabilities;
  root: string;
  scheme: OpendalBrowserSource["kind"];
};

export type OpendalReadResult =
  | { bytes: Uint8Array; metadata: OpendalMetadata; metadataBinding: "same-read" }
  | { bytes: Uint8Array; metadataBinding: "none" };

export type OpendalWriteCondition =
  | { kind: "if-match"; etag: string }
  | { kind: "if-not-exists" }
  | { kind: "if-version"; version: string };

export type OpendalWriteRequest = {
  bytes: Uint8Array;
  condition?: OpendalWriteCondition;
  path: string;
};

export type OpendalWriteResult =
  | {
      metadata: OpendalMetadata;
      metadataBinding: "post-write" | "write-response";
      status: "applied";
    }
  | { metadataBinding: "none"; status: "applied" };

export type OpendalPathMutationResult =
  | { status: "applied" }
  | {
      phase: "recursive-delete" | "source-remove" | "target-copy";
      reconcilePaths: string[];
      status: "partial";
    }
  | { reconcilePaths: string[]; status: "unknown" };

export type OpendalDeleteRequest = { path: string; recursive: boolean };

export type OpendalRenameRequest = {
  from: string;
  kind: OpendalEntryKind;
  to: string;
};

export type OpendalErrorCode =
  | "already-exists"
  | "authentication-expired"
  | "condition-failed"
  | "not-found"
  | "permission-denied"
  | "rate-limited"
  | "temporary"
  | "unknown"
  | "unsupported";

export type OpendalOperation =
  | "create-directory"
  | "delete"
  | "list"
  | "read"
  | "rename"
  | "stat"
  | "write";

export class OpendalBrowserError extends Error {
  readonly code: OpendalErrorCode;
  readonly mutationOutcome?: "not-applied" | "partial" | "unknown";
  readonly operation: OpendalOperation;
  readonly path?: string;
  readonly reconcilePaths?: string[];
  readonly retryable: boolean;

  constructor(input: {
    cause?: unknown;
    code: OpendalErrorCode;
    message: string;
    mutationOutcome?: "not-applied" | "partial" | "unknown";
    operation: OpendalOperation;
    path?: string;
    reconcilePaths?: string[];
    retryable?: boolean;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "OpendalBrowserError";
    this.code = input.code;
    this.mutationOutcome = input.mutationOutcome;
    this.operation = input.operation;
    this.path = input.path;
    this.reconcilePaths = input.reconcilePaths;
    this.retryable = input.retryable ?? (input.code == "rate-limited" || input.code == "temporary");
  }
}

export interface OpendalExactBrowserOperator {
  readonly info: OpendalOperatorInfo;

  createDirectory(path: string): Promise<void>;
  delete(request: OpendalDeleteRequest): Promise<OpendalPathMutationResult>;
  dispose(): void;
  list(path: string): Promise<OpendalMetadata[]>;
  read(path: string): Promise<OpendalReadResult>;
  rename(request: OpendalRenameRequest): Promise<OpendalPathMutationResult>;
  stat(path: string): Promise<OpendalMetadata>;
  write(request: OpendalWriteRequest): Promise<OpendalWriteResult>;
}

type GeneratedCapabilities = {
  nativeCopy: boolean;
  nativeCreateDir: boolean;
  nativeDelete: boolean;
  nativeDeleteWithRecursive?: boolean;
  nativeList: boolean;
  nativeListWithRecursive?: boolean;
  nativeRead: boolean;
  nativeRename: boolean;
  nativeStat: boolean;
  nativeWrite: boolean;
  nativeWriteWithIfMatch: boolean;
  nativeWriteWithIfNotExists?: boolean;
  nativeWriteWithVersion?: boolean;
};

type GeneratedEntry = {
  etag?: string;
  isDirectory: boolean;
  isFile: boolean;
  lastModified?: string;
  path: string;
  size?: number;
  version?: string;
};

type GeneratedWriteOptions = {
  ifMatch?: string;
  ifNotExists?: boolean;
  ifVersion?: string;
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
  delete(path: string, recursive?: boolean): Promise<void>;
  free?(): void;
  list(prefix: string): Promise<unknown>;
  readBytes(path: string): Promise<unknown>;
  readBytesWithMetadata?(path: string): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<unknown>;
  writeBytes(path: string, bytes: Uint8Array, options?: GeneratedWriteOptions): Promise<unknown>;
};

type GeneratedOperatorConfig = {
  accessKeyId?: string;
  accessToken?: string;
  bucket?: string;
  endpoint?: string;
  provider: Exclude<OpendalBrowserSource["kind"], "browser-local">;
  region?: string;
  root?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

type GeneratedOperatorConstructor = new (config: GeneratedOperatorConfig) => GeneratedOperator;

type GeneratedModule = {
  default?: (moduleOrPath?: unknown) => Promise<unknown>;
  OpendalBrowserOperator: GeneratedOperatorConstructor;
  openBrowserLocalOperator?: (rootHandle: FileSystemDirectoryHandle) => GeneratedOperator;
};

export async function openOpendalBrowserOperator(
  source: OpendalBrowserSource,
  options: CreateOpendalBrowserOperatorOptions = {},
): Promise<OpendalExactBrowserOperator> {
  let generated = await loadGeneratedModule(options.generatedModuleUrl);
  await initializeGeneratedModule(generated, options.wasmModuleUrl);

  let operator: GeneratedOperator;
  if (source.kind == "browser-local") {
    if (typeof generated.openBrowserLocalOperator != "function") {
      throw new Error("OpenDAL browser WASM does not include the browser-local service.");
    }
    operator = generated.openBrowserLocalOperator(source.rootHandle);
  } else {
    operator = new generated.OpendalBrowserOperator(sourceToGeneratedConfig(source));
  }
  return new ExactWasmOpendalBrowserOperator(operator, source);
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

class ExactWasmOpendalBrowserOperator implements OpendalExactBrowserOperator {
  readonly info: OpendalOperatorInfo;
  private disposed = false;

  constructor(
    private readonly operator: GeneratedOperator,
    private readonly source: OpendalBrowserSource,
  ) {
    this.info = exactOperatorInfo(source, parseCapabilities(operator.capabilities()));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.operator.free?.();
  }

  async stat(path: string) {
    this.assertActive();
    let normalizedPath = normalizeExactPath(path, { allowRoot: true });
    try {
      return toExactMetadata(parseEntry(await this.operator.stat(normalizedPath)));
    } catch (error) {
      throw normalizeOpendalError(error, "stat", normalizedPath);
    }
  }

  async list(path: string) {
    this.assertActive();
    let normalizedPath = normalizeExactPath(path, { allowRoot: true, directory: true });
    if (!this.info.capabilities.list) {
      throw unsupportedOperation("list", normalizedPath);
    }
    try {
      return parseEntries(await this.operator.list(normalizedPath)).map(toExactMetadata);
    } catch (error) {
      throw normalizeOpendalError(error, "list", normalizedPath);
    }
  }

  async read(path: string): Promise<OpendalReadResult> {
    this.assertActive();
    let normalizedPath = normalizeExactPath(path);
    if (!this.info.capabilities.read) {
      throw unsupportedOperation("read", normalizedPath);
    }
    try {
      if (this.source.kind == "dropbox") {
        let result = await readDropboxBytes(this.source, normalizedPath);
        return {
          bytes: result.value,
          metadata: toExactMetadata(result.entry),
          metadataBinding: "same-read",
        };
      }

      if (typeof this.operator.readBytesWithMetadata == "function") {
        let result = requireRecord(
          await this.operator.readBytesWithMetadata(normalizedPath),
          "readBytesWithMetadata",
        );
        let bytes = parseBytes(result.bytes);
        if (result.entry != null) {
          return {
            bytes,
            metadata: toExactMetadata(parseEntry(result.entry, "readBytesWithMetadata.entry")),
            metadataBinding: "same-read",
          };
        }
        return { bytes, metadataBinding: "none" };
      }

      return {
        bytes: parseBytes(await this.operator.readBytes(normalizedPath)),
        metadataBinding: "none",
      };
    } catch (error) {
      throw normalizeOpendalError(error, "read", normalizedPath);
    }
  }

  async write(request: OpendalWriteRequest): Promise<OpendalWriteResult> {
    this.assertActive();
    let path = normalizeExactPath(request.path);
    assertExactWriteCondition(this.info.capabilities, request.condition, path);
    let options = exactWriteOptions(request.condition);
    try {
      let result =
        this.source.kind == "dropbox" && hasDropboxWriteCondition(options)
          ? await writeDropboxBytes(
              this.source,
              path,
              Uint8Array.from(request.bytes).buffer,
              options!,
            )
          : await this.operator.writeBytes(path, Uint8Array.from(request.bytes), options);
      if (result == null) return { metadataBinding: "none", status: "applied" };
      return {
        metadata: toExactMetadata(parseEntry(result, "write result")),
        metadataBinding: this.source.kind == "browser-local" ? "post-write" : "write-response",
        status: "applied",
      };
    } catch (error) {
      throw normalizeOpendalError(
        error,
        "write",
        path,
        true,
        undefined,
        this.source.kind == "browser-local",
      );
    }
  }

  async createDirectory(path: string) {
    this.assertActive();
    let normalizedPath = normalizeExactPath(path, { directory: true });
    if (!this.info.capabilities.createDirectory) {
      throw unsupportedOperation("create-directory", normalizedPath);
    }
    try {
      await this.operator.createDir(normalizedPath);
    } catch (error) {
      throw normalizeOpendalError(
        error,
        "create-directory",
        normalizedPath,
        true,
        undefined,
        this.source.kind == "browser-local",
      );
    }
  }

  async delete(request: OpendalDeleteRequest): Promise<OpendalPathMutationResult> {
    this.assertActive();
    let path = normalizeExactPath(request.path, { preserveDirectory: true });
    let capability = this.info.capabilities.delete;
    if (!capability.single || (request.recursive && capability.recursive == "unsupported")) {
      throw unsupportedOperation("delete", path);
    }

    if (request.recursive && capability.recursive == "emulated") {
      return this.deleteRecursively(path);
    }
    try {
      await this.operator.delete(path, request.recursive);
      return { status: "applied" };
    } catch (error) {
      let normalized = normalizeOpendalError(
        error,
        "delete",
        path,
        true,
        undefined,
        this.source.kind == "browser-local",
      );
      if (normalized.mutationOutcome == "unknown") {
        return { reconcilePaths: [path], status: "unknown" };
      }
      throw normalized;
    }
  }

  async rename(request: OpendalRenameRequest): Promise<OpendalPathMutationResult> {
    this.assertActive();
    let from = normalizeExactPath(request.from, {
      directory: request.kind == "directory",
    });
    let to = normalizeExactPath(request.to, {
      directory: request.kind == "directory",
    });
    let capability = this.info.capabilities.rename[request.kind];
    if (capability == "unsupported") throw unsupportedOperation("rename", from);

    if (capability == "native") {
      try {
        await this.operator.rename(from, to);
        return { status: "applied" };
      } catch (error) {
        let normalized = normalizeOpendalError(error, "rename", from, true, [from, to]);
        if (normalized.mutationOutcome == "unknown") {
          return { reconcilePaths: [from, to], status: "unknown" };
        }
        throw normalized;
      }
    }

    return request.kind == "file"
      ? this.copyDeleteFile(from, to)
      : this.copyDeleteDirectory(from, to);
  }

  private async copyDeleteFile(from: string, to: string): Promise<OpendalPathMutationResult> {
    await this.assertTargetMissing(to);
    let source = await this.read(from);
    let copied = false;
    try {
      await this.write({
        bytes: source.bytes,
        condition: this.info.capabilities.writeConditions.ifNotExists
          ? { kind: "if-not-exists" }
          : undefined,
        path: to,
      });
      copied = true;
      let target = await this.read(to);
      if (!equalBytes(source.bytes, target.bytes)) {
        return { phase: "target-copy", reconcilePaths: [from, to], status: "partial" };
      }
    } catch (error) {
      if (copied || mutationMayHaveApplied(error)) {
        return { phase: "target-copy", reconcilePaths: [from, to], status: "partial" };
      }
      throw error;
    }

    try {
      let result = await this.delete({ path: from, recursive: false });
      if (result.status != "applied") {
        return { phase: "source-remove", reconcilePaths: [from, to], status: "partial" };
      }
      return result;
    } catch {
      return { phase: "source-remove", reconcilePaths: [from, to], status: "partial" };
    }
  }

  private async copyDeleteDirectory(from: string, to: string): Promise<OpendalPathMutationResult> {
    await this.assertTargetMissing(to);
    let targetTouched = false;
    try {
      await this.createDirectory(to);
      targetTouched = true;
      let entries = await this.collectTree(from);
      for (let entry of entries.filter((entry) => entry.kind == "directory")) {
        await this.createDirectory(`${to}${entry.path.slice(from.length)}`);
      }
      for (let entry of entries.filter((entry) => entry.kind == "file")) {
        let source = await this.read(entry.path);
        let targetPath = `${to}${entry.path.slice(from.length)}`;
        await this.write({ bytes: source.bytes, path: targetPath });
        let target = await this.read(targetPath);
        if (!equalBytes(source.bytes, target.bytes)) {
          return { phase: "target-copy", reconcilePaths: [from, to], status: "partial" };
        }
      }
    } catch (error) {
      if (targetTouched || mutationMayHaveApplied(error)) {
        return { phase: "target-copy", reconcilePaths: [from, to], status: "partial" };
      }
      throw error;
    }

    try {
      let result = await this.delete({ path: from, recursive: true });
      if (result.status != "applied") {
        return { phase: "source-remove", reconcilePaths: [from, to], status: "partial" };
      }
      return result;
    } catch {
      return { phase: "source-remove", reconcilePaths: [from, to], status: "partial" };
    }
  }

  private async deleteRecursively(path: string): Promise<OpendalPathMutationResult> {
    try {
      let entries = await this.collectTree(path);
      let files = entries.filter((entry) => entry.kind == "file");
      let directories = entries
        .filter((entry) => entry.kind == "directory")
        .sort((a, b) => b.path.length - a.path.length);
      for (let entry of files) await this.operator.delete(entry.path, false);
      for (let entry of directories) await this.operator.delete(entry.path, false);
      await this.operator.delete(path, false);
      return { status: "applied" };
    } catch {
      return { phase: "recursive-delete", reconcilePaths: [path], status: "partial" };
    }
  }

  private async collectTree(root: string) {
    let entries: OpendalMetadata[] = [];
    let pending = [root];
    while (pending.length) {
      let directory = pending.shift()!;
      let children = await this.list(directory);
      entries.push(...children);
      pending.push(
        ...children.filter((entry) => entry.kind == "directory").map((entry) => entry.path),
      );
    }
    return entries;
  }

  private async assertTargetMissing(path: string) {
    try {
      await this.stat(path);
    } catch (error) {
      if (error instanceof OpendalBrowserError && error.code == "not-found") return;
      throw error;
    }
    throw new OpendalBrowserError({
      code: "already-exists",
      message: `OpenDAL rename target already exists: ${path}`,
      mutationOutcome: "not-applied",
      operation: "rename",
      path,
    });
  }

  private assertActive() {
    if (this.disposed) throw new Error("OpenDAL browser operator is disposed.");
  }
}

function sourceToGeneratedConfig(
  source: Exclude<OpendalBrowserSource, { kind: "browser-local" }>,
): GeneratedOperatorConfig {
  if (source.kind != "s3") {
    return {
      accessToken: requireText(source.accessToken, "accessToken"),
      provider: source.kind,
      root: normalizeRoot(source.root),
    };
  }
  return {
    accessKeyId: emptyToUndefined(source.credentials?.accessKeyId),
    bucket: requireText(source.bucket, "bucket"),
    endpoint: requireText(source.endpoint, "endpoint"),
    provider: "s3",
    region: requireText(source.region, "region"),
    root: normalizeRoot(source.root),
    secretAccessKey: emptyToUndefined(source.credentials?.secretAccessKey),
    sessionToken: emptyToUndefined(source.credentials?.sessionToken),
  };
}

function exactOperatorInfo(
  source: OpendalBrowserSource,
  raw: GeneratedCapabilities,
): OpendalOperatorInfo {
  let canCopyDeleteFile = raw.nativeRead && raw.nativeWrite && raw.nativeDelete;
  let canCopyDeleteDirectory = canCopyDeleteFile && raw.nativeList && raw.nativeCreateDir;
  let nativeRename = raw.nativeRename;
  return {
    capabilities: {
      createDirectory: raw.nativeCreateDir,
      delete: {
        recursive: raw.nativeDeleteWithRecursive
          ? "native"
          : raw.nativeDelete && raw.nativeList
            ? "emulated"
            : "unsupported",
        single: raw.nativeDelete,
      },
      list: raw.nativeList,
      read: raw.nativeRead,
      rename: {
        directory: nativeRename ? "native" : canCopyDeleteDirectory ? "copy-delete" : "unsupported",
        file: nativeRename ? "native" : canCopyDeleteFile ? "copy-delete" : "unsupported",
      },
      stat: raw.nativeStat,
      write: raw.nativeWrite,
      writeConditions: {
        ifMatch: raw.nativeWriteWithIfMatch,
        ifNotExists: source.kind == "dropbox" || Boolean(raw.nativeWriteWithIfNotExists),
        ifVersion: source.kind == "dropbox" || Boolean(raw.nativeWriteWithVersion),
      },
    },
    root: source.kind == "browser-local" ? "/" : (normalizeRoot(source.root) ?? "/"),
    scheme: source.kind,
  };
}

function toExactMetadata(entry: GeneratedEntry): OpendalMetadata {
  let kind: OpendalEntryKind;
  if (entry.isFile == entry.isDirectory) {
    throw new Error(`OpenDAL metadata returned an ambiguous entry kind for ${entry.path}.`);
  }
  kind = entry.isDirectory ? "directory" : "file";
  return {
    etag: entry.etag,
    kind,
    lastModified: entry.lastModified,
    path: normalizeExactPath(entry.path, {
      allowRoot: kind == "directory",
      directory: kind == "directory",
    }),
    size: entry.size,
    version: entry.version,
  };
}

function normalizeExactPath(
  rawPath: string,
  options: { allowRoot?: boolean; directory?: boolean; preserveDirectory?: boolean } = {},
) {
  if (typeof rawPath != "string") throw new TypeError("OpenDAL path must be a string.");
  let raw = rawPath.trim().replace(/\\/g, "/");
  if (raw.startsWith("/") && raw != "/") {
    throw new Error("OpenDAL paths must be relative to the workspace root.");
  }
  let parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part == "." || part == "..")) {
    throw new Error("OpenDAL paths cannot include . or .. segments.");
  }
  if (!parts.length) {
    if (options.allowRoot) return "";
    throw new Error("OpenDAL operation requires a non-root path.");
  }
  let path = parts.join("/");
  if (options.directory || (options.preserveDirectory && raw.endsWith("/"))) path += "/";
  return path;
}

function exactWriteOptions(
  condition: OpendalWriteCondition | undefined,
): GeneratedWriteOptions | undefined {
  if (!condition) return undefined;
  switch (condition.kind) {
    case "if-match":
      return { ifMatch: condition.etag };
    case "if-not-exists":
      return { ifNotExists: true };
    case "if-version":
      return { ifVersion: condition.version };
  }
}

function assertExactWriteCondition(
  capabilities: OpendalCapabilities,
  condition: OpendalWriteCondition | undefined,
  path: string,
) {
  if (!capabilities.write) throw unsupportedOperation("write", path);
  if (!condition) return;
  let supported =
    condition.kind == "if-match"
      ? capabilities.writeConditions.ifMatch
      : condition.kind == "if-version"
        ? capabilities.writeConditions.ifVersion
        : capabilities.writeConditions.ifNotExists;
  if (!supported) {
    throw new OpendalBrowserError({
      code: "unsupported",
      message: `OpenDAL backend does not support ${condition.kind} writes.`,
      mutationOutcome: "not-applied",
      operation: "write",
      path,
    });
  }
}

function unsupportedOperation(operation: OpendalOperation, path?: string) {
  return new OpendalBrowserError({
    code: "unsupported",
    message: `OpenDAL backend does not support ${operation}.`,
    mutationOutcome: operationIsMutation(operation) ? "not-applied" : undefined,
    operation,
    path,
  });
}

function normalizeOpendalError(
  cause: unknown,
  operation: OpendalOperation,
  path?: string,
  mutation = false,
  reconcilePaths = path ? [path] : undefined,
  mutationMayHaveStarted = false,
) {
  if (cause instanceof OpendalBrowserError) return cause;
  let message = cause instanceof Error ? cause.message : String(cause);
  let code: OpendalErrorCode = /condition|if[- ]?match|no[- ]?clobber|precondition|revision/i.test(
    message,
  )
    ? "condition-failed"
    : /not.?found|does not exist|404/i.test(message)
      ? "not-found"
      : /already.?exists|409|conflict/i.test(message)
        ? "already-exists"
        : /unauth|expired.?token|invalid.?token|401/i.test(message)
          ? "authentication-expired"
          : /permission|not.?allowed|forbidden|403|securityerror/i.test(message)
            ? "permission-denied"
            : /rate.?limit|too many requests|429/i.test(message)
              ? "rate-limited"
              : /unsupported|not.?supported/i.test(message)
                ? "unsupported"
                : /network|fetch|timeout|temporar|unavailable|502|503|504/i.test(message)
                  ? "temporary"
                  : "unknown";
  let knownNotApplied = [
    "already-exists",
    "authentication-expired",
    "condition-failed",
    "not-found",
    "permission-denied",
    "unsupported",
  ].includes(code);
  return new OpendalBrowserError({
    cause,
    code,
    message,
    mutationOutcome: mutation
      ? mutationMayHaveStarted
        ? "unknown"
        : knownNotApplied
          ? "not-applied"
          : "unknown"
      : undefined,
    operation,
    path,
    reconcilePaths:
      mutation && (mutationMayHaveStarted || !knownNotApplied) ? reconcilePaths : undefined,
  });
}

function operationIsMutation(operation: OpendalOperation) {
  return ["create-directory", "delete", "rename", "write"].includes(operation);
}

function mutationMayHaveApplied(error: unknown) {
  return error instanceof OpendalBrowserError && error.mutationOutcome != "not-applied";
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength != b.byteLength) return false;
  return a.every((value, index) => value == b[index]);
}

function hasDropboxWriteCondition(options: GeneratedWriteOptions | undefined) {
  return options?.ifNotExists === true || options?.ifVersion != null;
}

type DropboxAccessConfig = { accessToken: string; root?: string };

async function readDropboxBytes(
  config: DropboxAccessConfig,
  path: string,
): Promise<{ entry: GeneratedEntry; value: Uint8Array }> {
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
    value: new Uint8Array(await response.arrayBuffer()),
  };
}

async function writeDropboxBytes(
  config: DropboxAccessConfig,
  path: string,
  body: BodyInit,
  options: GeneratedWriteOptions,
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

function dropboxHeaders(config: DropboxAccessConfig, args: unknown) {
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
): GeneratedEntry {
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

function parseCapabilities(value: unknown): GeneratedCapabilities {
  let record = requireRecord(value, "capabilities");
  return {
    nativeCopy: Boolean(record.nativeCopy),
    nativeCreateDir: Boolean(record.nativeCreateDir),
    nativeDelete: Boolean(record.nativeDelete),
    nativeDeleteWithRecursive: Boolean(record.nativeDeleteWithRecursive),
    nativeList: Boolean(record.nativeList),
    nativeListWithRecursive: Boolean(record.nativeListWithRecursive),
    nativeRead: Boolean(record.nativeRead),
    nativeRename: Boolean(record.nativeRename),
    nativeStat: Boolean(record.nativeStat),
    nativeWrite: Boolean(record.nativeWrite),
    nativeWriteWithIfMatch: Boolean(record.nativeWriteWithIfMatch),
    nativeWriteWithIfNotExists: Boolean(record.nativeWriteWithIfNotExists),
    nativeWriteWithVersion: false,
  };
}

function parseEntries(value: unknown) {
  if (!Array.isArray(value)) throw new Error("OpenDAL list returned a non-array value.");
  return value.map((entry, index) => parseEntry(entry, `entry ${index}`));
}

function parseEntry(value: unknown, label = "entry"): GeneratedEntry {
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
