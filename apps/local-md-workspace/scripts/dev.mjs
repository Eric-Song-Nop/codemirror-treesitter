import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELAY_READY_TIMEOUT_MS = 30_000;
const RELAY_READY_POLL_MS = 250;

let appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let repoRoot = resolve(appRoot, "../..");
let relayRoot = resolve(repoRoot, "apps/collab-editor");
let options = parseArgs(process.argv.slice(2));
let frontendArgs = options.frontendArgs;

if (frontendArgs.includes("--help") || frontendArgs.includes("-h")) {
  printHelp();
  process.exit(0);
}

let relayOrigin = configuredRelayOrigin(options.relayOrigin);
let relayUrl = new URL(relayOrigin);
let shouldStartRelay = shouldStartLocalRelay(relayUrl);
let relayChild = null;
let frontendChild = null;
let shuttingDown = false;

installSignalHandlers();

if (shouldStartRelay) {
  if (await relayIsReady(relayOrigin)) {
    console.log(`[local-md-workspace] Using existing local relay at ${relayOrigin}`);
  } else {
    relayChild = spawnRelay(relayUrl);
    await waitForRelay(relayOrigin, relayChild);
  }
} else {
  console.log(`[local-md-workspace] Using configured external relay at ${relayOrigin}`);
}

frontendChild = spawnFrontend(relayOrigin, frontendArgs);

await waitForFrontendExit(frontendChild);

function parseArgs(args) {
  let remaining = args[0] == "--" ? args.slice(1) : args;
  let relayOrigin = null;
  let frontendArgs = [];

  for (let index = 0; index < remaining.length; index += 1) {
    let arg = remaining[index];
    if (arg == "--relay-origin") {
      relayOrigin = remaining[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--relay-origin=")) {
      relayOrigin = arg.slice("--relay-origin=".length);
      continue;
    }
    frontendArgs.push(arg);
  }

  if (relayOrigin != null && !relayOrigin.trim()) {
    console.error("[local-md-workspace] --relay-origin requires a URL origin.");
    process.exit(1);
  }

  return { frontendArgs, relayOrigin };
}

function configuredRelayOrigin(cliOrigin) {
  let configured = cliOrigin?.trim() || process.env.VITE_LOCAL_MD_SHARE_RELAY_ORIGIN?.trim();
  if (configured) return new URL(configured).origin;

  return "http://127.0.0.1:8787";
}

function shouldStartLocalRelay(url) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
}

function spawnRelay(url) {
  console.log(`[local-md-workspace] Starting local relay at ${url.origin}`);
  let child = spawn(
    "vp",
    ["dev", "--host", relayHostForCli(url), "--port", relayPortForCli(url), "--strictPort"],
    {
      cwd: relayRoot,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    let reason = signal ?? `exit ${code ?? 1}`;
    console.error(`[local-md-workspace] Relay dev server stopped with ${reason}.`);
    void shutdown(code ?? 1);
  });

  child.on("error", (error) => {
    if (shuttingDown) return;
    console.error(`[local-md-workspace] Failed to start relay dev server: ${error.message}`);
    void shutdown(1);
  });

  return child;
}

function relayHostForCli(url) {
  if (url.hostname == "[::1]" || url.hostname == "::1") return "::1";
  return url.hostname;
}

function relayPortForCli(url) {
  if (url.port) return url.port;
  return url.protocol == "https:" ? "443" : "80";
}

function spawnFrontend(origin, args) {
  let nextArgs = withDefaultFrontendAddress(args);
  console.log(`[local-md-workspace] Starting workspace app with relay ${origin}`);
  return spawn("vp", ["dev", ...nextArgs], {
    cwd: appRoot,
    env: {
      ...process.env,
      VITE_LOCAL_MD_SHARE_RELAY_ORIGIN: origin,
    },
    stdio: "inherit",
  });
}

function withDefaultFrontendAddress(args) {
  let next = [...args];
  if (!hasArg(next, "--host")) {
    next.push("--host", "127.0.0.1");
  }
  if (!hasArg(next, "--port")) {
    next.push("--port", "5173");
  }
  return next;
}

function hasArg(args, name) {
  return args.some((arg) => arg == name || arg.startsWith(`${name}=`));
}

async function waitForRelay(origin, child) {
  let started = Date.now();
  while (Date.now() - started < RELAY_READY_TIMEOUT_MS) {
    if (child.exitCode != null) {
      throw new Error(`Relay dev server exited before ${origin} was reachable.`);
    }
    if (await relayIsReady(origin)) {
      console.log(`[local-md-workspace] Relay ready at ${origin}`);
      return;
    }
    await delay(RELAY_READY_POLL_MS);
  }
  throw new Error(`Timed out waiting for relay dev server at ${origin}.`);
}

async function relayIsReady(origin) {
  try {
    let response = await fetch(new URL("/__debug", origin), {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function waitForFrontendExit(child) {
  return new Promise((resolveExit) => {
    child.on("exit", async (code, signal) => {
      if (shuttingDown) {
        resolveExit();
        return;
      }
      let exitCode = code ?? (signal ? 1 : 0);
      await shutdown(exitCode);
      resolveExit();
    });
    child.on("error", async (error) => {
      if (!shuttingDown) {
        console.error(`[local-md-workspace] Failed to start workspace app: ${error.message}`);
        await shutdown(1);
      }
      resolveExit();
    });
  });
}

function installSignalHandlers() {
  process.once("SIGINT", () => {
    void shutdown(130);
  });
  process.once("SIGTERM", () => {
    void shutdown(143);
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([stopProcess(frontendChild), stopProcess(relayChild)]);
  process.exit(exitCode);
}

function stopProcess(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();

  return new Promise((resolveStop) => {
    let timer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function printHelp() {
  console.log(`Start the local Markdown workspace and its collaboration relay.

Usage:
  vp run dev [-- <local workspace dev options>]

Defaults:
  relay:    http://127.0.0.1:8787
  frontend: http://127.0.0.1:5173

Options:
  --relay-origin <origin>   Use a specific relay origin.

Frontend host and port use normal Vite dev flags:
  vp run dev -- --host 127.0.0.1 --port 5174

Examples:
  vp run dev
  vp run dev -- --relay-origin http://127.0.0.1:8788
  vp run dev -- --relay-origin https://collab-editor.example.workers.dev
`);
}
