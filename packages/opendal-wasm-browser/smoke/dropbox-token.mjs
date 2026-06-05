import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DROPBOX_AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const DEFAULT_SCOPES = ["files.metadata.read", "files.content.read", "files.content.write"];
const DEFAULT_CALLBACK_TIMEOUT_MS = 180_000;

let options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

let appKey =
  options.appKey ||
  process.env.OPENDAL_DROPBOX_APP_KEY ||
  process.env.LOCAL_MD_WORKSPACE_DROPBOX_APP_KEY ||
  "";
let scopes = parseScopes(options.scopes || process.env.OPENDAL_DROPBOX_SCOPES);
let redirectUri =
  options.redirectUri ||
  process.env.OPENDAL_DROPBOX_REDIRECT_URI ||
  process.env.LOCAL_MD_WORKSPACE_DROPBOX_REDIRECT_URI ||
  "";

if (!appKey.trim()) {
  console.error(
    "Dropbox app key is required. Set OPENDAL_DROPBOX_APP_KEY or pass --app-key <app-key>.",
  );
  process.exit(1);
}

let codeVerifier = base64Url(randomBytes(64));
let codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
let state = base64Url(randomBytes(32));
let authorizeUrl = createAuthorizeUrl({
  appKey: appKey.trim(),
  codeChallenge,
  redirectUri,
  scopes,
  state,
});

let callbackServer = redirectUri ? createLocalCallbackServer(redirectUri, state) : null;
if (callbackServer) await callbackServer.start();

console.log("Open this Dropbox OAuth URL in a browser:");
console.log(authorizeUrl.href);
console.log("");
if (callbackServer) {
  console.log(`Waiting for Dropbox to redirect back to ${redirectUri}.`);
} else {
  console.log("After approval, Dropbox will show an authorization code. Paste it here.");
}
console.log(
  "This helper uses PKCE, does not use a client secret, and does not request offline access.",
);
console.log("");

if (options.printUrlOnly) {
  await callbackServer?.close();
  process.exit(0);
}

if (options.openBrowser) {
  openBrowser(authorizeUrl.href);
}

let code;
try {
  code = callbackServer
    ? await callbackServer.wait(options.timeoutMs)
    : await promptForAuthorizationCode(state);
} finally {
  await callbackServer?.close();
}

if (!code) {
  console.error("No Dropbox authorization code was provided.");
  process.exit(1);
}

let token = await exchangeCodeForToken({
  appKey: appKey.trim(),
  code,
  codeVerifier,
  redirectUri,
});

console.log("");
console.log(
  `Received a Dropbox access token${token.expiresIn ? ` that expires in ${token.expiresIn}s` : ""}.`,
);
console.log("Use it only for local smoke validation; do not persist it in app storage.");
console.log("");
console.log("export OPENDAL_DROPBOX_ACCESS_TOKEN=" + shellQuote(token.accessToken));
console.log("export LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN=" + shellQuote(token.accessToken));

