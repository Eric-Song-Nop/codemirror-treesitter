import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SMOKE_URL = process.env.LOCAL_MD_WORKSPACE_SMOKE_URL || "http://127.0.0.1:5173/";
const DROPBOX_CONFIG_KEY = "local-md-workspace:dropbox-config";
const DROPBOX_OAUTH_MESSAGE = "local-md-workspace:dropbox-oauth";
const GITHUB_REPOSITORY_URL = "https://github.com/Eric-Song-Nop/codemirror-treesitter";
const MINIMUM_SELECTION_EDGE_CONTRAST = 3;
const dropboxAccessToken =
  process.env.LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN || process.env.OPENDAL_DROPBOX_ACCESS_TOKEN;
const dropboxRoot =
  process.env.LOCAL_MD_WORKSPACE_DROPBOX_ROOT || process.env.OPENDAL_DROPBOX_ROOT || "";
const shareRelayOrigin = process.env.VITE_LOCAL_MD_SHARE_RELAY_ORIGIN || "";
const agentOnly =
  process.argv.includes("--agent-only") || process.env.LOCAL_MD_WORKSPACE_SMOKE_AGENT_ONLY == "1";
const liveMdBoundariesOnly = process.env.LOCAL_MD_WORKSPACE_SMOKE_LIVE_MD_BOUNDARIES_ONLY == "1";

let chromePath = findChromePath();
if (!chromePath) {
  throw new Error(
    "Chromium was not found. Set CHROME_PATH or install Playwright's Chromium cache first.",
  );
}

let userDataDir = await mkdtemp(join(tmpdir(), "local-md-workspace-smoke-"));
let chromeEnvironment = { ...process.env };
delete chromeEnvironment.DYLD_INSERT_LIBRARIES;
delete chromeEnvironment.LD_PRELOAD;
let chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-default-browser-check",
    "--no-first-run",
    liveMdBoundariesOnly ? SMOKE_URL : "about:blank",
  ],
  { env: chromeEnvironment, stdio: ["ignore", "ignore", "pipe"] },
);

try {
  if (liveMdBoundariesOnly) console.log("Starting focused LiveMD browser regression smoke.");
  let browserWs = await waitForDevToolsEndpoint(chrome);
  let client;
  let sessionId;
  if (liveMdBoundariesOnly) {
    client = await createCdpClient(await waitForPageDevToolsEndpoint(browserWs));
    console.log("Focused smoke connected to Chromium's page target.");
  } else {
    client = await createCdpClient(browserWs);
    let { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    ({ sessionId } = await client.send("Target.attachToTarget", {
      flatten: true,
      targetId,
    }));
  }

  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  if (!liveMdBoundariesOnly) {
    await installMockFileSystemAccess(client, sessionId, { preserveIndexedDb: agentOnly });
  }

  if (agentOnly) {
    await assertWorkspaceAgentBrowserIntegration(client);
    await navigate(client, sessionId, SMOKE_URL);
    await openMockLocalWorkspace(client, sessionId);
    await assertAgentCredentialVaultFlow(client, sessionId);
    await client.send("Browser.close");
    console.log(`Browser Agent UI smoke passed at ${SMOKE_URL}`);
  } else if (liveMdBoundariesOnly) {
    await waitForLoadedPage(client, sessionId, SMOKE_URL);
    console.log("Focused smoke loaded the test page.");
    await mountFocusedLiveMdEditor(client, sessionId);
    console.log("Focused smoke found LiveMD; running browser regression assertions.");
    await assertLiveMdUiRegressions(client, sessionId);
    console.log(`LiveMD browser regression smoke passed at ${SMOKE_URL}`);
  } else {
    await assertWorkspaceAgentBrowserIntegration(client);
    await navigate(client, sessionId, SMOKE_URL);
    await assertGitHubRepositoryLink(client, sessionId);
    await assertLocalWorkspaceFlow(client, sessionId);
    await assertOwnerReconnectSharedFileFlow(client);
    await assertOwnerExternalConflictFlow(client);
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
    await assertMockDropboxWorkspaceFlow(client, sessionId);

    await client.send("Browser.close");
    console.log(`Grove workspace UI smoke passed at ${SMOKE_URL}`);
  }
} finally {
  if (!chrome.killed) chrome.kill("SIGTERM");
  await rm(userDataDir, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  });
}

async function mountFocusedLiveMdEditor(client, sessionId) {
  await client.waitForPredicate(`Boolean(customElements.get("live-md-editor"))`, sessionId, 20_000);
  await client.evaluate(
    `
      (async () => {
        let editor = document.createElement("live-md-editor");
        editor.style.display = "block";
        editor.style.height = "720px";
        document.body.replaceChildren(editor);
        await editor.ready;
      })()
    `,
    sessionId,
  );
}

async function navigate(client, sessionId, url) {
  await client.send("Page.navigate", { url }, sessionId);
  await client.waitForEvent("Page.loadEventFired", sessionId);
  await waitForSettledUi();
}

async function waitForLoadedPage(client, sessionId, url) {
  await client.waitForPredicate(
    `location.href == ${JSON.stringify(url)} && document.readyState == "complete"`,
    sessionId,
    20_000,
  );
  await waitForSettledUi();
}

async function attachNewTarget(client, url, { isolated = false, waitForLoad = true } = {}) {
  let browserContextId = null;
  if (isolated) {
    browserContextId = (await client.send("Target.createBrowserContext")).browserContextId;
  }

  let { targetId } = await client.send("Target.createTarget", {
    ...(browserContextId ? { browserContextId } : {}),
    url,
  });
  let { sessionId } = await client.send("Target.attachToTarget", {
    flatten: true,
    targetId,
  });

  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  if (waitForLoad) await client.waitForEvent("Page.loadEventFired", sessionId);
  await waitForSettledUi();
  return { browserContextId, sessionId, targetId };
}

async function attachLocalWorkspaceTarget(client) {
  let target = await attachNewTarget(client, "about:blank", { waitForLoad: false });
  await installMockFileSystemAccess(client, target.sessionId);
  await navigate(client, target.sessionId, SMOKE_URL);
  return target;
}

async function assertGitHubRepositoryLink(client, sessionId) {
  await ensureSidebarOpen(client, sessionId);
  let state = await client.evaluate(
    `
      (() => {
        let links = Array.from(document.querySelectorAll(${JSON.stringify(`a[href="${GITHUB_REPOSITORY_URL}"]`)}));
        let link = links.find((item) => item.getClientRects().length) ?? links[0] ?? null;
        return {
          ariaLabel: link?.getAttribute("aria-label") ?? null,
          found: Boolean(link),
          hasIcon: Boolean(link?.querySelector("svg")),
          rel: link?.getAttribute("rel") ?? null,
          target: link?.getAttribute("target") ?? null,
          text: link?.textContent?.trim() ?? null,
          visible: Boolean(link?.getClientRects().length)
        };
      })()
    `,
    sessionId,
  );

  if (
    !state.found ||
    !state.visible ||
    !state.hasIcon ||
    state.ariaLabel != "Open GitHub repository" ||
    state.rel != "noreferrer" ||
    state.target != "_blank" ||
    state.text != "GitHub repository"
  ) {
    throw new Error(`GitHub repository link did not render correctly: ${JSON.stringify(state)}`);
  }
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

  if (state.hasRoot && !state.body.includes("Connect Dropbox")) {
    await client.evaluate(
      `
        (() => {
          let button = Array.from(document.querySelectorAll("button")).find((item) =>
            item.textContent.trim() == "Show sidebar" && item.getClientRects().length
          );
          button?.click();
        })()
      `,
      sessionId,
    );
    await waitForSettledUi();
    state = await client.evaluate(
      `
        (() => ({
          body: document.body.innerText,
          hasRoot: Boolean(document.querySelector("#root")),
          title: document.title
        }))()
      `,
      sessionId,
    );
  }

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

  await waitForLocalWorkspaceReady(client, sessionId);
  await assertAgentApiKeyMemoryOnly(client, sessionId);

  await clickNewFileButton(client, sessionId);
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

  try {
    await client.waitForPredicate(
      `Boolean(document.querySelector("live-md-editor")?.value?.includes("# smoke local"))`,
      sessionId,
    );
  } catch (error) {
    let state = await client.evaluate(
      `(() => ({
        body: document.body.innerText,
        editorValue: document.querySelector("live-md-editor")?.value ?? null,
        files: Array.from(window.__localMdSmokeFiles?.entries?.() ?? []),
      }))()`,
      sessionId,
    );
    throw new Error(`${error.message}\n\nLocal create state:\n${JSON.stringify(state, null, 2)}`);
  }

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

  try {
    await client.waitForPredicate(
      `window.__localMdSmokeFiles?.get("smoke-local.md") == ${JSON.stringify(nextValue)}`,
      sessionId,
      3_000,
    );
  } catch (error) {
    let state = await client.evaluate(
      `(() => ({
        body: document.body.innerText,
        editorValue: document.querySelector("live-md-editor")?.value ?? null,
        files: Array.from(window.__localMdSmokeFiles?.entries?.() ?? []),
      }))()`,
      sessionId,
    );
    throw new Error(`${error.message}\n\nLocal save state:\n${JSON.stringify(state, null, 2)}`);
  }

  let state = await client.evaluate(
    `
      (() => ({
        body: document.body.innerText,
        savedValue: window.__localMdSmokeFiles?.get("smoke-local.md") ?? null
      }))()
    `,
    sessionId,
  );

  if (!state.body.includes("Saved") || state.savedValue != nextValue) {
    throw new Error(
      `Local workspace flow did not save through the backend: ${JSON.stringify(state)}`,
    );
  }

  await assertLiveMdUiRegressions(client, sessionId);

  await setLiveMdSmokeDocument(client, sessionId, nextValue);
  await client.waitForPredicate(
    `window.__localMdSmokeFiles?.get("smoke-local.md") == ${JSON.stringify(nextValue)}`,
    sessionId,
    3_000,
  );

  await assertSharedFileGuestEdit(client, sessionId, {
    expectedInitialValue: nextValue,
    nextValue: "# smoke local\n\nEdited by shared-file UI smoke.\n",
    waitForOwnerSave: () =>
      client.waitForPredicate(
        `window.__localMdSmokeFiles?.get("smoke-local.md") == ${JSON.stringify(
          "# smoke local\n\nEdited by shared-file UI smoke.\n",
        )}`,
        sessionId,
        10_000,
      ),
  });
  await assertSharedFileLifecycle(client, sessionId, {
    expectedValue: "# smoke local\n\nEdited by shared-file UI smoke.\n",
  });
}

