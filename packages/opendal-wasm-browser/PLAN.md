# OpenDAL Browser WASM Wrapper Plan

## Objective

Build a browser-first OpenDAL wrapper that can be imported by
`apps/local-md-workspace` and used as a fully frontend storage backend for cloud
Markdown workspaces.

The first milestone is not a general OpenDAL JavaScript binding. It is a narrow
workspace storage adapter with enough operations to back the existing local
Markdown editor flow.

## Key Constraints

- The published `opendal` npm package is a Node.js native binding, not a browser
  package.
- `wasm32-unknown-unknown` makes a Rust crate buildable for a browser-style WASM
  target, but it does not provide JavaScript glue, Vite integration, CORS
  permissions, credentials, or browser service compatibility by itself.
- Browser-compatible services must use browser-accessible APIs, mainly HTTP via
  `fetch`-style behavior. TCP, POSIX file system, database, and native OS
  services are out of scope for the browser wrapper.
- Cloud storage CORS configuration remains mandatory. A WASM wrapper cannot
  bypass browser same-origin policy.
- Long-lived cloud credentials in a frontend app are unsafe. The first version
  may accept user-provided credentials for experimentation, but should not store
  secrets by default.

## Non-Goals

- Do not expose the full OpenDAL API in the first iteration.
- Do not support every OpenDAL service.
- Do not replace the local File System Access API backend.
- Do not add a server gateway or presign service for this track.
- Do not persist access keys or secret tokens unless a later design explicitly
  opts into encrypted or user-confirmed storage.

## Target API

The wrapper should expose a small TypeScript-friendly API:

```ts
export type OpendalBrowserOperatorConfig = {
  provider: "s3";
  endpoint: string;
  bucket: string;
  region: string;
  root?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export type OpendalBrowserCapabilities = {
  nativeRename: boolean;
  nativeCreateDir: boolean;
};

export type OpendalBrowserEntry = {
  isDirectory: boolean;
  isFile: boolean;
  path: string;
};

export type OpendalBrowserOperator = {
  capabilities(): OpendalBrowserCapabilities;
  list(prefix: string): Promise<OpendalBrowserEntry[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, value: string): Promise<void>;
  delete(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<OpendalBrowserEntry>;
};

export function createOpendalBrowserOperator(
  config: OpendalBrowserOperatorConfig,
): Promise<OpendalBrowserOperator>;
```

`rename` should call OpenDAL native rename when available. If a backend cannot
rename natively, it may fall back to read/write/delete or copy/delete if those
capabilities are available.

## Phase 1: WASM Wrapper Spike

Status: implemented as an initial spike in this package.

1. Add Rust crate files under this package.
2. Add a minimal `wasm-pack` build path targeting the browser, likely
   `wasm-pack build --target web`.
3. Use OpenDAL with `default-features = false` and the smallest feature set that
   can compile for S3-compatible storage.
4. Expose only constructor plus `list`, `read_text`, `write_text`, `delete`,
   `rename`, and `stat` through `wasm-bindgen`.
5. Generate TypeScript declarations or provide a hand-written wrapper that
   normalizes the generated API.
6. Add a Vite fixture or package-local browser smoke page that imports the WASM
   output.

Exit criteria:

- The package builds a browser-loadable `.wasm` artifact.
- A Vite page can import the wrapper without Node polyfills.
- The wrapper can construct an S3-compatible operator in a browser.

Current evidence:

- `wasm-pack build --target web` generates `pkg/opendal_wasm_browser_bg.wasm`.
- `vp pack` builds the TypeScript wrapper into `dist/`.
- `smoke/index.html` provides a browser fixture for the generated wrapper.
- Real S3-compatible provider operations still need Phase 2 validation.

## Phase 2: Real Browser Storage Smoke Tests

Use a real S3-compatible target with explicit CORS configuration. Recommended
test order:

1. MinIO with local CORS configuration.
2. Cloudflare R2.
3. AWS S3.

Smoke-test operations:

- `list(root)`
- `writeText("smoke.md", "# Smoke\n")`
- `readText("smoke.md")`
- `rename("smoke.md", "smoke-renamed.md")`
- `delete("smoke-renamed.md")`

Capture provider-specific requirements:

- required CORS methods and headers
- endpoint URL shape
- region handling
- virtual-hosted vs path-style addressing
- whether rename is native or requires fallback
- request headers that must be exposed to browser JavaScript

Exit criteria:

- At least one provider supports the complete workspace operation set in a real
  browser.
- Failures are classified as wrapper bug, OpenDAL WASM limitation, provider CORS
  limitation, or credential/configuration issue.

## Phase 3: Workspace Backend Abstraction

Refactor `apps/local-md-workspace` so the UI no longer stores native
`FileSystemDirectoryHandle` and `FileSystemFileHandle` values inside Markdown
tree nodes.

Introduce a backend interface:

```ts
export type WorkspaceBackend = {
  id: string;
  kind: "local" | "opendal-s3";
  name: string;
  readTree(): Promise<MarkdownDirectoryNode>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, value: string): Promise<void>;
  createFile(path: string): Promise<string>;
  deleteFile(path: string): Promise<void>;
  renameFile(path: string, rawName: string): Promise<string>;
};
```

Move existing File System Access behavior into a local backend implementation.
Move path normalization, starter Markdown generation, and tree sorting into
backend-neutral helpers.

Exit criteria:

- Existing local folder behavior still works.
- Tree nodes are path-oriented and storage-neutral.
- Editor read, autosave, create, rename, delete, and refresh all use the backend
  interface.

## Phase 4: OpenDAL Backend Integration

Add an `opendal-s3` workspace backend in `apps/local-md-workspace` that calls
this package's browser wrapper.

Required behavior:

- map object keys to Markdown tree nodes
- filter `.md` files
- synthesize directory nodes from object prefixes
- preserve root prefix isolation
- normalize new file paths before writes
- create missing object prefixes only when the backend requires it
- handle rename fallback consistently

Exit criteria:

- Cloud workspace can be opened from the app.
- Existing editor workflows work against cloud storage.
- Error messages distinguish CORS, credentials, missing bucket, and unsupported
  operation cases when possible.

## Phase 5: Cloud Workspace UI

Add a cloud open flow next to the existing local folder open flow.

Initial form fields:

- provider: S3-compatible
- endpoint
- bucket
- region
- root prefix
- access key ID
- secret access key
- optional session token

Secret handling:

- keep credentials in memory by default
- persist non-secret config in IndexedDB
- add a clear warning before any future "remember secret" option

Exit criteria:

- Users can open a configured cloud workspace.
- Restoring a cloud workspace restores non-secret configuration and asks for
  credentials again.
- Local folder restore remains unchanged.

## Phase 6: Validation and Hardening

Add validation only after implementation exists:

- wrapper build task
- browser smoke task for a configured S3-compatible target
- unit tests for path normalization and tree synthesis
- app build task
- manual Playwright checks for local and cloud workspace flows

Repository-level validation:

```bash
vp check
vp test
vp run local-md-workspace#build
```

Optional provider validation should be gated by environment variables so normal
CI does not require cloud credentials.

## Open Questions

- Which S3-compatible provider should be the first supported target?
- Should path-style addressing be configurable from the UI?
- Should credentials remain memory-only forever, or should the app offer an
  explicit encrypted/session-scoped persistence option?
- Should the wrapper live as a private workspace package indefinitely, or become
  publishable after browser support is proven?
- Should WebDAV be added as a pure TypeScript fallback if OpenDAL WASM support is
  blocked?
