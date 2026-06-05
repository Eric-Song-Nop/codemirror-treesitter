import { existsSync } from "node:fs";

let accessToken = process.env.OPENDAL_DROPBOX_ACCESS_TOKEN;

if (!accessToken) {
  console.log("Skipping Dropbox smoke: OPENDAL_DROPBOX_ACCESS_TOKEN is not set.");
  process.exit(0);
}

let generatedModuleUrl = new URL("../pkg/opendal_wasm_browser.js", import.meta.url);
let wasmModuleUrl = new URL("../pkg/opendal_wasm_browser_bg.wasm", import.meta.url);

if (!existsSync(generatedModuleUrl) || !existsSync(wasmModuleUrl)) {
  throw new Error(
    "Build the WASM package first with `vp run @codemirror-treesitter/opendal-wasm-browser#build:wasm`.",
  );
}

let generated = await import(generatedModuleUrl.href);
await generated.default(wasmModuleUrl);

let root = process.env.OPENDAL_DROPBOX_ROOT?.trim() || undefined;
let prefix = process.env.OPENDAL_DROPBOX_SMOKE_PREFIX?.trim() || "opendal-browser-smoke";
let suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let firstPath = `${prefix}-${suffix}.md`;
let renamedPath = `${prefix}-${suffix}-renamed.md`;
let value = "# OpenDAL Dropbox smoke\n";
let operator = new generated.OpendalBrowserOperator({
  accessToken,
  provider: "dropbox",
  root,
});

try {
  let initialEntries = await operator.list("");
  await operator.writeText(firstPath, value);
  let readValue = await operator.readText(firstPath);
  if (readValue !== value) {
    throw new Error("Dropbox smoke readText did not return the written content.");
  }

  await operator.rename(firstPath, renamedPath);
  let renamedStat = await operator.stat(renamedPath);
  let renamedEntries = await operator.list("");
  await operator.delete(renamedPath);

  console.log(
    JSON.stringify(
      {
        initialEntryCount: initialEntries.length,
        readMatchesWrite: true,
        renamedEntryFound: renamedEntries.some((entry) => entry.path == renamedPath),
        renamedStat,
        root: root ?? "",
      },
      null,
      2,
    ),
  );
} catch (error) {
  await operator.delete(firstPath).catch(() => {});
  await operator.delete(renamedPath).catch(() => {});
  throw error;
}