async function assertWorkspaceAgentBrowserIntegration(client) {
  let target = await attachNewTarget(client, "about:blank", {
    isolated: true,
    waitForLoad: false,
  });
  try {
    await navigate(client, target.sessionId, SMOKE_URL);
    let state = await client.evaluate(
      `
        (async () => {
          let fixture = await import("/smoke/agent-integration.ts");
          let result = await fixture.runWorkspaceAgentBrowserIntegration();
          return {
            indexedDbAvailable: typeof indexedDB != "undefined",
            indexedDbPersistence: await inspectBrowserCollabPersistence(result.documentId),
            localFallbackKeys: Object.keys(localStorage).filter((key) =>
              key.includes(result.documentId)
            ),
            result
          };

          async function inspectBrowserCollabPersistence(documentId) {
            let databases = await indexedDB.databases();
            if (!databases.some((database) => database.name == "local-md-workspace-collab")) {
              return { document: false, updates: 0 };
            }

            return new Promise((resolve, reject) => {
              let request = indexedDB.open("local-md-workspace-collab");
              request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
              request.onblocked = () => reject(new Error("IndexedDB open was blocked."));
              request.onsuccess = () => {
                let database = request.result;
                let transaction = database.transaction(["documents", "updates"], "readonly");
                let documentRequest = transaction.objectStore("documents").get(documentId);
                let updatesRequest = transaction
                  .objectStore("updates")
                  .index("docId")
                  .getAll(documentId);
                transaction.onerror = () =>
                  reject(transaction.error ?? new Error("IndexedDB read failed."));
                transaction.onabort = () =>
                  reject(transaction.error ?? new Error("IndexedDB read was aborted."));
                transaction.oncomplete = () => {
                  database.close();
                  resolve({
                    document: Boolean(documentRequest.result),
                    updates: updatesRequest.result.length
                  });
                };
              };
            });
          }
        })()
      `,
      target.sessionId,
    );
    let expectedValue = "# Browser Agent\n\nafter\n";
    if (
      !state.indexedDbAvailable ||
      !state.indexedDbPersistence.document ||
      state.localFallbackKeys.length != 0 ||
      state.result.editorValue != expectedValue ||
      state.result.loroValue != expectedValue ||
      state.result.persistedValue != expectedValue ||
      state.result.localUpdates != 1 ||
      !state.result.standaloneBlocked ||
      state.result.unselectedValue != "unselected" ||
      JSON.stringify(state.result.toolNames) != JSON.stringify(["read_file", "write_file"])
    ) {
      throw new Error(
        `Browser Agent integration did not converge through IndexedDB: ${JSON.stringify(state)}`,
      );
    }
  } finally {
    await client.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
    if (target.browserContextId) {
      await client
        .send("Target.disposeBrowserContext", { browserContextId: target.browserContextId })
        .catch(() => {});
    }
  }

  console.log("Browser Agent fake-model integration smoke passed.");
}

