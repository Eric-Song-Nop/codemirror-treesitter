import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SMOKE_URL = process.env.LOCAL_MD_WORKSPACE_SMOKE_URL || "http://127.0.0.1:5173/";
const DROPBOX_CONFIG_KEY = "local-md-workspace:dropbox-config";
const DROPBOX_OAUTH_MESSAGE = "local-md-workspace:dropbox-oauth";
const dropboxAccessToken =
  process.env.LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN || process.env.OPENDAL_DROPBOX_ACCESS_TOKEN;
const dropboxRoot =
  process.env.LOCAL_MD_WORKSPACE_DROPBOX_ROOT || process.env.OPENDAL_DROPBOX_ROOT || "";

let chromePath = findChromePath();
if (!chromePath) {
  throw new Error(
    "Chromium was not found. Set CHROME_PATH or install Playwright's Chromium cache first.",
  );
}

let userDataDir = await mkdtemp(join(tmpdir(), "local-md-workspace-smoke-"));
let chrome = execFile(chromePath, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`,
  "--no-default-browser-check",
  "--no-first-run",
  "about:blank",
]);

try {
  let browserWs = await waitForDevToolsEndpoint(chrome);
  let client = await createCdpClient(browserWs);
  let { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  let { sessionId } = await client.send("Target.attachToTarget", {
    flatten: true,
    targetId,
  });

  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await installMockFileSystemAccess(client, sessionId);

  await navigate(client, sessionId, SMOKE_URL);
  await assertLocalWorkspaceFlow(client, sessionId);
  await assertInitialDropboxUi(client, sessionId);
  await assertNoDropboxConfigFields(client, sessionId);

  await client.evaluate(
    `
      localStorage.setItem(${JSON.stringify(DROPBOX_CONFIG_KEY)}, JSON.stringify({
        appKey: "stored-app-key",
        root: "notes/smoke"
      }));
    `,
    sessionId,
  );
  await navigate(client, sessionId, SMOKE_URL);
  await assertSavedDropboxConfigUi(client, sessionId);
  await assertNoDropboxConfigFields(client, sessionId);
  await assertRealDropboxWorkspaceFlow(client, sessionId);

  await client.send("Browser.close");
  console.log(`Local Markdown workspace UI smoke passed at ${SMOKE_URL}`);
} finally {
  if (!chrome.killed) chrome.kill("SIGTERM");
  await rm(userDataDir, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  });
}

async function navigate(client, sessionId, url) {
  await client.send("Page.navigate", { url }, sessionId);
  await client.waitForEvent("Page.loadEventFired", sessionId);
  await waitForSettledUi();
}

async function assertInitialDropboxUi(client, sessionId) {
  let state = await client.evaluate(
    `
      (() => ({
        body: document.body.innerText,
        hasRoot: Boolean(document.querySelector("#root")),
        title: document.title
      }))()
    `,
    sessionId,
  );

  if (!state.hasRoot || !state.body.includes("Connect Dropbox")) {
    throw new Error(
      `Initial workspace UI did not render Dropbox controls: ${JSON.stringify(state)}`,
    );
  }
}

async function assertLocalWorkspaceFlow(client, sessionId) {
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.includes("Open folder") && !item.disabled
        );
        if (!button) throw new Error("Open folder button was not found.");
        button.click();
      })()
    `,
    sessionId,
  );

  await client.waitForPredicate(
    `document.body.innerText.includes("Smoke Workspace") && document.body.innerText.includes("1 markdown file")`,
    sessionId,
  );

  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.trim() == "New file" && !item.disabled
        );
        if (!button) throw new Error("New file button was not found.");
        button.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `Boolean(document.querySelector("#markdown-file-name"))`,
    sessionId,
  );

  await client.evaluate(
    `
      (() => {
        let input = document.querySelector("#markdown-file-name");
        let setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, "smoke-local");
        input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        let create = Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent.trim() == "Create"
        );
        if (!create) throw new Error("Create button was not found.");
        create.click();
      })()
    `,
    sessionId,
  );

  await client.waitForPredicate(
    `Boolean(document.querySelector("live-md-editor")?.value?.includes("# smoke local"))`,
    sessionId,
  );

  let nextValue = "# smoke local\\n\\nEdited by local UI smoke.\\n";
  await client.evaluate(
    `
      (() => {
        let editor = document.querySelector("live-md-editor");
        if (!editor) throw new Error("live-md-editor was not found.");
        editor.value = ${JSON.stringify(nextValue)};
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      })()
    `,
    sessionId,
  );

  await client.waitForPredicate(
    `window.__localMdSmokeFiles?.get("smoke-local.md") == ${JSON.stringify(nextValue)}`,
    sessionId,
    3_000,
  );

  let state = await client.evaluate(
    `
      (() => ({
        body: document.body.innerText,
        savedValue: window.__localMdSmokeFiles?.get("smoke-local.md") ?? null
      }))()
    `,
    sessionId,
  );

  if (!state.body.includes("Saved to disk") || state.savedValue != nextValue) {
    throw new Error(
      `Local workspace flow did not save through the backend: ${JSON.stringify(state)}`,
    );
  }
}

