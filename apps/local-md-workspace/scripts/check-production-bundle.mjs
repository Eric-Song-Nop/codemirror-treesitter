import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const appDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDirectory = path.join(appDirectory, "dist");
const manifest = JSON.parse(
  await readFile(path.join(distDirectory, ".vite", "manifest.json"), "utf8"),
);

const collaborationRoots = [
  "src/components/SharedFileEditor.tsx",
  "src/lib/collaboration/markdown-document-runtime.ts",
  "src/lib/collaboration/share-relay-connection.ts",
];

const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
assert(entryKey, "The production manifest does not contain an application entry.");

const initialKeys = collectStaticManifestClosure([entryKey]);
const initialUrls = collectManifestUrls(initialKeys);
assert(
  !Array.from(initialUrls).some(isLoroWasmUrl),
  "The launcher's static bundle still contains the Loro WASM runtime.",
);

const collaborationRootKeys = collaborationRoots.map((root) => {
  const chunkName = path.basename(root, path.extname(root));
  const key = Object.keys(manifest).find(
    (candidate) =>
      candidate == root || manifest[candidate].src == root || manifest[candidate].name == chunkName,
  );
  assert(key, `The production manifest is missing the lazy collaboration root ${root}.`);
  return key;
});
const collaborationKeys = collectStaticManifestClosure(collaborationRootKeys);
const collaborationUrls = collectManifestUrls(collaborationKeys, initialKeys);
const loroWasmUrls = Array.from(collaborationUrls).filter(isLoroWasmUrl);

assert(
  loroWasmUrls.length == 1,
  `Expected exactly one Loro WASM asset in the collaboration closure, found ${loroWasmUrls.length}.`,
);

const serviceWorker = await readFile(path.join(distDirectory, "service-worker.js"), "utf8");
assert(
  !serviceWorker.includes("__GROVE_COLLABORATION_PRECACHE__") &&
    !serviceWorker.includes("__GROVE_SHELL_CACHE_KEY__"),
  "The built service worker still contains an uninjected build placeholder.",
);
const precacheMatch = serviceWorker.match(/const COLLABORATION_PRECACHE_URLS = (\[[\s\S]*?\]);/);
assert(precacheMatch, "The built service worker does not declare collaboration precache URLs.");
const precacheUrlValues = JSON.parse(precacheMatch[1]);
assert(
  Array.isArray(precacheUrlValues) && precacheUrlValues.every((url) => typeof url == "string"),
  "The collaboration precache declaration must contain only URL strings.",
);
const precacheUrls = new Set(precacheUrlValues.map((url) => String(url)));

for (const value of collaborationUrls) {
  const url = String(value);
  assert(precacheUrls.has(url), `The service worker does not precache ${url}.`);
}
for (const value of precacheUrls) {
  const url = String(value);
  assert(
    !/\/tree-sitter[^/]*\.wasm(?:\?|$)/.test(url),
    `The collaboration precache unexpectedly contains Tree-sitter grammar ${url}.`,
  );
  await stat(path.join(distDirectory, url.replace(/^\//, "")));
}

const indexHtml = await readFile(path.join(distDirectory, "index.html"), "utf8");
assert(!/loro(?:_wasm)?/i.test(indexHtml), "index.html eagerly references Loro.");

const initialJavaScriptBytes = await totalJavaScriptBytes(initialUrls);
console.log(
  `Production bundle contract passed: ${initialJavaScriptBytes.toLocaleString()} initial JS bytes; ` +
    `${precacheUrls.size} collaboration assets cached.`,
);

function collectStaticManifestClosure(seedKeys) {
  const closure = new Set();
  const pending = [...seedKeys];

  while (pending.length) {
    const key = pending.pop();
    if (!key || closure.has(key)) continue;
    const entry = manifest[key];
    assert(entry, `Manifest dependency ${key} is missing.`);
    closure.add(key);
    pending.push(...(entry.imports ?? []));
  }

  return closure;
}

function collectManifestUrls(keys, excludedKeys = new Set()) {
  const urls = new Set();
  for (const key of keys) {
    if (excludedKeys.has(key)) continue;
    const entry = manifest[key];
    for (const file of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) {
      if (file) urls.add(`/${file}`);
    }
  }
  return urls;
}

function isLoroWasmUrl(url) {
  return /\/loro_wasm_bg-[^/]+\.wasm$/.test(url);
}

async function totalJavaScriptBytes(urls) {
  let total = 0;
  for (const url of urls) {
    if (!url.endsWith(".js")) continue;
    total += (await stat(path.join(distDirectory, url.replace(/^\//, "")))).size;
  }
  return total;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