async function assertAgentCredentialVaultFlow(client, sessionId) {
  let secret = `sk-smoke-encrypted-${Date.now()}`;
  let passphrase = `grove-smoke-passphrase-${Date.now()}`;
  await client.evaluate(
    `
      (() => {
        let button = document.querySelector('button[aria-controls="workspace-agent-panel"]');
        if (!button) throw new Error("Agent panel button was not found.");
        button.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `Boolean(document.querySelector("#workspace-agent-panel")) &&
      !document.querySelector("#workspace-agent-panel button")?.disabled &&
      document.querySelector("#workspace-agent-panel")?.innerText.includes("DeepSeek API key")`,
    sessionId,
  );
  let configuration = await client.evaluate(
    `
      (() => {
        let panel = document.querySelector("#workspace-agent-panel");
        let model = document.querySelector("#workspace-agent-model");
        if (!(model instanceof HTMLSelectElement)) {
          throw new Error("Agent model select was not found.");
        }
        return {
          credentialText: panel?.innerText ?? "",
          model: model.value,
          modelOptions: Array.from(model.options, (option) => option.value)
        };
      })()
    `,
    sessionId,
  );
  if (
    !configuration.credentialText.includes("DeepSeek API key") ||
    !configuration.credentialText.includes("encrypted key in Settings") ||
    configuration.model != "deepseek-v4-flash" ||
    JSON.stringify(configuration.modelOptions) !=
      JSON.stringify(["deepseek-v4-flash", "deepseek-v4-pro"])
  ) {
    throw new Error(
      `Agent provider configuration was unexpected: ${JSON.stringify(configuration)}`,
    );
  }

  await client.evaluate(
    `
      (() => {
        let model = document.querySelector("#workspace-agent-model");
        let setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(model, "deepseek-v4-pro");
        model.dispatchEvent(new Event("change", { bubbles: true }));
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `document.querySelector("#workspace-agent-model")?.value == "deepseek-v4-pro"`,
    sessionId,
  );

  await client.evaluate(
    `
      (() => {
        let panel = document.querySelector("#workspace-agent-panel");
        let settings = Array.from(panel?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent.trim() == "Open settings"
        );
        if (!settings) throw new Error("Agent Settings button was not found.");
        settings.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `Boolean(document.querySelector("#workspace-settings-dialog")) &&
      Boolean(document.querySelector("#settings-save-api-key")) &&
      Boolean(document.querySelector("#settings-save-passphrase")) &&
      Boolean(document.querySelector("#settings-save-passphrase-confirmation"))`,
    sessionId,
  );
  await client.evaluate(
    `
      (() => {
        let apiKey = document.querySelector("#settings-save-api-key");
        let passphrase = document.querySelector("#settings-save-passphrase");
        let confirmation = document.querySelector("#settings-save-passphrase-confirmation");
        let setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(apiKey, ${JSON.stringify(secret)});
        setter.call(passphrase, ${JSON.stringify(passphrase)});
        setter.call(confirmation, ${JSON.stringify(passphrase)});
        apiKey.dispatchEvent(new InputEvent("input", { bubbles: true }));
        passphrase.dispatchEvent(new InputEvent("input", { bubbles: true }));
        confirmation.dispatchEvent(new InputEvent("input", { bubbles: true }));
        apiKey.form.requestSubmit();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `!document.querySelector("#settings-save-api-key") &&
      document.querySelector("#workspace-settings-dialog")?.innerText.includes("Saved key unlocked") &&
      Boolean(document.querySelector("#workspace-agent-prompt"))`,
    sessionId,
    20_000,
  );

  let savedState = await inspectAgentCredentialVault(client, sessionId, secret, passphrase);
  assertEncryptedAgentCredential(savedState, "saved credential");
  if (
    savedState.localStorageContainsModel ||
    savedState.sessionStorageContainsModel ||
    savedState.selectedModel != "deepseek-v4-pro"
  ) {
    throw new Error(`Agent configuration state was unexpected: ${JSON.stringify(savedState)}`);
  }

  await navigate(client, sessionId, SMOKE_URL);
  await client.evaluate(
    `document.querySelector('button[aria-controls="workspace-agent-panel"]')?.click()`,
    sessionId,
  );
  await client.waitForPredicate(
    `document.querySelector("#workspace-agent-panel")?.innerText.includes("API key locked") &&
      !document.querySelector("#workspace-agent-prompt")`,
    sessionId,
    20_000,
  );

  let lockedState = await inspectAgentCredentialVault(client, sessionId, secret, passphrase);
  assertEncryptedAgentCredential(lockedState, "reloaded credential");
  if (lockedState.selectedModel != "deepseek-v4-flash") {
    throw new Error(`Agent model survived reload unexpectedly: ${JSON.stringify(lockedState)}`);
  }

  await client.evaluate(
    `
      (() => {
        let panel = document.querySelector("#workspace-agent-panel");
        let settings = Array.from(panel?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent.trim() == "Open settings"
        );
        if (!settings) throw new Error("Locked Agent Settings button was not found.");
        settings.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `Boolean(document.querySelector("#settings-unlock-passphrase"))`,
    sessionId,
  );
  await client.evaluate(
    `
      (() => {
        let passphrase = document.querySelector("#settings-unlock-passphrase");
        let setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(passphrase, ${JSON.stringify(passphrase)});
        passphrase.dispatchEvent(new InputEvent("input", { bubbles: true }));
        passphrase.form.requestSubmit();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `!document.querySelector("#settings-unlock-passphrase") &&
      document.querySelector("#workspace-settings-dialog")?.innerText.includes("Saved key unlocked") &&
      Boolean(document.querySelector("#workspace-agent-prompt"))`,
    sessionId,
    20_000,
  );

  let unlockedState = await inspectAgentCredentialVault(client, sessionId, secret, passphrase);
  assertEncryptedAgentCredential(unlockedState, "unlocked credential");

  await client.evaluate(
    `
      (() => {
        let dialog = document.querySelector("#workspace-settings-dialog");
        let remove = Array.from(dialog?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent.trim() == "Delete saved key"
        );
        if (!remove) throw new Error("Delete saved key button was not found.");
        remove.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `Boolean(document.querySelector('[role="alertdialog"]'))`,
    sessionId,
  );
  await client.evaluate(
    `
      (() => {
        let confirmation = document.querySelector('[role="alertdialog"]');
        let remove = Array.from(confirmation?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent.trim() == "Delete saved key"
        );
        if (!remove) throw new Error("Delete confirmation button was not found.");
        remove.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `!document.querySelector('[role="alertdialog"]') &&
      Boolean(document.querySelector("#settings-save-api-key")) &&
      !document.querySelector("#workspace-agent-prompt")`,
    sessionId,
  );

  let deletedState = await inspectAgentCredentialVault(client, sessionId, secret, passphrase);
  if (
    !deletedState.databaseFound ||
    deletedState.hasRecord ||
    deletedState.recordKeys.length != 0 ||
    deletedState.secretEscaped
  ) {
    throw new Error(`Agent credential was not deleted cleanly: ${JSON.stringify(deletedState)}`);
  }

  await client.evaluate(
    `
      (() => {
        let dialog = document.querySelector("#workspace-settings-dialog");
        let close = Array.from(dialog?.querySelectorAll("button") ?? [])
          .filter((button) => button.textContent.trim() == "Close")
          .at(-1);
        if (!close) throw new Error("Settings close button was not found.");
        close.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(`!document.querySelector("#workspace-settings-dialog")`, sessionId);
  await client.evaluate(
    `
      (() => {
        let panel = document.querySelector("#workspace-agent-panel");
        let close = Array.from(panel?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent.trim() == "Hide Agent"
        );
        close?.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(`!document.querySelector("#workspace-agent-panel")`, sessionId);
}

async function inspectAgentCredentialVault(client, sessionId, secret, passphrase) {
  return client.evaluate(
    `
      (async () => {
        let databaseName = "grove-agent-credentials";
        let databaseFound = (await indexedDB.databases()).some(
          (database) => database.name == databaseName
        );
        let record = null;
        let recordKeys = [];

        if (databaseFound) {
          let database = await new Promise((resolve, reject) => {
            let request = indexedDB.open(databaseName);
            request.onerror = () => reject(request.error ?? new Error("Credential database open failed."));
            request.onblocked = () => reject(new Error("Credential database open was blocked."));
            request.onsuccess = () => resolve(request.result);
          });
          try {
            let result = await new Promise((resolve, reject) => {
              let transaction = database.transaction("credentials", "readonly");
              let store = transaction.objectStore("credentials");
              let recordRequest = store.get("deepseek-api-key");
              let keysRequest = store.getAllKeys();
              transaction.onerror = () =>
                reject(transaction.error ?? new Error("Credential database read failed."));
              transaction.onabort = () =>
                reject(transaction.error ?? new Error("Credential database read was aborted."));
              transaction.oncomplete = () =>
                resolve({ keys: keysRequest.result, record: recordRequest.result ?? null });
            });
            record = result.record;
            recordKeys = result.keys.map(String);
          } finally {
            database.close();
          }
        }

        let forbidden = [${JSON.stringify(secret)}, ${JSON.stringify(passphrase)}];
        let visited = new WeakSet();
        let containsForbidden = (value) => {
          if (typeof value == "string") return forbidden.some((item) => value.includes(item));
          if (value instanceof ArrayBuffer) {
            return forbidden.some((item) => new TextDecoder().decode(value).includes(item));
          }
          if (ArrayBuffer.isView(value)) {
            let bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            return forbidden.some((item) => new TextDecoder().decode(bytes).includes(item));
          }
          if (!value || typeof value != "object") return false;
          if (visited.has(value)) return false;
          visited.add(value);
          return Object.values(value).some(containsForbidden);
        };
        let storageContains = (storage, value) =>
          Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)))
            .some((item) => String(item).includes(value));
        let domContains = (value) =>
          document.body.textContent.includes(value) ||
          document.documentElement.innerHTML.includes(value) ||
          Array.from(document.querySelectorAll("input, textarea")).some((input) =>
            String(input.value).includes(value)
          );
        let recordFields = record && typeof record == "object" ? Object.keys(record).toSorted() : [];
        let derivationFields = record?.keyDerivation && typeof record.keyDerivation == "object"
          ? Object.keys(record.keyDerivation).toSorted()
          : [];
        let cacheStorageContainsSecret = false;
        if (globalThis.caches) {
          for (let cacheName of await caches.keys()) {
            let cache = await caches.open(cacheName);
            for (let request of await cache.keys()) {
              let response = await cache.match(request);
              let requestBody = await request.clone().text().catch(() => "");
              let responseBody = response
                ? await response.clone().text().catch(() => "")
                : "";
              if (
                containsForbidden({
                  requestBody,
                  requestHeaders: Array.from(request.headers.entries()),
                  requestUrl: request.url,
                  responseBody,
                  responseHeaders: response ? Array.from(response.headers.entries()) : [],
                  responseUrl: response?.url ?? ""
                })
              ) {
                cacheStorageContainsSecret = true;
                break;
              }
            }
            if (cacheStorageContainsSecret) break;
          }
        }
        let serviceWorkerMessageContainsSecret = containsForbidden(
          globalThis.__localMdSmokeServiceWorkerMessages ?? []
        );

        return {
          cacheStorageContainsSecret,
          databaseFound,
          hasRecord: Boolean(record),
          localStorageContainsModel: ["deepseek-v4-flash", "deepseek-v4-pro"].some((model) =>
            storageContains(localStorage, model)
          ),
          promptReady: Boolean(
            document.querySelector("#workspace-agent-prompt") &&
              !document.querySelector("#workspace-agent-prompt").disabled
          ),
          recordEncrypted: Boolean(
            record &&
              JSON.stringify(recordFields) ==
                JSON.stringify(["cipher", "ciphertext", "initializationVector", "keyDerivation", "schemaVersion"]) &&
              JSON.stringify(derivationFields) ==
                JSON.stringify(["algorithm", "iterations", "salt"]) &&
              record.cipher == "AES-GCM-256" &&
              record.schemaVersion == 1 &&
              record.ciphertext instanceof Uint8Array &&
              record.ciphertext.byteLength > 16
          ),
          recordKeys,
          secretEscaped: forbidden.some((value) =>
            domContains(value) ||
            storageContains(localStorage, value) ||
            storageContains(sessionStorage, value)
          ) ||
            containsForbidden(record) ||
            cacheStorageContainsSecret ||
            serviceWorkerMessageContainsSecret,
          selectedModel: document.querySelector("#workspace-agent-model")?.value ?? null,
          serviceWorkerMessageContainsSecret,
          sessionStorageContainsModel: ["deepseek-v4-flash", "deepseek-v4-pro"].some((model) =>
            storageContains(sessionStorage, model)
          )
        };
      })()
    `,
    sessionId,
  );
}

function assertEncryptedAgentCredential(state, label) {
  if (
    !state.databaseFound ||
    !state.hasRecord ||
    !state.recordEncrypted ||
    JSON.stringify(state.recordKeys) != JSON.stringify(["deepseek-api-key"]) ||
    state.secretEscaped
  ) {
    throw new Error(`Agent ${label} was not encrypted at rest: ${JSON.stringify(state)}`);
  }
}

async function assertLiveMdUiRegressions(client, sessionId) {
  await assertLiveMdPreviewBoundaries(client, sessionId);
  await assertLiveMdSelectionVisibility(client, sessionId);
}

async function assertLiveMdPreviewBoundaries(client, sessionId) {
  const unclosedMermaid = "```mermaid\ngraph TD\n  A --> B";
  await setLiveMdSmokeDocument(client, sessionId, unclosedMermaid);

  for (let index = 0; index < 3; index += 1) {
    let before = await liveMdPreviewState(client, sessionId);
    await pressEditorKey(client, sessionId, "Enter");
    let after = await liveMdPreviewState(client, sessionId);
    let trailing = after.value.slice(unclosedMermaid.length);
    if (
      !after.value.startsWith(unclosedMermaid) ||
      !/^(?:\n[\t ]*)+$/u.test(trailing) ||
      lineFeedCount(after.value) != lineFeedCount(before.value) + 1 ||
      after.lineCount != before.lineCount + 1 ||
      after.widgets.includes(".cm-md-mermaid")
    ) {
      throw new Error(
        `unclosed Mermaid Enter ${index + 1} was not preserved as an editable line: ${JSON.stringify(
          { after, before, trailing },
        )}`,
      );
    }
  }

  await assertPreviewSurfaceReveal(client, sessionId, {
    content: ".cm-md-mermaid svg",
    label: "closed Mermaid",
    source: "```mermaid\ngraph TD\n  A --> B\n```",
    widget: ".cm-md-mermaid",
  });
  await assertPreviewSurfaceReveal(client, sessionId, {
    content: ".cm-md-image-preview img",
    label: "block image",
    source: "![dot](image.png)",
    widget: ".cm-md-image-preview",
  });
  await assertPreviewSurfaceReveal(client, sessionId, {
    content: ".cm-md-table-preview tbody tr:last-child td:last-child",
    label: "table",
    source: "| Name | Value |\n| --- | --- |\n| alpha | 1 |",
    widget: ".cm-md-table-preview",
  });
  await assertPreviewFollowingBlankLineEditing(client, sessionId, {
    label: "closed Mermaid",
    source: "```mermaid\ngraph TD\n  A --> B\n```",
    widget: ".cm-md-mermaid",
  });
}

async function assertLiveMdSelectionVisibility(client, sessionId) {
  let fixture = [
    "before",
    "",
    "```ts",
    "const selected = true;",
    "const visual =          value;",
    "```",
    "",
    "```mermaid",
    "graph TD",
    "  A --> B",
    "```",
    "",
    "after",
  ].join("\n");
  await setLiveMdSmokeDocument(client, sessionId, fixture);

  let state = await client.evaluate(
    `
      (async () => {
        let fixture = ${JSON.stringify(fixture)};
        let editor = document.querySelector("live-md-editor");
        let root = editor?.shadowRoot;
        let view = editor?.view;
        if (!editor || !root || !view) throw new Error("live-md-editor was not ready.");

        let from = fixture.indexOf("selected");
        let to = fixture.indexOf("after") + "after".length;
        editor.setSelectionRange(from, to);
        editor.focus();
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );

        let selectionLayer = root.querySelector(".cm-selectionLayer");
        let cursorLayer = root.querySelector(".cm-cursorLayer");
        let codeLine = Array.from(root.querySelectorAll(".cm-md-code-line")).find((line) =>
          line.textContent.includes("selected")
        );
        let mermaid = root.querySelector(".cm-md-mermaid");
        let selectionRects = Array.from(root.querySelectorAll(".cm-selectionBackground"))
          .map((node) => node.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0);
        let overlaps = (target) => {
          if (!target) return false;
          let rect = target.getBoundingClientRect();
          return selectionRects.some(
            (selection) =>
              Math.min(selection.right, rect.right) > Math.max(selection.left, rect.left) &&
              Math.min(selection.bottom, rect.bottom) > Math.max(selection.top, rect.top)
          );
        };

        globalThis.__liveMdSmokeCopy = null;
        view.contentDOM.addEventListener(
          "copy",
          (event) => {
            globalThis.__liveMdSmokeCopy = {
              seen: true,
              text: event.clipboardData?.getData("text/plain") ?? null
            };
          },
          { once: true }
        );

        let codeRect = codeLine?.getBoundingClientRect();
        let codeSelection = codeRect
          ? selectionRects.find(
              (selection) =>
                Math.min(selection.right, codeRect.right) >
                  Math.max(selection.left, codeRect.left) &&
                Math.min(selection.bottom, codeRect.bottom) >
                  Math.max(selection.top, codeRect.top)
            )
          : null;
        let clickPoint = codeRect && codeSelection
          ? {
              x: Math.floor(
                (Math.max(codeSelection.left, codeRect.left) +
                  Math.min(codeSelection.right, codeRect.right)) /
                  2
              ),
              y: Math.floor(
                (Math.max(codeSelection.top, codeRect.top) +
                  Math.min(codeSelection.bottom, codeRect.bottom)) /
                  2
              )
            }
          : null;

        return {
          codeSelected: overlaps(codeLine),
          clickPoint,
          cursorLayerZIndex: Number(getComputedStyle(cursorLayer).zIndex),
          expectedText: fixture.slice(from, to),
          mermaidSelected: overlaps(mermaid),
          pointerEvents: getComputedStyle(selectionLayer).pointerEvents,
          selectionLayerZIndex: Number(getComputedStyle(selectionLayer).zIndex)
        };
      })()
    `,
    sessionId,
  );

  let modifier = process.platform == "darwin" ? 4 : 2;
  await client.send(
    "Input.dispatchKeyEvent",
    {
      code: "KeyC",
      key: "c",
      modifiers: modifier,
      nativeVirtualKeyCode: 67,
      commands: ["Copy"],
      type: "keyDown",
      windowsVirtualKeyCode: 67,
    },
    sessionId,
  );
  await client.send(
    "Input.dispatchKeyEvent",
    {
      code: "KeyC",
      key: "c",
      modifiers: modifier,
      nativeVirtualKeyCode: 67,
      type: "keyUp",
      windowsVirtualKeyCode: 67,
    },
    sessionId,
  );
  await client.waitForPredicate(`Boolean(globalThis.__liveMdSmokeCopy?.seen)`, sessionId);
  let copyState = await client.evaluate(`globalThis.__liveMdSmokeCopy`, sessionId);

  if (
    !state.codeSelected ||
    !state.mermaidSelected ||
    state.selectionLayerZIndex <= 0 ||
    !Number.isFinite(state.cursorLayerZIndex) ||
    state.cursorLayerZIndex <= state.selectionLayerZIndex ||
    state.pointerEvents != "none" ||
    !state.clickPoint ||
    copyState.text != state.expectedText
  ) {
    throw new Error(
      `LiveMD selection was obscured by preview content: ${JSON.stringify({ copyState, state })}`,
    );
  }

  await dispatchCdpClick(client, sessionId, state.clickPoint);
  let clickState = await client.evaluate(
    `
      (() => {
        let editor = document.querySelector("live-md-editor");
        let root = editor?.shadowRoot;
        let codeLine = Array.from(root?.querySelectorAll(".cm-md-code-line") ?? []).find((line) =>
          line.textContent.includes("selected")
        );
        let selection = editor?.view?.state.selection.main;
        let hit = root?.elementFromPoint(${state.clickPoint.x}, ${state.clickPoint.y});
        return {
          collapsed: Boolean(selection?.empty),
          hitSelectionLayer: Boolean(hit?.closest?.(".cm-selectionLayer")),
          selectionHead: selection?.head ?? null,
          selectionInsideCodeLine:
            Boolean(codeLine) &&
            Boolean(selection?.empty) &&
            selection.head >= ${fixture.indexOf("const selected")} &&
            selection.head <= ${fixture.indexOf("const selected") + "const selected = true;".length}
        };
      })()
    `,
    sessionId,
  );
  if (
    !clickState.collapsed ||
    clickState.hitSelectionLayer ||
    !clickState.selectionInsideCodeLine
  ) {
    throw new Error(
      `LiveMD selection overlay intercepted pointer input: ${JSON.stringify(clickState)}`,
    );
  }

  await assertLiveMdCodeFenceDragSelection(client, sessionId, fixture);
}

async function assertLiveMdCodeFenceDragSelection(client, sessionId, fixture) {
  let spaces = "          ";
  let from = fixture.indexOf(spaces);
  let to = from + spaces.length;
  let drag = await client.evaluate(
    `
      (async () => {
        let editor = document.querySelector("live-md-editor");
        let view = editor?.view;
        if (!editor || !view) throw new Error("live-md-editor was not ready.");
        editor.setSelectionRange(${from}, ${from});
        editor.focus();
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        let start = view.coordsAtPos(${from}, 1);
        let end = view.coordsAtPos(${to}, -1);
        if (!start || !end) return null;
        return {
          start: { x: start.left, y: (start.top + start.bottom) / 2 },
          end: { x: end.left, y: (end.top + end.bottom) / 2 }
        };
      })()
    `,
    sessionId,
  );
  if (!drag) throw new Error("LiveMD code-fence drag coordinates were not available.");

  await dispatchCdpDrag(client, sessionId, drag.start, drag.end);
  let selected = await client.evaluate(
    `
      (() => {
        let editor = document.querySelector("live-md-editor");
        let root = editor?.shadowRoot;
        let selection = editor?.view?.state.selection.main;
        let rect = Array.from(root?.querySelectorAll(".cm-selectionBackground") ?? [])
          .map((node) => node.getBoundingClientRect())
          .find((candidate) =>
            candidate.left <= ${drag.start.x} + 1 &&
            candidate.right >= ${drag.end.x} - 1 &&
            candidate.top <= ${drag.start.y} &&
            candidate.bottom >= ${drag.start.y}
          );
        return {
          from: selection?.from ?? null,
          probe: rect
            ? {
                x: Math.floor((rect.left + rect.right) / 2),
                y: Math.floor(rect.top) - 1
              }
            : null,
          to: selection?.to ?? null
        };
      })()
    `,
    sessionId,
  );
  if (selected.from != from || selected.to != to || !selected.probe) {
    throw new Error(
      `LiveMD pointer drag did not select the code-fence spaces: ${JSON.stringify({
        expected: { from, to },
        selected,
      })}`,
    );
  }

  let selectedPixels = await captureScreenshotPixels(client, sessionId, selected.probe);
  await client.evaluate(
    `
      (async () => {
        let editor = document.querySelector("live-md-editor");
        editor?.setSelectionRange(${to}, ${to});
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
      })()
    `,
    sessionId,
  );
  let unselectedPixels = await captureScreenshotPixels(client, sessionId, selected.probe);
  let contrast = Math.max(
    ...selectedPixels.map((pixel, index) => pixelContrast(pixel, unselectedPixels[index])),
  );
  if (contrast < MINIMUM_SELECTION_EDGE_CONTRAST) {
    throw new Error(
      `LiveMD code-fence selection was too faint in the final Chromium pixels: ${JSON.stringify({
        contrast,
        selectedPixels,
        unselectedPixels,
      })}`,
    );
  }
}

function lineFeedCount(value) {
  return Array.from(value).filter((character) => character == "\n").length;
}

async function assertPreviewSurfaceReveal(client, sessionId, { content, label, source, widget }) {
  let fixture = `${source}\n\nAFTER`;
  for (let point of [
    { label: "upper-left", selector: widget, xRatio: 0.15, yRatio: 0.15 },
    { label: "lower-right", selector: widget, xRatio: 0.85, yRatio: 0.85 },
    { label: "rendered content", selector: content, xRatio: 0.5, yRatio: 0.5 },
  ]) {
    await setLiveMdSmokeDocument(client, sessionId, fixture);
    await client.waitForPredicate(
      `Boolean(document.querySelector("live-md-editor")?.shadowRoot?.querySelector(${JSON.stringify(
        point.selector,
      )}))`,
      sessionId,
    );

    await clickLiveMdWidget(client, sessionId, point.selector, point);
    await assertLiveMdPreviewState(client, sessionId, {
      expectedLineCount: lineFeedCount(fixture) + 1,
      expectedValue: fixture,
      forbiddenWidget: widget,
      label: `${label} ${point.label} click`,
    });

    let selection = await client.evaluate(
      `document.querySelector("live-md-editor")?.view?.state.selection.main.toJSON() ?? null`,
      sessionId,
    );
    if (!selection || selection.anchor < 0 || selection.anchor > source.length) {
      throw new Error(
        `${label} ${point.label} click did not select its source: ${JSON.stringify(selection)}`,
      );
    }
  }
}

async function assertPreviewFollowingBlankLineEditing(
  client,
  sessionId,
  { label, source, widget },
) {
  let fixture = `${source}\n\nAFTER`;
  let blankLinePosition = source.length + 1;
  await setLiveMdSmokeDocument(client, sessionId, fixture);
  await client.waitForPredicate(
    `Boolean(document.querySelector("live-md-editor")?.shadowRoot?.querySelector(${JSON.stringify(
      widget,
    )}))`,
    sessionId,
  );

  let before = await liveMdPreviewState(client, sessionId);
  await clickLiveMdLine(client, sessionId, blankLinePosition, 0.85);
  let selection = await client.evaluate(
    `document.querySelector("live-md-editor")?.view?.state.selection.main.head ?? null`,
    sessionId,
  );
  if (selection != blankLinePosition) {
    throw new Error(
      `${label} following blank line was not selectable from its right side: ${JSON.stringify({
        blankLinePosition,
        selection,
      })}`,
    );
  }

  await pressEditorKey(client, sessionId, "Enter");
  let afterEnter = `${source}\n\n\nAFTER`;
  await assertLiveMdPreviewState(client, sessionId, {
    expectedLineCount: before.lineCount + 1,
    expectedValue: afterEnter,
    requiredWidget: widget,
    label: `${label} following-line Enter`,
  });

  await pressEditorKey(client, sessionId, "Backspace");
  await assertLiveMdPreviewState(client, sessionId, {
    expectedLineCount: before.lineCount,
    expectedValue: fixture,
    requiredWidget: widget,
    label: `${label} following-line Backspace`,
  });
}

async function setLiveMdSmokeDocument(client, sessionId, value) {
  await client.evaluate(
    `
      (() => {
        let editor = document.querySelector("live-md-editor");
        if (!editor) throw new Error("live-md-editor was not found.");
        editor.value = ${JSON.stringify(value)};
        editor.setSelectionRange(editor.value.length, editor.value.length);
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        editor.focus();
      })()
    `,
    sessionId,
  );
  await waitForSettledUi();
}

async function clickLiveMdWidget(client, sessionId, selector, { xRatio, yRatio }) {
  let target = await client.evaluate(
    `
      (async () => {
        let widget = document
          .querySelector("live-md-editor")
          ?.shadowRoot?.querySelector(${JSON.stringify(selector)});
        if (!widget) return null;
        widget.scrollIntoView({ block: "center", inline: "center" });
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        let rect = widget.getBoundingClientRect();
        return {
          x: Math.floor(rect.left + rect.width * ${xRatio}),
          y: Math.floor(rect.top + rect.height * ${yRatio})
        };
      })()
    `,
    sessionId,
  );
  if (!target) throw new Error(`LiveMD widget was not found: ${selector}`);

  await dispatchCdpClick(client, sessionId, target);
}

async function clickLiveMdLine(client, sessionId, position, xRatio) {
  let target = await client.evaluate(
    `
      (() => {
        let editor = document.querySelector("live-md-editor");
        let root = editor?.shadowRoot;
        let line = Array.from(root?.querySelectorAll(".cm-line") ?? []).find(
          (candidate) => editor?.view?.posAtDOM(candidate, 0) == ${position}
        );
        let scroller = root?.querySelector(".cm-scroller");
        if (!line || !scroller) return null;
        let lineRect = line.getBoundingClientRect();
        let scrollerRect = scroller.getBoundingClientRect();
        return {
          x: Math.floor(scrollerRect.left + scrollerRect.width * ${xRatio}),
          y: Math.floor(lineRect.top + lineRect.height / 2)
        };
      })()
    `,
    sessionId,
  );
  if (!target) throw new Error(`LiveMD line was not found at ${position}`);

  await dispatchCdpClick(client, sessionId, target);
}

async function dispatchCdpClick(client, sessionId, target) {
  await client.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseMoved",
      x: target.x,
      y: target.y,
    },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    {
      button: "left",
      clickCount: 1,
      type: "mousePressed",
      x: target.x,
      y: target.y,
    },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    {
      button: "left",
      clickCount: 1,
      type: "mouseReleased",
      x: target.x,
      y: target.y,
    },
    sessionId,
  );
  await waitForSettledUi(100);
}

async function dispatchCdpDrag(client, sessionId, start, end) {
  await client.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: start.x, y: start.y },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    {
      button: "left",
      buttons: 1,
      clickCount: 1,
      type: "mousePressed",
      x: start.x,
      y: start.y,
    },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    { button: "left", buttons: 1, type: "mouseMoved", x: end.x, y: end.y },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    {
      button: "left",
      clickCount: 1,
      type: "mouseReleased",
      x: end.x,
      y: end.y,
    },
    sessionId,
  );
  await waitForSettledUi(100);
}

async function captureScreenshotPixels(client, sessionId, point) {
  let pagePoint = await client.evaluate(
    `({ x: ${point.x} + scrollX, y: ${point.y} + scrollY })`,
    sessionId,
  );
  let { data } = await client.send(
    "Page.captureScreenshot",
    {
      captureBeyondViewport: false,
      clip: { height: 4, scale: 1, width: 1, x: pagePoint.x, y: pagePoint.y },
      format: "png",
      fromSurface: true,
    },
    sessionId,
  );
  return client.evaluate(
    `
      (async () => {
        let image = new Image();
        image.src = "data:image/png;base64,${data}";
        await image.decode();
        let canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        let context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        let pixels = [];
        for (let y = 0; y < image.naturalHeight; y++) {
          pixels.push(Array.from(context.getImageData(0, y, 1, 1).data.slice(0, 3)));
        }
        return pixels;
      })()
    `,
    sessionId,
  );
}

function pixelContrast(left, right) {
  let leftLuminance = pixelLuminance(left);
  let rightLuminance = pixelLuminance(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
}

function pixelLuminance(pixel) {
  let [red, green, blue] = pixel.map((channel) => {
    let value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

async function pressEditorKey(client, sessionId, key) {
  let keySpec =
    key == "Enter"
      ? { code: "Enter", key: "Enter", nativeVirtualKeyCode: 13, windowsVirtualKeyCode: 13 }
      : { code: "Backspace", key: "Backspace", nativeVirtualKeyCode: 8, windowsVirtualKeyCode: 8 };
  await client.send("Input.dispatchKeyEvent", { ...keySpec, type: "rawKeyDown" }, sessionId);
  await client.send("Input.dispatchKeyEvent", { ...keySpec, type: "keyUp" }, sessionId);
  await waitForSettledUi(100);
}

async function assertLiveMdPreviewState(
  client,
  sessionId,
  { expectedLineCount, expectedValue, forbiddenWidget, label, requiredWidget },
) {
  let state = await liveMdPreviewState(client, sessionId);
  let requiredWidgetFound = requiredWidget ? state.widgets.includes(requiredWidget) : true;
  let forbiddenWidgetFound = forbiddenWidget ? state.widgets.includes(forbiddenWidget) : false;
  if (
    state.value != expectedValue ||
    state.lineCount != expectedLineCount ||
    !requiredWidgetFound ||
    forbiddenWidgetFound
  ) {
    throw new Error(
      `${label} did not preserve the user-visible preview boundary: ${JSON.stringify({
        ...state,
        expectedLineCount,
        expectedValue,
        forbiddenWidget,
        requiredWidget,
      })}`,
    );
  }
}

async function liveMdPreviewState(client, sessionId) {
  return client.evaluate(
    `
      (() => {
        let editor = document.querySelector("live-md-editor");
        let root = editor?.shadowRoot;
        return {
          lineCount: root?.querySelectorAll(".cm-line").length ?? 0,
          lineText: Array.from(root?.querySelectorAll(".cm-line") ?? []).map(
            (line) => line.textContent
          ),
          saveText: Array.from(document.querySelectorAll("[role=status], [aria-live]"))
            .map((node) => node.textContent)
            .filter(Boolean),
          selection: editor?.view?.state.selection.main.toJSON() ?? null,
          value: editor?.value ?? null,
          widgets: [
            ".cm-md-mermaid",
            ".cm-md-image-preview",
            ".cm-md-table-preview"
          ].filter((selector) => root?.querySelector(selector))
        };
      })()
    `,
    sessionId,
  );
}

async function assertOwnerReconnectSharedFileFlow(client) {
  if (!shareRelayOrigin) {
    console.log(
      "Skipping owner reconnect shared-file UI smoke: VITE_LOCAL_MD_SHARE_RELAY_ORIGIN is not set.",
    );
    return;
  }

  let fileBaseName = `owner-reconnect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let fileName = `${fileBaseName}.md`;
  let initialValue = `# Owner reconnect smoke\n\nCreated before the host goes offline.\n`;
  let sharedValue = `# Owner reconnect smoke\n\nGuest edit while the host is offline.\n`;
  let firstOwner = await attachLocalWorkspaceTarget(client);
  let guest = null;
  let secondOwner = null;

  try {
    await openMockLocalWorkspace(client, firstOwner.sessionId);
    await createAndEditLocalFile(client, firstOwner.sessionId, fileBaseName, initialValue);
    let link = await createSharedFileLink(client, firstOwner.sessionId);

    await client.send("Target.closeTarget", { targetId: firstOwner.targetId });
    firstOwner = null;
    await waitForSettledUi(500);

    guest = await attachNewTarget(client, link, { isolated: true });
    await client.waitForPredicate(
      `document.querySelector("live-md-editor")?.value == ${JSON.stringify(initialValue)}`,
      guest.sessionId,
      10_000,
    );
    await client.evaluate(
      `
        (() => {
          let editor = document.querySelector("live-md-editor");
          if (!editor) throw new Error("guest live-md-editor was not found.");
          editor.value = ${JSON.stringify(sharedValue)};
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        })()
      `,
      guest.sessionId,
    );
    await client.waitForPredicate(
      `document.body.innerText.includes("Waiting for host")`,
      guest.sessionId,
      15_000,
    );

    secondOwner = await attachLocalWorkspaceTarget(client);
    await openMockLocalWorkspace(client, secondOwner.sessionId);
    await selectWorkspaceFile(client, secondOwner.sessionId, fileName);
    try {
      await client.waitForPredicate(
        `window.__localMdSmokeFiles?.get(${JSON.stringify(fileName)}) == ${JSON.stringify(
          sharedValue,
        )}`,
        secondOwner.sessionId,
        15_000,
      );
    } catch (error) {
      let state = await client.evaluate(
        `
          (() => ({
            body: document.body.innerText,
            editorValue: document.querySelector("live-md-editor")?.value ?? null,
            fileValue: window.__localMdSmokeFiles?.get(${JSON.stringify(fileName)}) ?? null,
            hostSecrets: Object.keys(localStorage).filter((key) =>
              key.startsWith("local-md-workspace:share-host-secret:")
            ),
            files: Array.from(window.__localMdSmokeFiles?.entries?.() ?? []).map(([name, value]) => [
              name,
              typeof value == "string" ? value.slice(0, 200) : "<" + value.byteLength + " bytes>"
            ])
          }))()
        `,
        secondOwner.sessionId,
      );
      let guestState = guest
        ? await client
            .evaluate(
              `
                (() => ({
                  body: document.body.innerText,
                  editorValue: document.querySelector("live-md-editor")?.value ?? null
                }))()
              `,
              guest.sessionId,
            )
            .catch(() => null)
        : null;
      throw new Error(
        `${error.message}\n\nOwner reconnect state:\n${JSON.stringify(
          state,
          null,
          2,
        )}\n\nGuest state:\n${JSON.stringify(guestState, null, 2)}`,
      );
    }
    await client.waitForPredicate(
      `document.body.innerText.includes("Saved to host")`,
      guest.sessionId,
      15_000,
    );
  } finally {
    if (guest) {
      await client.send("Target.closeTarget", { targetId: guest.targetId }).catch(() => {});
      if (guest.browserContextId) {
        await client
          .send("Target.disposeBrowserContext", { browserContextId: guest.browserContextId })
          .catch(() => {});
      }
    }
    if (secondOwner) {
      await client.send("Target.closeTarget", { targetId: secondOwner.targetId }).catch(() => {});
    }
    if (firstOwner) {
      await client.send("Target.closeTarget", { targetId: firstOwner.targetId }).catch(() => {});
    }
  }

  console.log("Owner reconnect shared-file UI smoke passed.");
}

async function assertOwnerExternalConflictFlow(client) {
  if (!shareRelayOrigin) {
    console.log(
      "Skipping owner external-conflict shared-file UI smoke: VITE_LOCAL_MD_SHARE_RELAY_ORIGIN is not set.",
    );
    return;
  }

  let fileBaseName = `owner-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let fileName = `${fileBaseName}.md`;
  let initialValue = "# Owner conflict smoke\n\nInitial host version.\n";
  let externalValue = "# Owner conflict smoke\n\nExternal source edit.\n";
  let sharedValue = "# Owner conflict smoke\n\nGuest relay edit while host is offline.\n";
  let firstOwner = await attachLocalWorkspaceTarget(client);
  let guest = null;
  let secondOwner = null;

  try {
    await openMockLocalWorkspace(client, firstOwner.sessionId);
    await createAndEditLocalFile(client, firstOwner.sessionId, fileBaseName, initialValue);
    let link = await createSharedFileLink(client, firstOwner.sessionId);

    await client.send("Target.closeTarget", { targetId: firstOwner.targetId });
    firstOwner = null;
    await waitForSettledUi(500);

    guest = await attachNewTarget(client, link, { isolated: true });
    await client.waitForPredicate(
      `document.querySelector("live-md-editor")?.value == ${JSON.stringify(initialValue)}`,
      guest.sessionId,
      10_000,
    );
    await client.evaluate(
      `
        (() => {
          let editor = document.querySelector("live-md-editor");
          if (!editor) throw new Error("guest live-md-editor was not found.");
          editor.value = ${JSON.stringify(sharedValue)};
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        })()
      `,
      guest.sessionId,
    );
    await client.waitForPredicate(
      `document.body.innerText.includes("Waiting for host")`,
      guest.sessionId,
      15_000,
    );

    secondOwner = await attachLocalWorkspaceTarget(client);
    await client.evaluate(
      `window.__localMdSmokeSetFile(${JSON.stringify(fileName)}, ${JSON.stringify(externalValue)})`,
      secondOwner.sessionId,
    );
    await openMockLocalWorkspace(client, secondOwner.sessionId);
    await selectWorkspaceFile(client, secondOwner.sessionId, fileName, {
      expectedEditorText: "Owner conflict smoke",
    });
    try {
      await client.waitForPredicate(
        `
          (() => {
            let files = Array.from(window.__localMdSmokeFiles?.entries?.() ?? []);
            let fileValue = window.__localMdSmokeFiles?.get(${JSON.stringify(fileName)}) ?? "";
            let editorValue = document.querySelector("live-md-editor")?.value ?? "";
            return fileValue.includes("Guest relay edit while") &&
              fileValue.includes("host is offline") &&
              fileValue.includes("source edit") &&
              editorValue.includes("Guest relay edit while") &&
              editorValue.includes("host is offline") &&
              editorValue.includes("source edit") &&
              !files.some(([name]) => name.includes(".shared-conflict-"));
          })()
        `,
        secondOwner.sessionId,
        10_000,
      );
    } catch (error) {
      let state = await client.evaluate(
        `
          (() => ({
            body: document.body.innerText,
            editorValue: document.querySelector("live-md-editor")?.value ?? null,
            fileValue: window.__localMdSmokeFiles?.get(${JSON.stringify(fileName)}) ?? null,
            files: Array.from(window.__localMdSmokeFiles?.entries?.() ?? []).map(([name, value]) => [
              name,
              typeof value == "string" ? value.slice(0, 500) : "<" + value.byteLength + " bytes>"
            ])
          }))()
        `,
        secondOwner.sessionId,
      );
      throw new Error(
        `${error.message}\n\nOwner conflict resolution state:\n${JSON.stringify(state, null, 2)}`,
      );
    }
    await client.waitForPredicate(
      `
        (() => {
          let value = window.__localMdSmokeFiles?.get(${JSON.stringify(fileName)}) ?? "";
          return value.includes("Guest relay edit while") &&
            value.includes("host is offline") &&
            value.includes("source edit");
        })()
      `,
      secondOwner.sessionId,
      5_000,
    );
    await client.waitForPredicate(
      `document.body.innerText.includes("Saved to host")`,
      guest.sessionId,
      15_000,
    );
  } finally {
    if (guest) await closeTarget(client, guest);
    if (secondOwner) await closeTarget(client, secondOwner);
    if (firstOwner) await closeTarget(client, firstOwner);
  }

  console.log("Owner external-conflict shared-file UI smoke passed.");
}

async function assertSavedDropboxConfigUi(client, sessionId) {
  await ensureSidebarOpen(client, sessionId);
  let state = await client.evaluate(
    `
      (() => ({
        body: document.body.innerText,
        hasReconnectAction: Array.from(document.querySelectorAll("button")).some((button) =>
          button.textContent.includes("Continue Dropbox") && !button.disabled
        )
      }))()
    `,
    sessionId,
  );
  if (!state.body.includes("Continue Dropbox") && !state.hasReconnectAction) {
    throw new Error(
      `Stored Dropbox config did not expose a reconnect action: ${JSON.stringify(state)}`,
    );
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
    await assertSharedFileGuestEdit(client, sessionId, {
      expectedInitialValue: nextValue,
      nextValue: `# Dropbox UI smoke\n\nShared edit for ${fileName}\n`,
      waitForOwnerSave: () =>
        waitForDropboxFileValue(filePath, `# Dropbox UI smoke\n\nShared edit for ${fileName}\n`),
    });
  } finally {
    await deleteDropboxFile(filePath).catch(() => {});
  }
}

async function assertMockDropboxWorkspaceFlow(client, sessionId) {
  let fileName = `mock-dropbox-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.md`;
  let nextValue = `# Mock Dropbox UI smoke\\n\\n${fileName}\\n`;
  let sharedValue = `# Mock Dropbox UI smoke\\n\\nShared edit for ${fileName}\\n`;

  await installDropboxOAuthStub(
    client,
    sessionId,
    "mock-dropbox-token",
    "dbid:mock-dropbox-account",
  );
  await installMockDropboxOperator(client, sessionId);
  await navigate(client, sessionId, SMOKE_URL);
  await client.evaluate(
    "localStorage.removeItem(" + JSON.stringify(DROPBOX_CONFIG_KEY) + ")",
    sessionId,
  );
  await navigate(client, sessionId, SMOKE_URL);
  await connectDropboxWorkspace(client, sessionId);
  await createAndEditDropboxFile(client, sessionId, fileName, nextValue);
  await waitForMockDropboxFileValue(client, sessionId, fileName, nextValue);
  await assertSharedFileGuestEdit(client, sessionId, {
    expectedInitialValue: nextValue,
    nextValue: sharedValue,
    waitForOwnerSave: () => waitForMockDropboxFileValue(client, sessionId, fileName, sharedValue),
  });
  console.log("Mock Dropbox workspace shared-file UI smoke passed.");
}

async function assertSharedFileGuestEdit(
  client,
  ownerSessionId,
  { expectedInitialValue, nextValue, waitForOwnerSave },
) {
  if (!shareRelayOrigin) {
    console.log("Skipping shared-file UI smoke: VITE_LOCAL_MD_SHARE_RELAY_ORIGIN is not set.");
    return;
  }

  let link = await createSharedFileLink(client, ownerSessionId);

  let guest = await attachNewTarget(client, link, { isolated: true });
  try {
    await client.waitForPredicate(
      `Boolean(document.querySelector("live-md-editor"))`,
      guest.sessionId,
    );
    await client.waitForPredicate(
      `document.querySelector("live-md-editor")?.value == ${JSON.stringify(expectedInitialValue)}`,
      guest.sessionId,
      10_000,
    );
    await client.evaluate(
      `
        (() => {
          let editor = document.querySelector("live-md-editor");
          if (!editor) throw new Error("guest live-md-editor was not found.");
          editor.value = ${JSON.stringify(nextValue)};
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        })()
      `,
      guest.sessionId,
    );
    await waitForOwnerSave();
    await client.waitForPredicate(
      `document.body.innerText.includes("Saved to host")`,
      guest.sessionId,
      15_000,
    );
  } finally {
    await client.send("Target.closeTarget", { targetId: guest.targetId }).catch(() => {});
    if (guest.browserContextId) {
      await client
        .send("Target.disposeBrowserContext", { browserContextId: guest.browserContextId })
        .catch(() => {});
    }
  }

  console.log("Shared-file UI smoke passed.");
}

async function assertSharedFileLifecycle(client, ownerSessionId, { expectedValue }) {
  if (!shareRelayOrigin) {
    console.log(
      "Skipping shared-file lifecycle UI smoke: VITE_LOCAL_MD_SHARE_RELAY_ORIGIN is not set.",
    );
    return;
  }

  let oldLink = await sharedFileDialogLink(client, ownerSessionId);
  await clickShareDialogButton(client, ownerSessionId, "Rotate link");
  await client.waitForPredicate(
    `document.querySelector("#shared-file-link")?.value && document.querySelector("#shared-file-link")?.value != ${JSON.stringify(
      oldLink,
    )}`,
    ownerSessionId,
    10_000,
  );
  let newLink = await sharedFileDialogLink(client, ownerSessionId);

  let oldGuest = await attachNewTarget(client, oldLink, { isolated: true });
  try {
    await client.waitForPredicate(
      `document.body.innerText.includes("Could not join shared file") && !document.querySelector("live-md-editor")`,
      oldGuest.sessionId,
      10_000,
    );
  } finally {
    await closeTarget(client, oldGuest);
  }

  let activeGuest = await attachNewTarget(client, newLink, { isolated: true });
  try {
    await client.waitForPredicate(
      `document.querySelector("live-md-editor")?.value == ${JSON.stringify(expectedValue)}`,
      activeGuest.sessionId,
      10_000,
    );
    await clickShareDialogButton(client, ownerSessionId, "Stop sharing");
    await client.waitForPredicate(
      `document.body.innerText.includes("Sharing stopped") || document.body.innerText.includes("Sharing has been stopped") || document.body.innerText.includes("Shared file access was rejected")`,
      activeGuest.sessionId,
      10_000,
    );
  } finally {
    await closeTarget(client, activeGuest);
  }

  console.log("Shared-file lifecycle UI smoke passed.");
}

async function sharedFileDialogLink(client, sessionId) {
  let link = await client.evaluate(
    `document.querySelector("#shared-file-link")?.value ?? ""`,
    sessionId,
  );
  if (!link || !link.includes("/share/") || !link.includes("#key=")) {
    throw new Error(`Shared file link was not available: ${link}`);
  }
  return link;
}

async function clickShareDialogButton(client, sessionId, label) {
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.trim() == ${JSON.stringify(label)} && !item.disabled
        );
        if (!button) throw new Error(${JSON.stringify(`${label} button was not found.`)});
        button.click();
      })()
    `,
    sessionId,
  );
}

async function closeTarget(client, target) {
  await client.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
  if (target.browserContextId) {
    await client
      .send("Target.disposeBrowserContext", { browserContextId: target.browserContextId })
      .catch(() => {});
  }
}

async function createSharedFileLink(client, ownerSessionId) {
  await clickDocumentActionMenuItem(client, ownerSessionId, "Share file");
  await client.waitForPredicate(
    `document.body.innerText.includes("Anyone with this link can edit")`,
    ownerSessionId,
  );
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.trim() == "Create link" && !item.disabled
        );
        if (!button) throw new Error("Create link button was not found.");
        button.click();
      })()
    `,
    ownerSessionId,
  );
  await client.waitForPredicate(
    `Boolean(document.querySelector("#shared-file-link")?.value)`,
    ownerSessionId,
    10_000,
  );
  let link = await client.evaluate(
    `document.querySelector("#shared-file-link")?.value ?? ""`,
    ownerSessionId,
  );
  if (!link || !link.includes("/share/") || !link.includes("#key=")) {
    throw new Error(`Shared file link was not generated: ${link}`);
  }
  return link;
}

async function clickDocumentActionMenuItem(client, sessionId, label) {
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.getAttribute("aria-label") == "More actions" &&
          !item.disabled &&
          item.getClientRects().length
        );
        if (!button) throw new Error("More actions button was not found.");
        button.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            pointerType: "mouse"
          })
        );
        button.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            button: 0,
            pointerType: "mouse"
          })
        );
        button.click();
      })()
    `,
    sessionId,
  );
  await waitForSettledUi();
  await client.evaluate(
    `
      (() => {
        let item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((candidate) =>
          candidate.textContent.includes(${JSON.stringify(label)}) &&
          candidate.getAttribute("aria-disabled") != "true" &&
          candidate.getClientRects().length
        );
        if (!item) throw new Error(${JSON.stringify(`${label} menu item was not found.`)});
        item.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            pointerType: "mouse"
          })
        );
        item.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            button: 0,
            pointerType: "mouse"
          })
        );
        item.click();
      })()
    `,
    sessionId,
  );
  await waitForSettledUi();
}

async function waitForLocalWorkspaceReady(client, sessionId) {
  try {
    await client.waitForPredicate(
      `Array.from(document.querySelectorAll("button")).some((button) => button.textContent.includes("New file") && !button.disabled)`,
      sessionId,
    );
    await ensureSidebarOpen(client, sessionId);
    await client.waitForPredicate(`document.body.innerText.includes("Smoke Workspace")`, sessionId);
  } catch (error) {
    let state = await workspaceSmokeState(client, sessionId);
    throw new Error(
      `${error.message}\n\nLocal workspace state:\n${JSON.stringify(state, null, 2)}`,
    );
  }
}

async function ensureSidebarOpen(client, sessionId) {
  await client.evaluate(
    `
      (() => {
        let buttons = Array.from(document.querySelectorAll("button"));
        let newFileVisible = buttons.some((button) =>
          button.textContent.includes("New file") &&
          !button.disabled &&
          button.getClientRects().length
        );
        if (newFileVisible) return;

        let showSidebar = buttons.find((button) =>
          button.textContent.trim() == "Show sidebar" &&
          !button.disabled &&
          button.getClientRects().length
        );
        showSidebar?.click();
      })()
    `,
    sessionId,
  );
  await waitForSettledUi();
}

async function clickNewFileButton(client, sessionId) {
  await ensureSidebarOpen(client, sessionId);
  await client.evaluate(
    `
      (() => {
        let buttons = Array.from(document.querySelectorAll("button"));
        let button = buttons.find((item) =>
          item.textContent.includes("New file") && !item.disabled && item.getClientRects().length
        ) ?? buttons.find((item) =>
          item.textContent.includes("New file") && !item.disabled
        );
        if (!button) throw new Error("New file button was not found.");
        button.click();
      })()
    `,
    sessionId,
  );
}

async function workspaceSmokeState(client, sessionId) {
  return client.evaluate(
    `
      (() => ({
        body: document.body.innerText,
        buttons: Array.from(document.querySelectorAll("button")).map((button) => ({
          disabled: button.disabled,
          text: button.textContent.trim(),
          visible: Boolean(button.getClientRects().length)
        })),
        hasDirectoryPicker: typeof window.showDirectoryPicker == "function",
        selectedEditorValue: document.querySelector("live-md-editor")?.value ?? null
      }))()
    `,
    sessionId,
  );
}

async function openMockLocalWorkspace(client, sessionId) {
  let hasWorkspace = await client.evaluate(
    `document.body.innerText.includes("Smoke Workspace")`,
    sessionId,
  );
  if (!hasWorkspace) {
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
  }
  await waitForLocalWorkspaceReady(client, sessionId);
}

async function createAndEditLocalFile(client, sessionId, fileBaseName, nextValue) {
  let fileName = fileBaseName.endsWith(".md") ? fileBaseName : `${fileBaseName}.md`;
  await clickNewFileButton(client, sessionId);
  await client.waitForPredicate(
    `Boolean(document.querySelector("#markdown-file-name"))`,
    sessionId,
  );
  await client.evaluate(
    `
      (() => {
        let input = document.querySelector("#markdown-file-name");
        let setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(fileBaseName)});
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
  try {
    await client.waitForPredicate(`Boolean(document.querySelector("live-md-editor"))`, sessionId);
  } catch (error) {
    let state = await client.evaluate(
      `
        (() => ({
          body: document.body.innerText,
          files: Array.from(window.__localMdSmokeFiles?.entries?.() ?? []).map(([name, value]) => [
            name,
            typeof value == "string" ? value.slice(0, 200) : "<" + value.byteLength + " bytes>"
          ]),
          treeHtml: document.querySelector(".local-md-file-tree")?.innerHTML ?? ""
        }))()
      `,
      sessionId,
    );
    throw new Error(`${error.message}\n\nLocal create state:\n${JSON.stringify(state, null, 2)}`);
  }

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
    `window.__localMdSmokeFiles?.get(${JSON.stringify(fileName)}) == ${JSON.stringify(nextValue)}`,
    sessionId,
    5_000,
  );
}