async function assertSavedDropboxConfigUi(client, sessionId) {
  let body = await client.evaluate("document.body.innerText", sessionId);
  if (!body.includes("Reconnect Dropbox")) {
    throw new Error("Stored Dropbox config did not expose a reconnect action.");
  }
}

async function assertNoDropboxConfigFields(client, sessionId) {
  let state = await client.evaluate(
    `
      (() => ({
        appKeyInput: Boolean(document.querySelector("#dropbox-app-key")),
        rootInput: Boolean(document.querySelector("#dropbox-root"))
      }))()
    `,
    sessionId,
  );

  if (state.appKeyInput || state.rootInput) {
    throw new Error(`Dropbox config fields should not be exposed: ${JSON.stringify(state)}`);
  }
}

async function assertRealDropboxWorkspaceFlow(client, sessionId) {
  if (!dropboxAccessToken) {
    console.log(
      "Skipping real Dropbox workspace UI smoke: LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN and OPENDAL_DROPBOX_ACCESS_TOKEN are not set.",
    );
    return;
  }

  let fileName = `local-md-workspace-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.md`;
  let filePath = dropboxApiPath(fileName);
  let nextValue = `# Dropbox UI smoke\\n\\n${fileName}\\n`;

  try {
    await installDropboxOAuthStub(client, sessionId);
    await navigate(client, sessionId, SMOKE_URL);
    await client.evaluate(
      "localStorage.removeItem(" + JSON.stringify(DROPBOX_CONFIG_KEY) + ")",
      sessionId,
    );
    await navigate(client, sessionId, SMOKE_URL);
    await connectDropboxWorkspace(client, sessionId);
    await createAndEditDropboxFile(client, sessionId, fileName, nextValue);
    await waitForDropboxFileValue(filePath, nextValue);
  } finally {
    await deleteDropboxFile(filePath).catch(() => {});
  }
}

