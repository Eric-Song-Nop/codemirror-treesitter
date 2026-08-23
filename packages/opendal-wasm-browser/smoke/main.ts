import {
  defaultOpendalBrowserRuntimeOptions,
  openOpendalBrowserOperator,
  type OpendalBrowserSource,
} from "../src/index.js";

type CloudSource = Exclude<OpendalBrowserSource, { kind: "browser-local" }>;

let output = document.querySelector("#output");

let config = readSmokeConfig();
if (output) {
  output.textContent = config
    ? "Smoke config found. Click the document body to run the full operation smoke."
    : "Set OPENDAL_BROWSER_SMOKE_CONFIG in localStorage before running.";
}

document.body.addEventListener("click", () => {
  void runSmoke();
});

async function runSmoke() {
  if (!output || !config) return;
  output.textContent = "Loading WASM...";

  let operator: Awaited<ReturnType<typeof openOpendalBrowserOperator>> | null = null;
  let cleanupPaths: string[] = [];

  try {
    operator = await openOpendalBrowserOperator(config, defaultOpendalBrowserRuntimeOptions());
    let firstPath = `opendal-browser-smoke-${Date.now()}.md`;
    let renamedPath = firstPath.replace(/\.md$/, "-renamed.md");
    let value = "# OpenDAL browser smoke\n";
    cleanupPaths = [firstPath, renamedPath];

    let initialEntries = await operator.list("");
    await operator.write({ bytes: new TextEncoder().encode(value), path: firstPath });
    let readValue = new TextDecoder().decode((await operator.read(firstPath)).bytes);
    await operator.rename({ from: firstPath, kind: "file", to: renamedPath });
    let renamedStat = await operator.stat(renamedPath);
    let renamedEntries = await operator.list("");
    await operator.delete({ path: renamedPath, recursive: false });
    cleanupPaths = [];

    output.textContent = JSON.stringify(
      {
        capabilities: operator.info.capabilities,
        initialEntryCount: initialEntries.length,
        readMatchesWrite: readValue == value,
        renamedEntryFound: renamedEntries.some((entry) => entry.path == renamedPath),
        renamedStat,
      },
      null,
      2,
    );
  } catch (error) {
    if (operator) {
      for (let path of cleanupPaths) {
        await operator.delete({ path, recursive: false }).catch(() => {});
      }
    }
    output.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    operator?.dispose();
  }
}

function readSmokeConfig() {
  let raw = window.localStorage.getItem("OPENDAL_BROWSER_SMOKE_CONFIG");
  if (!raw) return null;
  return JSON.parse(raw) as CloudSource;
}
