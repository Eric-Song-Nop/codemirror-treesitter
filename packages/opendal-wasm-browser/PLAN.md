# OpenDAL Browser WASM Wrapper Plan

## Objective

Build a browser-first OpenDAL wrapper that can be imported by
`apps/local-md-workspace` and used as a fully frontend storage backend for cloud
Markdown workspaces.

The first milestone is not a general OpenDAL JavaScript binding. It is a narrow
workspace storage adapter with enough operations to back the existing local
Markdown editor flow.

Current product direction: Dropbox is the first user-facing cloud workspace
with a pure frontend OAuth code flow using PKCE and short-lived access tokens.
OneDrive is the next cloud backend because OpenDAL exposes native metadata,
rename, and `write_with_if_match` support that can fit Grove's existing CRDT
conflict path. S3-compatible storage remains a useful OpenDAL/browser validation
track, but it is no longer the first user-facing cloud workspace target.

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
- The Dropbox MVP must not use `client_secret` or refresh tokens in the browser.
  It should use PKCE, keep only short-lived access tokens, and re-authorize when
  a token expires or Dropbox returns an expired-token error.
- The OneDrive browser product path should also start with short-lived access
  tokens. OpenDAL supports `refresh_token + client_id`, but storing or using
  refresh tokens in the frontend should be a separate explicit product decision.
- OpenDAL OneDrive currently targets OneDrive Personal through Microsoft Graph
  `/me/drive`; the minimum Graph scope for workspace file IO is `Files.ReadWrite`.
- The user-facing Dropbox flow is a normal browser OAuth login: the user clicks
  Connect Dropbox, signs in and approves access on Dropbox, and the app exchanges
  the returned authorization code for a short-lived access token with PKCE.
  Users should not manually obtain, paste, or store Dropbox access tokens.
- Long-lived cloud credentials in a frontend app are unsafe. Any S3-compatible
  provider path may accept user-provided credentials for experimentation, but
  should not store secrets by default.

## Non-Goals

- Do not expose the full OpenDAL API in the first iteration.
- Do not support every OpenDAL service.
- Do not replace the local File System Access API backend.
- Do not add a server gateway or presign service for this track.
- Do not implement Dropbox background/offline access for the MVP.
- Do not request or persist Dropbox refresh tokens for the MVP.
- Do not wire OneDrive UI/OAuth in the backend-foundation pass.
- Do not persist access keys or secret tokens unless a later design explicitly
  opts into encrypted or user-confirmed storage.

## Target API

The wrapper should expose a small TypeScript-friendly API:

```ts
export type OpendalBrowserProvider = "dropbox" | "onedrive" | "s3";

export type OpendalDropboxOperatorConfig = {
  provider: "dropbox";
  root?: string;
  accessToken: string;
};

export type OpendalOneDriveOperatorConfig = {
  provider: "onedrive";
  root?: string;
  accessToken: string;
};

export type OpendalS3OperatorConfig = {
  provider: "s3";
  endpoint: string;
  bucket: string;
  region: string;
  root?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export type OpendalBrowserOperatorConfig =
  | OpendalDropboxOperatorConfig
  | OpendalOneDriveOperatorConfig
  | OpendalS3OperatorConfig;

export type OpendalBrowserCapabilities = {
  nativeCopy: boolean;
  nativeDelete: boolean;
  nativeList: boolean;
  nativeRead: boolean;
  nativeRename: boolean;
  nativeCreateDir: boolean;
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
  list(prefix: string): Promise<OpendalBrowserEntry[]>;
  readText(path: string): Promise<string>;
  writeText(
    path: string,
    value: string,
    options?: OpendalBrowserWriteOptions,
  ): Promise<OpendalBrowserEntry | void>;
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

OAuth is intentionally outside the OpenDAL WASM wrapper. The app should obtain a
Dropbox access token with PKCE, then pass only the short-lived `accessToken` to
the wrapper.

## Phase 1: WASM Wrapper Spike

Status: implemented as an initial spike in this package.

1. Add Rust crate files under this package.
2. Add a minimal `wasm-pack` build path targeting the browser, likely
   `wasm-pack build --target web`.
3. Use OpenDAL with `default-features = false` and the smallest feature set that
   can compile for S3-compatible storage.
4. Expose only constructor plus `list`, `read_text`, `create_dir`,
   `write_text`, `delete`, `rename`, and `stat` through `wasm-bindgen`.
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
- The wrapper now supports `provider: "dropbox"`, `provider: "onedrive"`, and
  `provider: "s3"` at the TypeScript and Rust constructor layers.

## Phase 2: Dropbox Browser Provider Spike

Status: wrapper support implemented; real Dropbox browser smoke pending.

Add Dropbox as the first user-facing OpenDAL browser provider.

Required wrapper changes:

- [x] Enable OpenDAL's `services-dropbox` feature in this crate.
- [x] Add `provider: "dropbox"` to the TypeScript config union.
- [x] Add a Rust Dropbox builder branch that accepts `root` and `access_token`.
- [x] Do not expose `client_secret`, `refresh_token`, or automatic refresh in
      the browser wrapper.
- [x] Keep the existing S3 branch as a secondary provider path.

Current evidence:

- `vp run @codemirror-treesitter/opendal-wasm-browser#check:wasm` passes with
  both `services-dropbox` and `services-s3` enabled.
