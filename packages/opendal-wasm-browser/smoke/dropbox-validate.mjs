import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SMOKE_URL_TIMEOUT_MS = 60_000;

let packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let repoRoot = resolve(packageRoot, "../..");
let options = parseArgs(process.argv.slice(2));
let token =
  process.env.OPENDAL_DROPBOX_ACCESS_TOKEN || process.env.LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN;

if (options.help) {
  printHelp();
  process.exit(0);
}

if (!token) {
  console.log(
    "Skipping real Dropbox validation: OPENDAL_DROPBOX_ACCESS_TOKEN and LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN are not set.",
  );
  console.log(
    "Get a short-lived token with `OPENDAL_DROPBOX_APP_KEY=... vp run @codemirror-treesitter/opendal-wasm-browser#auth:dropbox-token`.",
  );
  process.exit(options.requireToken ? 1 : 0);
}

let env = createValidationEnv(token);
await run("vp", ["run", "@codemirror-treesitter/opendal-wasm-browser#smoke:dropbox"], {
  cwd: repoRoot,
  env,
});

let port = options.port ?? (await findFreePort());
let smokeUrl = "http://127.0.0.1:" + String(port) + "/";
let server = spawn(
  "vp",
  [
    "run",
    "local-md-workspace#dev",
    "--",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: repoRoot,
    detached: process.platform != "win32",
    env,
    stdio: "inherit",
  },
);

try {
  await waitForServer(smokeUrl, server);
  await run("vp", ["run", "local-md-workspace#smoke:ui"], {
    cwd: repoRoot,
    env: {
      ...env,
      LOCAL_MD_WORKSPACE_SMOKE_URL: smokeUrl,
    },
  });
} finally {
  await stopProcess(server);
}

console.log("Real Dropbox validation passed.");

function createValidationEnv(token) {
  let next = {
    ...process.env,
    LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN: token,
    OPENDAL_DROPBOX_ACCESS_TOKEN: token,
  };

  next.LOCAL_MD_WORKSPACE_DROPBOX_APP_KEY =
    process.env.LOCAL_MD_WORKSPACE_DROPBOX_APP_KEY ||
    process.env.OPENDAL_DROPBOX_APP_KEY ||
    "smoke-app-key";
  next.VITE_DROPBOX_APP_KEY =
    process.env.VITE_DROPBOX_APP_KEY || next.LOCAL_MD_WORKSPACE_DROPBOX_APP_KEY;

  if (process.env.OPENDAL_DROPBOX_ROOT && !process.env.LOCAL_MD_WORKSPACE_DROPBOX_ROOT) {
    next.LOCAL_MD_WORKSPACE_DROPBOX_ROOT = process.env.OPENDAL_DROPBOX_ROOT;
  }
  if (process.env.LOCAL_MD_WORKSPACE_DROPBOX_ROOT && !process.env.OPENDAL_DROPBOX_ROOT) {
    next.OPENDAL_DROPBOX_ROOT = process.env.LOCAL_MD_WORKSPACE_DROPBOX_ROOT;
  }
  if (next.LOCAL_MD_WORKSPACE_DROPBOX_ROOT && !process.env.VITE_DROPBOX_ROOT) {
    next.VITE_DROPBOX_ROOT = next.LOCAL_MD_WORKSPACE_DROPBOX_ROOT;
  }

  return next;
}

function run(command, args, options) {
  return new Promise((resolveRun, reject) => {
    let child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code == 0) {
        resolveRun();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit ${code}`}.`));
      }
    });
  });
}

async function waitForServer(url, child) {
  let started = Date.now();
  while (Date.now() - started < SMOKE_URL_TIMEOUT_MS) {
    if (child.exitCode != null) {
      throw new Error(`local-md-workspace dev server exited before ${url} was reachable.`);
    }

    if (await canFetch(url)) return;
    await sleep(500);
  }

  throw new Error(`Timed out waiting for local-md-workspace dev server at ${url}.`);
}

async function canFetch(url) {
  try {
    let response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    let server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      let address = server.address();
      server.close(() => {
        if (address && typeof address == "object") {
          resolvePort(address.port);
        } else {
          reject(new Error("Could not allocate a local validation port."));
        }
      });
    });
  });
}

async function stopProcess(child) {
  if (child.exitCode != null) return;

  let exited = new Promise((resolveExit) => {
    child.once("exit", resolveExit);
  });

  try {
    if (process.platform == "win32") {
      child.kill("SIGTERM");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {}

  await Promise.race([
    exited,
    sleep(5_000).then(() => {
      try {
        if (process.platform == "win32") {
          child.kill("SIGKILL");
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {}
    }),
  ]);
}

function parseArgs(args) {
  let result = {
    help: false,
    port: null,
    requireToken: false,
  };

  for (let index = 0; index < args.length; index++) {
    let arg = args[index];
    if (arg == "--") {
      continue;
    } else if (arg == "--help" || arg == "-h") {
      result.help = true;
    } else if (arg == "--port") {
      result.port = parsePort(args[++index]);
    } else if (arg.startsWith("--port=")) {
      result.port = parsePort(arg.slice("--port=".length));
    } else if (arg == "--require-token") {
      result.requireToken = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}

function parsePort(value) {
  let port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printHelp() {
  console.log(`Usage:
  OPENDAL_DROPBOX_ACCESS_TOKEN=... vp run @codemirror-treesitter/opendal-wasm-browser#validate:dropbox

Options:
  --port <port>       Local dev server port for the app UI smoke.
  --require-token     Exit with failure instead of skipping when no token is set.
  --help              Show this help.

The runner executes both real Dropbox validation paths: the OpenDAL wrapper
operation smoke and the local-md-workspace UI smoke. It starts and stops the app
dev server automatically.`);
}