async function connectDropboxWorkspace(client, sessionId) {
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.includes("Connect Dropbox") && !item.disabled
        );
        if (!button) throw new Error("Connect Dropbox button was not found.");
        button.click();
      })()
    `,
    sessionId,
  );

  await client.waitForPredicate(
    `document.body.innerText.includes("Dropbox connected") || document.body.innerText.includes("Dropbox ·")`,
    sessionId,
    20_000,
  );
}

async function createAndEditDropboxFile(client, sessionId, fileName, nextValue) {
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.trim() == "New file" && !item.disabled
        );
        if (!button) throw new Error("New file button was not found.");
        button.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `Boolean(document.querySelector("#markdown-file-name"))`,
    sessionId,
  );
  await client.evaluate(
    `
      (() => {
        let input = document.querySelector("#markdown-file-name");
        let setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(fileName)});
        input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        let create = Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent.trim() == "Create"
        );
        if (!create) throw new Error("Create button was not found.");
        create.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(`Boolean(document.querySelector("live-md-editor"))`, sessionId);

  await client.evaluate(
    `
      (() => {
        let editor = document.querySelector("live-md-editor");
        if (!editor) throw new Error("live-md-editor was not found.");
        editor.value = ${JSON.stringify(nextValue)};
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `document.body.innerText.includes("Saved to Dropbox")`,
    sessionId,
    20_000,
  );
}

async function createCdpClient(browserWs) {
  let ws = new WebSocket(browserWs);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let events = [];
  let nextId = 1;
  let pending = new Map();

  ws.addEventListener("message", (event) => {
    let message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      let { reject, resolve } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    events.push(message);
  });

  return {
    evaluate(expression, sessionId) {
      return this.send(
        "Runtime.evaluate",
        {
          awaitPromise: true,
          expression,
          returnByValue: true,
        },
        sessionId,
      ).then((result) => {
        if (result.exceptionDetails) {
          throw new Error(
            result.exceptionDetails.exception?.description ||
              result.exceptionDetails.exception?.value ||
              result.exceptionDetails.text ||
              "Runtime evaluation failed.",
          );
        }
        return result.result.value;
      });
    },
    send(method, params = {}, sessionId) {
      let id = nextId++;
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => pending.set(id, { reject, resolve }));
    },
    waitForEvent(method, sessionId, timeout = 10_000) {
      return new Promise((resolve, reject) => {
        let timer = setTimeout(() => {
          clearInterval(interval);
          reject(new Error(`Timed out waiting for ${method}.`));
        }, timeout);
        let interval = setInterval(() => {
          let index = events.findIndex(
            (event) => event.method == method && (!sessionId || event.sessionId == sessionId),
          );
          if (index == -1) return;
          clearInterval(interval);
          clearTimeout(timer);
          resolve(events.splice(index, 1)[0]);
        }, 25);
      });
    },
    async waitForPredicate(expression, sessionId, timeout = 10_000) {
      let started = Date.now();
      while (Date.now() - started < timeout) {
        if (await this.evaluate(`Boolean(${expression})`, sessionId)) return;
        await waitForSettledUi(50);
      }
      throw new Error(`Timed out waiting for predicate: ${expression}`);
    },
  };
}

async function installMockFileSystemAccess(client, sessionId) {
  await client.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
        (() => {
          class SmokeFileHandle {
            kind = "file";
            constructor(name, files) {
              this.name = name;
              this.files = files;
            }
            async getFile() {
              return new File([this.files.get(this.name) ?? ""], this.name, {
                type: this.name.endsWith(".md") ? "text/markdown" : "application/octet-stream"
              });
            }
            async createWritable() {
              let chunks = [];
              return {
                abort: async () => {
                  chunks = [];
                },
                close: async () => {
                  this.files.set(this.name, chunks.join(""));
                },
                write: async (data) => {
                  if (typeof data == "string") {
                    chunks.push(data);
                  } else if (data instanceof Blob) {
                    chunks.push(await data.text());
                  } else {
                    chunks.push(String(data));
                  }
                }
              };
            }
          }

          class SmokeDirectoryHandle {
            kind = "directory";
            constructor(name, files = new Map()) {
              this.name = name;
              this.files = files;
            }
            async queryPermission() {
              return "granted";
            }
            async requestPermission() {
              return "granted";
            }
            async getDirectoryHandle(name, options = {}) {
              if (options.create) return new SmokeDirectoryHandle(name, this.files);
              throw new DOMException("Directory not found.", "NotFoundError");
            }
            async getFileHandle(name, options = {}) {
              if (!this.files.has(name)) {
                if (!options.create) throw new DOMException("File not found.", "NotFoundError");
                this.files.set(name, "");
              }
              return new SmokeFileHandle(name, this.files);
            }
            async removeEntry(name) {
              if (!this.files.delete(name)) throw new DOMException("Entry not found.", "NotFoundError");
            }
            async *values() {
              for (let name of Array.from(this.files.keys()).sort()) {
                yield new SmokeFileHandle(name, this.files);
              }
            }
          }

          let files = new Map([["welcome.md", "# Welcome\\n"]]);
          window.__localMdSmokeFiles = files;
          window.showDirectoryPicker = async () => new SmokeDirectoryHandle("Smoke Workspace", files);
        })();
      `,
    },
    sessionId,
  );
}