- `vp run @codemirror-treesitter/opendal-wasm-browser#build:wasm` generates a
  browser WASM package with Dropbox compiled in.
- `vp run @codemirror-treesitter/opendal-wasm-browser#build:ts` builds the
  TypeScript wrapper and declarations for the Dropbox/S3 config union.

Smoke-test operations:

- `list(root)`
- `writeText("smoke.md", "# Smoke\n")`
- `readText("smoke.md")`
- `rename("smoke.md", "smoke-renamed.md")`
- `delete("smoke-renamed.md")`

Dropbox validation setup:

- Use a Dropbox app with App Folder access for the first pass.
- Use scopes needed for Markdown workspace operations:
  `files.metadata.read`, `files.content.read`, and `files.content.write`.
- Direct short-lived access tokens are only a developer smoke-test shortcut for
  validating the wrapper and cloud operation sequence. They are not a product
  UX. The app-facing Dropbox connection must go through browser OAuth login with
  PKCE.
- Capture whether the OpenDAL Dropbox service compiles and works under
  `wasm32-unknown-unknown` with browser HTTP.
- Capture provider-specific rename, list, directory, conflict, and error
  behavior.

Exit criteria:

- Dropbox supports the complete workspace operation set in a real browser.
- Failures are classified as wrapper bug, OpenDAL WASM limitation, provider CORS
  limitation, OAuth/token issue, or Dropbox API behavior.

## Phase 3: Workspace Backend Abstraction

Status: implemented for the local File System Access backend.

Refactor `apps/local-md-workspace` so the UI no longer stores native
`FileSystemDirectoryHandle` and `FileSystemFileHandle` values inside Markdown
tree nodes.

Introduce a backend interface:

```ts
export type WorkspaceBackend = {
  id: string;
  kind: "local" | "opendal-dropbox" | "opendal-onedrive" | "opendal-s3";
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

Current implementation:

- `apps/local-md-workspace/src/lib/workspace-backend.ts` defines
  path-oriented tree nodes, `WorkspaceBackend`, shared path helpers, tree
  sorting, file flattening, and object-path tree synthesis helpers.
- `apps/local-md-workspace/src/lib/file-system.ts` now exposes
  `createLocalWorkspaceBackend(handle)` and keeps browser
  `FileSystemDirectoryHandle` / `FileSystemFileHandle` values inside the local
  backend only.
- `apps/local-md-workspace/src/App.tsx` stores a `WorkspaceBackend` and uses it
  for tree refresh, editor read, autosave, create, rename, and delete.
- Existing local image import/preview support is preserved through optional
  backend image methods so future cloud backends can opt in without putting
  native handles back into tree nodes.

Exit criteria:

- Existing local folder behavior still works.
- Tree nodes are path-oriented and storage-neutral.
- Editor read, autosave, create, rename, delete, and refresh all use the backend
  interface.

## Phase 4: Dropbox PKCE and Workspace Backend

Status: app-side implementation and local hardening coverage added; real
Dropbox OAuth/API smoke pending.

Add a Dropbox workspace backend in `apps/local-md-workspace` that calls this
package's browser wrapper with a short-lived access token.

Add app-side OAuth code flow with PKCE:

- Expose this as the app's user-facing Dropbox login flow, not as a token input
  form.
- Generate `code_verifier`, `code_challenge`, and `state` in the browser.
- Use `code_challenge_method=S256`.
- Store only transient OAuth transaction state needed to complete the redirect.
- Exchange the authorization code for an access token from the browser.
- Track `expires_in` from Dropbox and compute `expiresAt`.
- Re-authorize before operations when the token is near expiry.
- If Dropbox returns a token-expired error, re-authorize and retry the operation
  once when it is safe to do so.
- Do not request `token_access_type=offline` in the MVP.
- Do not store a refresh token.

Required behavior:

- [x] map Dropbox paths to Markdown tree nodes
- [x] filter `.md` files
- [x] synthesize directory nodes from Dropbox paths
- [x] preserve configured root folder isolation
- [x] normalize new file paths before writes
- [x] create missing folders only when Dropbox/OpenDAL requires it
- [x] handle rename fallback consistently through the wrapper-level `rename`
      API

Autosave requirements:

- [x] Treat Dropbox as a cloud backend with slower writes than the local File
      System Access backend.
- [x] Use a longer Dropbox autosave debounce than the current local 650ms
      debounce.
- [x] Keep per-file writes serialized so two saves for the same Dropbox path
      cannot race and land out of order.
- [x] Coalesce pending writes by saving the latest editor value after an
      in-flight save completes.
- [x] Continue forcing a save before file selection, refresh, rename, delete,
      and workspace switch.
- [x] Re-authorize and retry once when an access token expires during a save.
- [x] Preserve the current dirty editor value before any full-page OAuth
      redirect.
- [x] Prefer popup re-authorization for active autosave so the editor document
      stays mounted.
- [x] Keep dirty state intact on failed Dropbox writes and surface a recoverable
      save error.
- [x] Use last-write-wins for the MVP, but leave room for a later Dropbox
      revision-based conflict check.

Current implementation:

- `apps/local-md-workspace/src/lib/dropbox-oauth.ts` implements browser PKCE
  authorization with a popup-first flow, `code_challenge_method=S256`, Dropbox
  token exchange, `token_access_type=online`, full-page redirect fallback
  transaction recovery, `expires_in` tracking, and no offline token request.
- `apps/local-md-workspace/src/lib/dropbox-redirect-draft.ts` stores only
  tab-scoped Dropbox redirect recovery state in `sessionStorage`: public app
  key/root plus the current dirty Dropbox editor value and selected path when
  one exists.
- `apps/local-md-workspace/src/lib/opendal-workspace-backend.ts` implements the
  shared OpenDAL `WorkspaceBackend` behavior used by Dropbox and OneDrive:
  memory-only access tokens, near-expiry refresh/re-authorization callbacks,
  one retry for expired-token errors, write serialization, coalescing, parent
  directory creation, and backend revision tracking.
- `apps/local-md-workspace/src/lib/dropbox-workspace-backend.ts` is now the
  Dropbox adapter over that shared backend.
- The wrapper exposes `createDir`, and the Dropbox workspace backend ensures
  nested file parent directories before writes when the OpenDAL backend
  advertises `nativeCreateDir`.
- Dropbox autosave uses a longer app-side debounce than the local backend and a
  per-file write queue that serializes saves while coalescing pending editor
  values.
- If popup authorization is blocked during Dropbox connect or re-authorization,
  the app falls back to a full-page PKCE redirect, completes the token exchange
  after returning, reopens the Dropbox backend, restores the dirty editor draft
  when applicable, and resumes autosave.
- App error display now classifies Dropbox OAuth failures, expired tokens,
  missing file scopes, revoked/invalid authorization, token exchange failures,
  and unsupported storage operations into distinct recoverable messages.
- Dropbox remains last-write-wins for the user-facing MVP. The shared OpenDAL
  backend now carries revision metadata so providers with ETag support can opt
  into conditional writes.

Exit criteria:

- Dropbox workspace can be opened from the app with PKCE.
- Existing editor workflows work against Dropbox storage.
- Autosave handles token expiry, write latency, and save coalescing without
  losing the current editor contents.
- Error messages distinguish OAuth failure, expired token, missing scopes,
  revoked approval, and unsupported operation cases when possible.
- A real Dropbox App Folder OAuth/API smoke test covers list, read, write,
  rename, delete, autosave coalescing, and token-expiry recovery.

## Phase 5: Dropbox Workspace UI

Status: Dropbox entry, configured app-key OAuth connect flow, non-secret config
persistence, and connected provider/token expiry UI implemented; real Dropbox
OAuth smoke still pending.

Add a Dropbox open flow next to the existing local folder open flow.

App configuration:

- provider: Dropbox
- app key, from `VITE_DROPBOX_APP_KEY`
- redirect URI, from optional `VITE_DROPBOX_REDIRECT_URI` or derived from the
  current page by default
- optional root folder, from `VITE_DROPBOX_ROOT`, defaulting to the Dropbox app
  folder root

User flow:

- [x] Show a "Connect Dropbox" action.
- [x] Prefer a popup for Dropbox authorization and re-authorization during
      active editing.
- [x] If a full-page redirect is used, store enough dirty draft state in
      `sessionStorage` before leaving the page and restore it after returning.
- [x] Return to the app, complete token exchange, and open the Dropbox
      workspace.
- [x] Restore non-secret Dropbox config and expose a reconnect entry that asks
      Dropbox for a new short-lived token instead of reusing a stored token.
- [x] Show connected provider state and token expiry state while a Dropbox
      workspace is open.
- [x] Reconnect automatically when possible if the token expires during active
      use.

Secret handling:

- Dropbox app key is public and may be stored.
- Keep access tokens in memory or tab-scoped session storage only.
- Persist non-secret Dropbox config such as provider, root folder, and public app
  key.
- Do not store refresh tokens because the MVP must not request them.

Current implementation:

- `apps/local-md-workspace/src/lib/workspace-store.ts` persists only the public
  Dropbox app key and normalized root folder in `localStorage`.
- The user-facing Dropbox connect action uses the app-configured public
  `VITE_DROPBOX_APP_KEY` and starts OAuth directly; there is no user-facing app
  key input.
- If `VITE_DROPBOX_REDIRECT_URI` is set, OAuth uses that exact URI; otherwise it
  uses the current origin and path. Dropbox requires the value to exactly match
  a Redirect URI registered in the app console.
- When saved Dropbox config exists, the empty workspace state shows
  "Reconnect Dropbox"; choosing it starts a fresh PKCE popup authorization and
  requests a new short-lived access token.
- Reconnect uses the current app-configured public app key rather than treating a
  stored app key as an unconfigured-app fallback.
- The app tracks a non-secret Dropbox session view containing root and
  `expiresAt`, then shows a compact footer provider badge with Dropbox root and
  short-lived token expiry state while the workspace is open.
- The in-memory token cache is scoped to the Dropbox app key, so changing app
  keys cannot silently reuse a previous app's access token.
- If a popup is blocked, Dropbox authorization falls back to a full-page PKCE
  redirect. The app stores only transient tab-scoped redirect state, completes
  the code exchange after returning, restores the Dropbox workspace config, and
  reapplies the dirty editor draft for the selected Dropbox file when present.
- Browser automation verified the Dropbox connect action, hidden app-key/root
  configuration, and stored-config reconnect entry without requiring a real
  Dropbox credential.

Exit criteria:

- Users can open a Dropbox workspace without creating their own storage bucket or
  server.
- Restoring a Dropbox workspace restores non-secret configuration and asks
  Dropbox for a new short-lived token.
- Local folder restore remains unchanged.
- The app documents the local development requirement to build
  `packages/opendal-wasm-browser/pkg` before running the Dropbox workspace flow.

## Phase 6: Validation and Hardening

Status: local unit coverage, app UI browser/CDP checks, and credential-gated
Dropbox smoke task added; real Dropbox browser/API run still pending.

Add validation only after implementation exists:

- [x] wrapper build task
- [x] browser smoke fixture for a configured Dropbox app/token
- [x] credential-gated Dropbox operation smoke task
- [x] unit tests for PKCE verifier/challenge helpers and OAuth callback parsing
- [x] unit tests for path normalization and tree synthesis
- [x] unit tests for Dropbox write coalescing, missing parent directory
      creation, and expired-token retry
- [x] unit tests for non-secret Dropbox config persistence and normalization
- [x] unit tests for Dropbox popup-blocked fallback, full-page redirect OAuth
      transaction recovery, and redirect draft persistence
- [x] unit tests for workspace provider and Dropbox token-expiry status labels
- [x] unit tests for Dropbox/workspace error classification
- [x] app build task
- [x] manual browser checks for Dropbox entry, hidden app-key config, reconnect
      affordance, and stored config without provider credentials
- [x] manual browser check for default workspace footer layout after provider
      status UI wiring
- [x] browser/CDP check for local workspace open, create, edit, and autosave
      flow
- [x] credential-gated app browser/CDP smoke for real Dropbox workspace flow
- [x] local PKCE helper for obtaining a short-lived Dropbox token for developer
      smoke validation
- [x] optional local redirect callback mode for the Dropbox PKCE token helper
- [x] combined real Dropbox validation runner that executes wrapper and app UI
      smoke paths with one token
- [ ] real Dropbox app browser/CDP smoke run with a valid token
- [ ] real Dropbox credential run for list, write, read, rename, stat, and
      delete

Current implementation:

- `apps/local-md-workspace/src/lib/dropbox-oauth.test.ts` covers PKCE S256
  challenge generation, verifier URL-safety, Dropbox authorization URL shape,
  OAuth callback parsing, popup-blocked full-page redirect fallback startup, and
  full-page redirect OAuth transaction recovery.
- `apps/local-md-workspace/src/lib/dropbox-redirect-draft.test.ts` covers
  tab-scoped Dropbox redirect draft persistence, normalization, one-shot
  restore, and invalid draft rejection.
- `apps/local-md-workspace/src/lib/workspace-backend.test.ts` covers Markdown
  path normalization, traversal rejection, starter Markdown, and backend path
  tree synthesis.
- `apps/local-md-workspace/src/lib/dropbox-workspace-backend.test.ts` covers
  same-path write serialization/coalescing, missing parent directory creation,
  expired-token refresh retry, and Markdown-only Dropbox tree synthesis.
- `apps/local-md-workspace/src/lib/workspace-store.test.ts` covers Dropbox
  app-key/root config persistence, normalization, malformed stored data, and
  invalid app-key rejection.
- `apps/local-md-workspace/src/lib/workspace-status.test.ts` covers local
  provider status, Dropbox root labels, and Dropbox short-lived token expiry
  labels including expired and unknown states.
- `apps/local-md-workspace/src/lib/workspace-errors.test.ts` covers
  user-facing messages for Dropbox OAuth failure, expired access tokens, missing
  file scopes, revoked/invalid authorization, token exchange failures, and
  unsupported operations.
- `packages/opendal-wasm-browser/smoke/main.ts` now runs the full browser
  operation sequence from local-storage config.
- `packages/opendal-wasm-browser/smoke/dropbox-smoke.mjs` runs the Dropbox
  operation sequence when `OPENDAL_DROPBOX_ACCESS_TOKEN` is set and exits
  cleanly without provider work otherwise.
- `packages/opendal-wasm-browser/smoke/dropbox-token.mjs` provides a local
  PKCE helper for developer validation: it prints a Dropbox OAuth URL, accepts
  the copied authorization code, exchanges it without a client secret, requests
  `token_access_type=online`, and prints temporary token environment variables
  for the app and wrapper smoke tasks. When a local Dropbox redirect URI is
  configured, the helper can also listen for the callback and capture the code
  automatically.
- `packages/opendal-wasm-browser/smoke/dropbox-validate.mjs` combines the two
  real Dropbox validation paths: it normalizes the token environment for both
  smoke tasks, runs the wrapper Dropbox operation smoke, starts the local
  Markdown workspace dev server on an available local port, runs the app UI
  Dropbox smoke, and stops the server.
- `agent-browser` verified the local Dropbox UI entry, hidden app-key/root
  configuration, reconnect button, and saved-config behavior at
  `http://127.0.0.1:5173/`.