async function selectWorkspaceFile(
  client,
  sessionId,
  fileName,
  { expectedEditorText = "Owner reconnect smoke" } = {},
) {
  await client.waitForPredicate(
    `window.__localMdSmokeFiles?.has(${JSON.stringify(
      fileName,
    )}) && Boolean(document.querySelector(".local-md-file-tree"))`,
    sessionId,
  );
  let clicked = await clickWorkspaceFileRow(client, sessionId, fileName);
  if (!clicked) {
    let state = await localFileTreeState(client, sessionId);
    throw new Error(
      `Could not click file ${fileName} in workspace tree.\n\nCurrent state:\n${JSON.stringify(
        state,
        null,
        2,
      )}`,
    );
  }
  await client.waitForPredicate(
    `document.querySelector("live-md-editor")?.value?.includes(${JSON.stringify(
      expectedEditorText,
    )})`,
    sessionId,
    10_000,
  );
}

async function clickWorkspaceFileRow(client, sessionId, fileName) {
  let target = await client.evaluate(
    `
      (() => {
        let files = Array.from(window.__localMdSmokeFiles?.keys?.() ?? [])
          .filter((name) => name.endsWith(".md"))
          .sort((left, right) => left.localeCompare(right, undefined, {
            numeric: true,
            sensitivity: "base"
          }));
        let index = files.indexOf(${JSON.stringify(fileName)});
        let tree = document.querySelector(".local-md-file-tree");
        if (index == -1 || !tree) return null;
        let rect = tree.getBoundingClientRect();
        return {
          x: Math.floor(rect.left + Math.min(120, Math.max(24, rect.width / 2))),
          y: Math.floor(rect.top + 12 + index * 24)
        };
      })()
    `,
    sessionId,
  );
  if (!target) return false;

  await client.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseMoved",
      x: target.x,
      y: target.y,
    },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    {
      button: "left",
      clickCount: 1,
      type: "mousePressed",
      x: target.x,
      y: target.y,
    },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    {
      button: "left",
      clickCount: 1,
      type: "mouseReleased",
      x: target.x,
      y: target.y,
    },
    sessionId,
  );
  return true;
}