async function installDropboxOAuthStub(client, sessionId) {
  await client.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
        (() => {
          let originalFetch = window.fetch.bind(window);
          window.fetch = (input, init) => {
            let url = typeof input == "string" ? input : input?.url ?? "";
            if (url == "https://api.dropboxapi.com/oauth2/token") {
              return Promise.resolve(new Response(JSON.stringify({
                access_token: ${JSON.stringify(dropboxAccessToken)},
                expires_in: 3600
              }), {
                headers: { "Content-Type": "application/json" },
                status: 200
              }));
            }
            return originalFetch(input, init);
          };

          window.open = () => {
            let popup = {
              closed: false,
              close() {
                this.closed = true;
              },
              document: { title: "" },
              focus() {},
              location: {
                set href(value) {
                  let state = new URL(value).searchParams.get("state");
                  setTimeout(() => {
                    window.dispatchEvent(new MessageEvent("message", {
                      data: {
                        code: "dropbox-smoke-code",
                        state,
                        type: ${JSON.stringify(DROPBOX_OAUTH_MESSAGE)}
                      },
                      origin: window.location.origin
                    }));
                  }, 0);
                }
              }
            };
            return popup;
          };
        })();
      `,
    },
    sessionId,
  );
}

async function waitForDropboxFileValue(path, expectedValue) {
  let started = Date.now();
  while (Date.now() - started < 20_000) {
    let value = await downloadDropboxFile(path).catch(() => null);
    if (value == expectedValue) return;
    await waitForSettledUi(500);
  }
  throw new Error(`Timed out waiting for Dropbox file ${path} to contain the smoke value.`);
}

async function downloadDropboxFile(path) {
  let response = await fetch("https://content.dropboxapi.com/2/files/download", {
    headers: {
      Authorization: `Bearer ${dropboxAccessToken}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
    method: "POST",
  });
  if (!response.ok) throw new Error(`Dropbox download failed (${response.status}).`);
  return response.text();
}

async function deleteDropboxFile(path) {
  let response = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
    body: JSON.stringify({ path }),
    headers: {
      Authorization: `Bearer ${dropboxAccessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok && response.status != 409) {
    throw new Error(`Dropbox cleanup failed (${response.status}).`);
  }
}

function dropboxApiPath(fileName) {
  let root = dropboxRoot
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return `/${root ? `${root}/` : ""}${fileName}`;
}

function waitForDevToolsEndpoint(child) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error("Timed out waiting for Chromium.")), 10_000);
    child.stderr.on("data", (chunk) => {
      let match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.on("exit", (code) => {
      reject(new Error(`Chromium exited before DevTools was ready: ${code}`));
    });
  });
}

function waitForSettledUi(delay = 350) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function findChromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  for (let candidate of chromePathCandidates()) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function chromePathCandidates() {
  let home = homedir();
  let candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];

  let cacheRoot = join(home, "Library/Caches/ms-playwright");
  for (let entry of newestPlaywrightCacheEntries(cacheRoot, "chromium-")) {
    candidates.push(
      join(
        cacheRoot,
        entry,
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
    );
  }
  for (let entry of newestPlaywrightCacheEntries(cacheRoot, "chromium_headless_shell-")) {
    candidates.push(
      join(cacheRoot, entry, "chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    );
  }

  return candidates;
}

function newestPlaywrightCacheEntries(cacheRoot, prefix) {
  try {
    return readdirSync(cacheRoot)
      .filter((entry) => entry.startsWith(prefix))
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }
}