- `apps/local-md-workspace/smoke/ui-smoke.mjs` runs a headless Chromium CDP
  smoke that verifies the local app renders, exposes the Dropbox entry, does
  not expose Dropbox app-key/root fields to users, restores saved Dropbox config
  behavior, and exercises the local workspace open/create/edit/autosave flow at
  `http://127.0.0.1:5173/`.
- When `LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN` or
  `OPENDAL_DROPBOX_ACCESS_TOKEN` is set, the same UI smoke stubs only the app
  OAuth token exchange, opens a real Dropbox workspace through the app,
  creates and edits a temporary Markdown file, waits for Dropbox API download to
  return the autosaved value, and deletes the temporary file.

Repository-level validation:

```bash
vp check
vp test
vp run local-md-workspace#build
OPENDAL_DROPBOX_APP_KEY="..." vp run @codemirror-treesitter/opendal-wasm-browser#auth:dropbox-token
vp run @codemirror-treesitter/opendal-wasm-browser#validate:dropbox
```

Optional provider validation should be gated by environment variables so normal
CI does not require Dropbox credentials or cloud credentials.

The token environment variables below are local developer smoke inputs only.
They should not appear in the user-facing Dropbox connection flow.

```bash
LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN="..." \
  LOCAL_MD_WORKSPACE_DROPBOX_ROOT="optional/root" \
  vp run local-md-workspace#smoke:ui

OPENDAL_DROPBOX_ACCESS_TOKEN="..." \
  OPENDAL_DROPBOX_ROOT="optional/root" \
  vp run @codemirror-treesitter/opendal-wasm-browser#validate:dropbox
```