async function localFileTreeState(client, sessionId) {
  return client.evaluate(
    `
      (() => ({
        body: document.body.innerText,
        files: Array.from(window.__localMdSmokeFiles?.entries?.() ?? []).map(([name, value]) => [
          name,
          typeof value == "string" ? value.slice(0, 200) : "<" + value.byteLength + " bytes>"
        ]),
        treeHtml: document.querySelector(".local-md-file-tree")?.innerHTML ?? ""
      }))()
    `,
    sessionId,
  );
}

async function connectDropboxWorkspace(client, sessionId) {
  await ensureSidebarOpen(client, sessionId);
  await client.evaluate(
    `
      (() => {
        let buttons = Array.from(document.querySelectorAll("button"));
        let button = buttons.find((item) =>
          item.textContent.includes("Connect Dropbox") &&
          !item.disabled &&
          item.getClientRects().length
        ) ?? buttons.find((item) =>
          item.textContent.includes("Connect Dropbox") && !item.disabled
        );
        if (!button) throw new Error("Connect Dropbox button was not found.");
        button.click();
      })()
    `,
    sessionId,
  );

  try {
    await client.waitForPredicate(
      `Array.from(document.querySelectorAll("button")).some((button) => button.textContent.includes("New file") && !button.disabled)`,
      sessionId,
      20_000,
    );
  } catch (error) {
    let state = await workspaceSmokeState(client, sessionId);
    throw new Error(
      `${error.message}\n\nDropbox workspace state:\n${JSON.stringify(state, null, 2)}`,
    );
  }
  await ensureSidebarOpen(client, sessionId);
}

