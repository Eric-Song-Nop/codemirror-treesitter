import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

let accessToken = process.env.OPENDAL_DROPBOX_ACCESS_TOKEN;

if (!accessToken) {
  console.log("Skipping Dropbox smoke: OPENDAL_DROPBOX_ACCESS_TOKEN is not set.");
  process.exit(0);
}

let generatedModuleUrl = new URL("../pkg/opendal_wasm_browser.js", import.meta.url);
let wasmModuleUrl = new URL("../pkg/opendal_wasm_browser_bg.wasm", import.meta.url);
let wrapperModuleUrl = new URL("../dist/index.mjs", import.meta.url);

if (
  !existsSync(generatedModuleUrl) ||
  !existsSync(wasmModuleUrl) ||
  !existsSync(wrapperModuleUrl)
) {
  throw new Error(
    "Build the package first with `vp run @codemirror-treesitter/opendal-wasm-browser#build`.",
  );
}

let { openOpendalBrowserOperator } = await import(wrapperModuleUrl.href);
let wasmModule = await WebAssembly.compile(await readFile(wasmModuleUrl));

let root = process.env.OPENDAL_DROPBOX_ROOT?.trim() || undefined;
let prefix = process.env.OPENDAL_DROPBOX_SMOKE_PREFIX?.trim() || "opendal-browser-smoke";
let suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let firstPath = `${prefix}-${suffix}.md`;
let renamedPath = `${prefix}-${suffix}-renamed.md`;
let value = "# OpenDAL Dropbox smoke\n";
let operator = await openOpendalBrowserOperator(
  {
    accessToken,
    kind: "dropbox",
    root,
  },
  { generatedModuleUrl: generatedModuleUrl.href, wasmModuleUrl: wasmModule },
);

try {
  let initialEntries = await operator.list("");
  await operator.write({ bytes: new TextEncoder().encode(value), path: firstPath });
  let readValue = new TextDecoder().decode((await operator.read(firstPath)).bytes);
  if (readValue !== value) {
    throw new Error("Dropbox smoke read did not return the written content.");
  }

  let renameResult = await operator.rename({
    from: firstPath,
    kind: "file",
    to: renamedPath,
  });
  if (renameResult.status != "applied") {
    throw new Error(`Dropbox smoke rename ended with ${renameResult.status}.`);
  }
  let renamedStat = await operator.stat(renamedPath);
  let renamedEntries = await operator.list("");
  await operator.delete({ path: renamedPath, recursive: false });

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
  await operator.delete({ path: firstPath, recursive: false }).catch(() => {});
  await operator.delete({ path: renamedPath, recursive: false }).catch(() => {});
  throw error;
} finally {
  operator.dispose();
}
