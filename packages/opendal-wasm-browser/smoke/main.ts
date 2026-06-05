import {
  createOpendalBrowserOperator,
  defaultGeneratedModuleUrl,
  type OpendalBrowserOperatorConfig,
} from "../src/index.js";

let output = document.querySelector("#output");

let config = readSmokeConfig();
if (output) {
  output.textContent = config
    ? "Smoke config found. Click the document body to run list()."
    : "Set OPENDAL_BROWSER_SMOKE_CONFIG in localStorage before running.";
}

document.body.addEventListener("click", () => {
  void runSmoke();
});

async function runSmoke() {
  if (!output || !config) return;
  output.textContent = "Loading WASM...";

  try {
    let operator = await createOpendalBrowserOperator(config, {
      generatedModuleUrl: defaultGeneratedModuleUrl(),
    });
    output.textContent = JSON.stringify(
      {
        capabilities: operator.capabilities(),
        entries: await operator.list(config.root ?? ""),
      },
      null,
      2,
    );
  } catch (error) {
    output.textContent = error instanceof Error ? error.message : String(error);
  }
}

function readSmokeConfig() {
  let raw = window.localStorage.getItem("OPENDAL_BROWSER_SMOKE_CONFIG");
  if (!raw) return null;
  return JSON.parse(raw) as OpendalBrowserOperatorConfig;
}