async function createAndEditDropboxFile(client, sessionId, fileName, nextValue) {
  await clickNewFileButton(client, sessionId);
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
  await client.waitForPredicate(`document.body.innerText.includes("Saved")`, sessionId, 20_000);
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

async function installMockFileSystemAccess(client, sessionId, { preserveIndexedDb = false } = {}) {
  let disableIndexedDbSource = preserveIndexedDb
    ? ""
    : `
          try {
            Object.defineProperty(window, "indexedDB", {
              configurable: true,
              value: undefined
            });
          } catch {}
      `;
  await client.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
        (() => {
          let smokeStorageKey = "local-md-workspace:smoke-files";
          let smokeDirectoriesKey = "local-md-workspace:smoke-directories";
          ${disableIndexedDbSource}
          window.__localMdSmokeServiceWorkerMessages = [];
          try {
            navigator.serviceWorker?.addEventListener("message", (event) => {
              window.__localMdSmokeServiceWorkerMessages.push(event.data);
            });
            if (typeof ServiceWorker != "undefined") {
              let postMessage = ServiceWorker.prototype.postMessage;
              ServiceWorker.prototype.postMessage = function (...args) {
                window.__localMdSmokeServiceWorkerMessages.push(args[0]);
                return postMessage.apply(this, args);
              };
            }
          } catch {}

          function encodeBytes(bytes) {
            let binary = "";
            for (let byte of bytes) binary += String.fromCharCode(byte);
            return btoa(binary);
          }

          function decodeBytes(value) {
            let binary = atob(value);
            let bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
              bytes[index] = binary.charCodeAt(index);
            }
            return bytes;
          }

          function serializeValue(value) {
            if (typeof value == "string") return { kind: "text", value };
            return { kind: "bytes", value: encodeBytes(value) };
          }

          function deserializeValue(value) {
            if (value?.kind == "text" && typeof value.value == "string") return value.value;
            if (value?.kind == "bytes" && typeof value.value == "string") {
              return decodeBytes(value.value);
            }
            return "";
          }

          function loadSmokeFiles() {
            try {
              let persisted = readPersistedSmokeFiles();
              if (persisted) return persisted;
            } catch {}

            let files = new Map([["welcome.md", "# Welcome\\n"]]);
            writePersistedSmokeFiles(files);
            return files;
          }

          function loadSmokeDirectories(files) {
            let directories = new Set();
            try {
              let raw = localStorage.getItem(smokeDirectoriesKey);
              if (raw) {
                for (let path of JSON.parse(raw)) directories.add(String(path));
              }
            } catch {}

            for (let path of files.keys()) ensureParents(directories, path);
            return directories;
          }

          function readPersistedSmokeFiles() {
            let raw = localStorage.getItem(smokeStorageKey);
            if (!raw) return null;
            return new Map(
              JSON.parse(raw).map(([name, value]) => [name, deserializeValue(value)])
            );
          }

          function writePersistedSmokeFiles(files) {
            localStorage.setItem(
              smokeStorageKey,
              JSON.stringify(Array.from(files.entries()).map(([name, value]) => [name, serializeValue(value)]))
            );
          }

          function persistSmokeFile(path, value) {
            let files = readPersistedSmokeFiles() ?? new Map();
            files.set(path, value);
            writePersistedSmokeFiles(files);
          }

          function removePersistedSmokeFiles(paths) {
            let files = readPersistedSmokeFiles() ?? new Map();
            for (let path of paths) files.delete(path);
            writePersistedSmokeFiles(files);
          }

          function persistSmokeDirectories(directories) {
            localStorage.setItem(smokeDirectoriesKey, JSON.stringify(Array.from(directories)));
          }

          function normalize(path) {
            return String(path || "").trim().replace(/\\\\/g, "/").replace(/^\\/+|\\/+$/g, "");
          }

          function joinPath(parent, name) {
            let normalizedName = normalize(name);
            return parent ? parent + "/" + normalizedName : normalizedName;
          }

          function parentPath(path) {
            let normalized = normalize(path);
            let index = normalized.lastIndexOf("/");
            return index == -1 ? "" : normalized.slice(0, index);
          }

          function ensureParents(directories, path) {
            let current = "";
            for (let part of parentPath(path).split("/").filter(Boolean)) {
              current = current ? current + "/" + part : part;
              directories.add(current);
            }
          }

          function directoryExists(files, directories, path) {
            let normalized = normalize(path);
            if (!normalized) return true;
            if (directories.has(normalized)) return true;
            for (let filePath of files.keys()) {
              if (filePath.startsWith(normalized + "/")) return true;
            }
            return false;
          }

          function bytesFromBufferSource(data) {
            if (data instanceof Uint8Array) return new Uint8Array(data);
            if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
            if (ArrayBuffer.isView(data)) {
              return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
            }
            return null;
          }

          function concatBytes(chunks) {
            let encoder = new TextEncoder();
            let byteChunks = chunks.map((chunk) =>
              typeof chunk == "string" ? encoder.encode(chunk) : chunk
            );
            let length = byteChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
            let result = new Uint8Array(length);
            let offset = 0;
            for (let chunk of byteChunks) {
              result.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return result;
          }

          function stableLastModified(value) {
            let bytes = typeof value == "string"
              ? new TextEncoder().encode(value)
              : bytesFromBufferSource(value) ?? new Uint8Array();
            let hash = 2166136261;
            for (let byte of bytes) {
              hash ^= byte;
              hash = Math.imul(hash, 16777619);
            }
            return 1_700_000_000_000 + (hash >>> 0);
          }

          class SmokeWritableFileStream {
            constructor(files, path) {
              this.files = files;
              this.path = path;
              this.chunks = [];
            }
            async abort() {
              this.chunks = [];
            }
            async close() {
              let value = this.chunks.every((chunk) => typeof chunk == "string")
                ? this.chunks.join("")
                : concatBytes(this.chunks);
              if (this.path.endsWith(".md") && value instanceof Uint8Array) {
                value = new TextDecoder().decode(value);
              }
              this.files.set(this.path, value);
              persistSmokeFile(this.path, value);
            }
            async write(data) {
              if (data && typeof data == "object" && data.type == "write") {
                data = data.data;
              }
              if (typeof data == "string") {
                this.chunks.push(data);
              } else if (data instanceof Blob) {
                this.chunks.push(new Uint8Array(await data.arrayBuffer()));
              } else {
                this.chunks.push(
                  bytesFromBufferSource(data) ?? new TextEncoder().encode(String(data))
                );
              }
            }
          }

          class SmokeFileHandle {
            kind = "file";
            constructor(name, files, path = name) {
              this.name = name;
              this.files = files;
              this.path = path;
            }
            async getFile() {
              let value = this.files.get(this.path) ?? "";
              return new File([value], this.name, {
                lastModified: stableLastModified(value),
                type: this.name.endsWith(".md") ? "text/markdown" : "application/octet-stream"
              });
            }
            async createWritable() {
              return new SmokeWritableFileStream(this.files, this.path);
            }
          }

          class SmokeDirectoryHandle {
            kind = "directory";
            constructor(name, files = new Map(), directories = new Set(), path = "") {
              this.name = name;
              this.files = files;
              this.directories = directories;
              this.path = path;
            }
            async queryPermission() {
              return "granted";
            }
            async requestPermission() {
              return "granted";
            }
            async getDirectoryHandle(name, options = {}) {
              let path = joinPath(this.path, name);
              if (this.files.has(path)) throw new DOMException("Entry is a file.", "TypeMismatchError");
              if (options.create) {
                ensureParents(this.directories, path);
                this.directories.add(path);
                persistSmokeDirectories(this.directories);
              } else if (!directoryExists(this.files, this.directories, path)) {
                throw new DOMException("Directory not found.", "NotFoundError");
              }
              return new SmokeDirectoryHandle(name, this.files, this.directories, path);
            }
            async getFileHandle(name, options = {}) {
              let path = joinPath(this.path, name);
              if (directoryExists(this.files, this.directories, path)) {
                throw new DOMException("Entry is a directory.", "TypeMismatchError");
              }
              if (!this.files.has(path)) {
                if (!options.create) throw new DOMException("File not found.", "NotFoundError");
                ensureParents(this.directories, path);
                this.files.set(path, "");
                persistSmokeFile(path, "");
                persistSmokeDirectories(this.directories);
              }
              return new SmokeFileHandle(name, this.files, path);
            }
            async removeEntry(name, options = {}) {
              let path = joinPath(this.path, name);
              if (this.files.delete(path)) {
                removePersistedSmokeFiles([path]);
                return;
              }
              if (!directoryExists(this.files, this.directories, path)) {
                throw new DOMException("Entry not found.", "NotFoundError");
              }
              if (!options.recursive && Array.from(this.files.keys()).some((key) => key.startsWith(path + "/"))) {
                throw new DOMException("Directory is not empty.", "InvalidModificationError");
              }
              let removedFiles = [];
              for (let key of Array.from(this.files.keys())) {
                if (key.startsWith(path + "/")) {
                  this.files.delete(key);
                  removedFiles.push(key);
                }
              }
              for (let key of Array.from(this.directories)) {
                if (key == path || key.startsWith(path + "/")) this.directories.delete(key);
              }
              removePersistedSmokeFiles(removedFiles);
              persistSmokeDirectories(this.directories);
            }
            async *entries() {
              let prefix = this.path ? this.path + "/" : "";
              let emitted = new Set();
              for (let directory of Array.from(this.directories).sort()) {
                if (!directory.startsWith(prefix)) continue;
                let rest = directory.slice(prefix.length);
                if (!rest || rest.includes("/")) continue;
                emitted.add(rest);
                yield [
                  rest,
                  new SmokeDirectoryHandle(rest, this.files, this.directories, directory),
                ];
              }
              for (let path of Array.from(this.files.keys()).sort()) {
                if (!path.startsWith(prefix)) continue;
                let rest = path.slice(prefix.length);
                if (!rest || rest.includes("/") || emitted.has(rest)) continue;
                yield [rest, new SmokeFileHandle(rest, this.files, path)];
              }
            }
            async *values() {
              for await (let [, handle] of this.entries()) {
                yield handle;
              }
            }
          }

          let files = loadSmokeFiles();
          let directories = loadSmokeDirectories(files);
          Object.defineProperties(window, {
            FileSystemDirectoryHandle: { configurable: true, value: SmokeDirectoryHandle },
            FileSystemFileHandle: { configurable: true, value: SmokeFileHandle },
            FileSystemWritableFileStream: {
              configurable: true,
              value: SmokeWritableFileStream,
            },
          });
          window.__localMdSmokeFiles = files;
          window.__localMdSmokeSetFile = (name, value) => {
            let path = normalize(name);
            ensureParents(directories, path);
            files.set(path, String(value));
            persistSmokeFile(path, String(value));
            persistSmokeDirectories(directories);
          };
          window.showDirectoryPicker = async () => new SmokeDirectoryHandle("Smoke Workspace", files, directories);
        })();
      `,
    },
    sessionId,
  );
}

async function installDropboxOAuthStub(
  client,
  sessionId,
  accessToken = dropboxAccessToken,
  accountId,
) {
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
                access_token: ${JSON.stringify(accessToken)},
                expires_in: 3600
              }), {
                headers: { "Content-Type": "application/json" },
                status: 200
              }));
            }
            if (
              ${JSON.stringify(Boolean(accountId))} &&
              url == "https://api.dropboxapi.com/2/users/get_current_account"
            ) {
              return Promise.resolve(new Response(JSON.stringify({
                account_id: ${JSON.stringify(accountId)}
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

async function installMockDropboxOperator(client, sessionId) {
  await client.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
        (() => {
          let files = new Map();
          let directories = new Set();
          let versions = new Map();
          let decoder = new TextDecoder();
          let encoder = new TextEncoder();

          function normalize(path) {
            return String(path || "").trim().replace(/\\\\/g, "/").replace(/^\\/+|\\/+$/g, "");
          }

          function parent(path) {
            let normalized = normalize(path);
            let index = normalized.lastIndexOf("/");
            return index == -1 ? "" : normalized.slice(0, index);
          }

          function ensureParents(path) {
            let current = "";
            for (let part of parent(path).split("/").filter(Boolean)) {
              current = current ? current + "/" + part : part;
              directories.add(current);
            }
          }

          function metadata(path, kind) {
            if (kind == "directory") return { kind, path };
            let value = files.get(path);
            return {
              kind,
              path,
              size: encoder.encode(value).byteLength,
              version: String(versions.get(path))
            };
          }

          function entries(prefix = "") {
            let normalizedPrefix = normalize(prefix);
            let result = [];
            let directorySet = new Set(directories);
            for (let path of files.keys()) {
              let current = "";
              for (let part of parent(path).split("/").filter(Boolean)) {
                current = current ? current + "/" + part : part;
                directorySet.add(current);
              }
            }

            for (let path of directorySet) {
              if (normalizedPrefix && path != normalizedPrefix && !path.startsWith(normalizedPrefix + "/")) continue;
              result.push(metadata(path, "directory"));
            }
            for (let path of files.keys()) {
              if (normalizedPrefix && path != normalizedPrefix && !path.startsWith(normalizedPrefix + "/")) continue;
              result.push(metadata(path, "file"));
            }
            return result.sort((left, right) => left.path.localeCompare(right.path));
          }

          window.__localMdMockDropboxFiles = files;
          window.__localMdWorkspaceTestDropboxOperatorFactory = async (source) => ({
            info: {
              capabilities: {
                createDirectory: true,
                delete: { recursive: "native", single: true },
                list: true,
                read: true,
                rename: { directory: "native", file: "native" },
                stat: true,
                write: true,
                writeConditions: {
                  ifMatch: false,
                  ifNotExists: true,
                  ifVersion: true
                }
              },
              root: source.root || "",
              scheme: "dropbox"
            },
            async createDirectory(path) {
              let normalized = normalize(path);
              if (normalized) {
                ensureParents(normalized);
                directories.add(normalized);
              }
            },
            async delete(request) {
              let normalized = normalize(request.path);
              if (files.delete(normalized)) {
                versions.delete(normalized);
                return { status: "applied" };
              }
              for (let key of Array.from(files.keys())) {
                if (key.startsWith(normalized + "/")) {
                  files.delete(key);
                  versions.delete(key);
                }
              }
              for (let key of Array.from(directories)) {
                if (key == normalized || key.startsWith(normalized + "/")) {
                  directories.delete(key);
                }
              }
              return { status: "applied" };
            },
            dispose() {},
            async list(prefix) {
              return entries(prefix);
            },
            async read(path) {
              let normalized = normalize(path);
              if (!files.has(normalized)) throw new Error("not_found");
              return {
                bytes: encoder.encode(files.get(normalized)),
                metadata: metadata(normalized, "file"),
                metadataBinding: "same-read"
              };
            },
            async rename(request) {
              let from = normalize(request.from);
              let target = normalize(request.to);
              if (files.has(from)) {
                let value = files.get(from);
                let version = versions.get(from);
                files.delete(from);
                versions.delete(from);
                ensureParents(target);
                files.set(target, value);
                versions.set(target, version);
                return { status: "applied" };
              }
              if (!directories.has(from)) throw new Error("not_found");
              directories.delete(from);
              directories.add(target);
              for (let key of Array.from(files.keys())) {
                if (!key.startsWith(from + "/")) continue;
                let value = files.get(key);
                let version = versions.get(key);
                files.delete(key);
                versions.delete(key);
                let nextPath = target + key.slice(from.length);
                files.set(nextPath, value);
                versions.set(nextPath, version);
              }
              return { status: "applied" };
            },
            async stat(path) {
              let normalized = normalize(path);
              if (files.has(normalized)) return metadata(normalized, "file");
              if (directories.has(normalized)) return metadata(normalized, "directory");
              throw new Error("not_found");
            },
            async write(request) {
              let normalized = normalize(request.path);
              if (request.condition?.kind == "if-not-exists" && files.has(normalized)) {
                throw new Error("condition_failed");
              }
              if (
                request.condition?.kind == "if-version" &&
                String(versions.get(normalized)) != request.condition.version
              ) {
                throw new Error("condition_failed");
              }
              ensureParents(normalized);
              files.set(normalized, decoder.decode(request.bytes));
              versions.set(normalized, (versions.get(normalized) || 0) + 1);
              return {
                metadata: metadata(normalized, "file"),
                metadataBinding: "write-response",
                status: "applied"
              };
            }
          });
        })();
      `,
    },
    sessionId,
  );
}