## Phase 7: OneDrive Backend Foundation

Status: wrapper and app backend foundation implemented; OneDrive OAuth/UI and
real provider smoke are pending.

The implementation order for OneDrive should stay separate from the Dropbox
user-facing flow:

1. Add OpenDAL OneDrive support to the WASM wrapper.
2. Surface metadata and conditional write support in the normalized TypeScript
   API.
3. Share the cloud workspace backend logic between Dropbox and OneDrive.
4. Feed OneDrive ETags into conditional writes so 412 Precondition Failed
   becomes a normal workspace write conflict.
5. Reuse the existing Loro/CRDT conflict path: on conditional-write failure, read
   the provider's current source, ingest it into the document, materialize the
   merged Markdown, and write again against the refreshed revision.
6. Add OneDrive OAuth/UI after the backend semantics are covered.
7. Add credential-gated real OneDrive smoke after UI/OAuth exists.

Current implementation:

- `packages/opendal-wasm-browser` enables OpenDAL `services-onedrive`, accepts
  `provider: "onedrive"` with a short-lived `accessToken`, and exposes
  `nativeWriteWithIfMatch`.
- `writeText(path, value, { ifMatch })` forwards `If-Match` only when the backend
  advertises native conditional-write support, then returns normalized write
  metadata.
- `OpendalBrowserEntry` includes `etag`, `version`, `lastModified`, and `size`
  when OpenDAL provides those values.