function createAuthorizeUrl(options) {
  let url = new URL(DROPBOX_AUTHORIZE_URL);
  url.searchParams.set("client_id", options.appKey);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (options.redirectUri) {
    url.searchParams.set("redirect_uri", options.redirectUri);
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", options.scopes.join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("token_access_type", "online");
  return url;
}

async function exchangeCodeForToken(options) {
  let body = new URLSearchParams();
  body.set("client_id", options.appKey);
  body.set("code", options.code);
  body.set("code_verifier", options.codeVerifier);
  body.set("grant_type", "authorization_code");
  if (options.redirectUri) {
    body.set("redirect_uri", options.redirectUri);
  }

  let response = await fetch(DROPBOX_TOKEN_URL, {
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  let payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(tokenError(payload) ?? `Dropbox token exchange failed (${response.status}).`);
  }

  if (!payload || typeof payload.access_token != "string") {
    throw new Error("Dropbox token exchange returned an invalid response.");
  }

  return {
    accessToken: payload.access_token,
    expiresIn: parseExpiresIn(payload.expires_in),
  };
}

function parseAuthorizationCode(value, expectedState) {
  let trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("code=") || trimmed.startsWith("state=")) {
    let params = new URLSearchParams(trimmed);
    let state = params.get("state");
    if (state && state != expectedState) {
      throw new Error("Pasted Dropbox callback parameters have a different OAuth state.");
    }
    return params.get("code");
  }

  try {
    let url = new URL(trimmed);
    let state = url.searchParams.get("state");
    if (state && state != expectedState) {
      throw new Error("Pasted Dropbox callback URL has a different OAuth state.");
    }
    return url.searchParams.get("code");
  } catch (error) {
    if (error instanceof TypeError) return trimmed;
    throw error;
  }
}

async function promptForAuthorizationCode(expectedState) {
  let rl = createInterface({ input, output });
  try {
    let rawCode = await rl.question("Dropbox authorization code or callback URL: ");
    return parseAuthorizationCode(rawCode, expectedState);
  } finally {
    rl.close();
  }
}

function createLocalCallbackServer(redirectUri, expectedState) {
  let url = new URL(redirectUri);
  if (url.protocol != "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    return null;
  }

  let port = Number(url.port || "80");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid local Dropbox redirect URI port: ${redirectUri}`);
  }

  let expectedPath = url.pathname || "/";
  let resolveCode;
  let rejectCode;
  let codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  let server = createServer((request, response) => {
    let requestUrl = new URL(request.url ?? "/", redirectUri);
    if (requestUrl.pathname != expectedPath) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found.");
      return;
    }

    try {
      let callback = parseAuthorizationCallback(requestUrl.searchParams, expectedState);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><title>Dropbox authorized</title><p>Dropbox authorized. You can close this tab.</p>",
      );
      resolveCode(callback);
    } catch (error) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><title>Dropbox authorization failed</title><p>Dropbox authorization failed. Return to the terminal for details.</p>",
      );
      rejectCode(error);
    }
  });

  return {
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(resolve);
      });
    },
    start() {
      return new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(port, url.hostname, resolve);
      });
    },
    wait(timeoutMs) {
      let timeout = setTimeout(() => {
        rejectCode(new Error(`Timed out waiting for Dropbox callback at ${redirectUri}.`));
      }, timeoutMs);
      return codePromise.finally(() => clearTimeout(timeout));
    },
  };
}

function parseAuthorizationCallback(params, expectedState) {
  let state = params.get("state");
  if (state != expectedState) {
    throw new Error("Dropbox callback state did not match.");
  }

  let error = params.get("error");
  if (error) {
    let description = params.get("error_description");
    throw new Error(description ? `${error}: ${description}` : error);
  }

  let code = params.get("code");
  if (!code) throw new Error("Dropbox callback did not include an authorization code.");
  return code;
}

function parseExpiresIn(value) {
  let expiresIn = typeof value == "number" ? value : typeof value == "string" ? Number(value) : NaN;
  return Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null;
}

function parseScopes(value) {
  if (!value) return DEFAULT_SCOPES;
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function parseArgs(args) {
  let result = {
    appKey: "",
    help: false,
    openBrowser: false,
    printUrlOnly: false,
    redirectUri: "",
    scopes: "",
    timeoutMs: DEFAULT_CALLBACK_TIMEOUT_MS,
  };

  for (let index = 0; index < args.length; index++) {
    let arg = args[index];
    if (arg == "--") {
      continue;
    } else if (arg == "--help" || arg == "-h") {
      result.help = true;
    } else if (arg == "--print-url-only") {
      result.printUrlOnly = true;
    } else if (arg == "--open") {
      result.openBrowser = true;
    } else if (arg == "--app-key") {
      result.appKey = args[++index] ?? "";
    } else if (arg.startsWith("--app-key=")) {
      result.appKey = arg.slice("--app-key=".length);
    } else if (arg == "--redirect-uri") {
      result.redirectUri = args[++index] ?? "";
    } else if (arg.startsWith("--redirect-uri=")) {
      result.redirectUri = arg.slice("--redirect-uri=".length);
    } else if (arg == "--scopes") {
      result.scopes = args[++index] ?? "";
    } else if (arg.startsWith("--scopes=")) {
      result.scopes = arg.slice("--scopes=".length);
    } else if (arg == "--timeout-ms") {
      result.timeoutMs = parsePositiveInteger(args[++index], arg);
    } else if (arg.startsWith("--timeout-ms=")) {
      result.timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}

function parsePositiveInteger(value, label) {
  let number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return number;
}

function tokenError(value) {
  if (!value || typeof value != "object") return null;
  if (typeof value.error_description == "string") return value.error_description;
  if (typeof value.error == "string") return value.error;
  return null;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform == "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform == "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  let child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function printHelp() {
  console.log(`Usage:
  OPENDAL_DROPBOX_APP_KEY=... vp run @codemirror-treesitter/opendal-wasm-browser#auth:dropbox-token
  node smoke/dropbox-token.mjs --app-key <app-key>

Options:
  --app-key <value>       Dropbox public app key. Env fallback:
                          OPENDAL_DROPBOX_APP_KEY or LOCAL_MD_WORKSPACE_DROPBOX_APP_KEY.
  --redirect-uri <url>    Optional redirect URI. Env fallback:
                          OPENDAL_DROPBOX_REDIRECT_URI or LOCAL_MD_WORKSPACE_DROPBOX_REDIRECT_URI.
                          Local http://127.0.0.1:<port>/... URIs are listened on automatically.
  --scopes <value>        Space or comma separated scopes. Env fallback:
                          OPENDAL_DROPBOX_SCOPES.
  --open                  Open the authorization URL in the system browser.
  --print-url-only        Print the PKCE authorization URL without exchanging a code.
  --timeout-ms <value>    Callback wait timeout for local redirect mode.
  --help                  Show this help.

The helper uses OAuth code flow with PKCE and token_access_type=online. It does
not use a client secret and does not request a refresh token.`);
}