async function waitForMockDropboxFileValue(client, sessionId, path, expectedValue) {
  try {
    await client.waitForPredicate(
      `window.__localMdMockDropboxFiles?.get(${JSON.stringify(path)}) == ${JSON.stringify(
        expectedValue,
      )}`,
      sessionId,
      20_000,
    );
  } catch (error) {
    let state = await client.evaluate(
      `
        (() => ({
          body: document.body.innerText,
          files: Array.from(window.__localMdMockDropboxFiles?.entries?.() ?? []),
          value: window.__localMdMockDropboxFiles?.get(${JSON.stringify(path)}) ?? null
        }))()
      `,
      sessionId,
    );
    throw new Error(`${error.message}\n\nMock Dropbox state:\n${JSON.stringify(state, null, 2)}`);
  }
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
    let stderr = "";
    let timer = setTimeout(() => reject(new Error("Timed out waiting for Chromium.")), 10_000);
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_000);
      let match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.on("exit", (code, signal) => {
      reject(
        new Error(
          `Chromium exited before DevTools was ready: code=${code}, signal=${signal}\n${stderr}`,
        ),
      );
    });
  });
}

async function waitForPageDevToolsEndpoint(browserWs) {
  let endpoint = new URL(browserWs);
  endpoint.protocol = "http:";
  endpoint.pathname = "/json/list";
  endpoint.search = "";
  let started = Date.now();
  while (Date.now() - started < 10_000) {
    let targets = await fetch(endpoint).then((response) => response.json());
    let page = targets.find(
      (target) => target.type == "page" && typeof target.webSocketDebuggerUrl == "string",
    );
    if (page) return page.webSocketDebuggerUrl;
    await waitForSettledUi(50);
  }
  throw new Error("Timed out waiting for Chromium's page target.");
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