- `apps/local-md-workspace/src/lib/opendal-workspace-backend.ts` stores known
  source revisions from `stat`, `list`, `read`, and successful writes.
- `apps/local-md-workspace/src/lib/onedrive-workspace-backend.ts` creates an
  `opendal-onedrive` workspace backend over the shared OpenDAL backend.
- `apps/local-md-workspace/src/lib/workspace-file-conflict.ts` classifies
  412/Precondition Failed/ConditionNotMatch errors as write conflicts so the
  existing CRDT merge retry path can handle them.

Next OneDrive work:

- Add Microsoft OAuth PKCE helpers and non-secret config storage in
  `apps/local-md-workspace`.
- Add user-facing Connect/Reconnect OneDrive UI without refresh-token storage.
- Add OneDrive-specific user-facing error messages for denied consent, missing
  `Files.ReadWrite`, expired token, and provider throttling/conflict responses.
- Add credential-gated wrapper and app smoke tasks for real OneDrive file IO.
- Decide separately whether any future refresh-token mode is acceptable in the
  browser product.

## Deferred S3-Compatible Track

The current S3 wrapper work remains useful, but it is no longer the primary
product path.

Keep the S3-compatible provider as a secondary validation track for:

- MinIO local CORS testing
- Cloudflare R2
- AWS S3

S3-specific future work:

- add an `opendal-s3` workspace backend in `apps/local-md-workspace`
- add a cloud config form for endpoint, bucket, region, root prefix, access key
  ID, secret access key, and optional session token
- keep S3 credentials in memory by default
- persist only non-secret S3 config
- classify CORS, credentials, missing bucket, and unsupported-operation errors

## Open Questions

- Should the first Dropbox app use App Folder access only, or allow Full Dropbox
  for advanced users later?
- Should deployed builds require an explicit `VITE_DROPBOX_REDIRECT_URI`, or keep
  deriving it from the current page when no override is configured?
- Should the S3-compatible provider remain visible in the UI as an advanced
  option, or stay hidden until Dropbox is stable?
- Should the wrapper live as a private workspace package indefinitely, or become
  publishable after browser support is proven?
- Should WebDAV be added as a pure TypeScript fallback if OpenDAL WASM support is
  blocked?
