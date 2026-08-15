import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const appDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDirectory = path.join(appDirectory, "dist");
const manifest = JSON.parse(
  await readFile(path.join(distDirectory, ".vite", "manifest.json"), "utf8"),
);
const assetsDirectory = path.join(distDirectory, "assets");
const assetNames = await readdir(assetsDirectory);
const grammarAssets = assetNames.filter(
  (name) => name.startsWith("tree-sitter-") && name.endsWith(".wasm"),
);
const grammarBytes = (
  await Promise.all(grammarAssets.map((name) => stat(path.join(assetsDirectory, name))))
).reduce((total, asset) => total + asset.size, 0);

assert(
  grammarAssets.length <= 10 && grammarBytes <= 7 * 1024 * 1024,
  `The workspace bundle contains ${grammarAssets.length} Tree-sitter grammars (${grammarBytes} bytes); ` +
    "LiveMD must ship only its focused, demand-loaded grammar set.",
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
  !serviceWorker.includes("__GROVE_BUILD_PRECACHE__") &&
    !serviceWorker.includes("__GROVE_SHELL_CACHE_KEY__"),
  "The built service worker still contains an uninjected build placeholder.",
);
const precacheMatch = serviceWorker.match(/const BUILD_PRECACHE_URLS = (\[[\s\S]*?\]);/);
assert(precacheMatch, "The built service worker does not declare build precache URLs.");
const precacheUrlValues = JSON.parse(precacheMatch[1]);
assert(
  Array.isArray(precacheUrlValues) &&
    precacheUrlValues.every((url) => typeof url == "string" && String(url).startsWith("/assets/")),
  "The build precache declaration must contain only same-origin asset URL strings.",
);
const precacheUrls = new Set(precacheUrlValues.map((url) => String(url)));
assert(
  precacheUrls.size == precacheUrlValues.length,
  "The build precache declaration contains duplicate URLs.",
);

for (const value of new Set([...initialUrls, ...collaborationUrls])) {
  const url = String(value);
  assert(precacheUrls.has(url), `The service worker does not precache ${url}.`);
}

const requiredOfflineAssets = [
  [/^web-tree-sitter-.*\.wasm$/, "Tree-sitter runtime"],
  [/^tree-sitter-markdown-(?!inline-).*\.wasm$/, "Markdown parser"],
  [/^tree-sitter-markdown-inline-.*\.wasm$/, "Markdown inline parser"],
];
for (const [pattern, label] of requiredOfflineAssets) {
  const matches = assetNames.filter((name) => pattern.test(name));
  assert(matches.length == 1, `Expected exactly one ${label} asset, found ${matches.length}.`);
  assert(
    precacheUrls.has(`/assets/${matches[0]}`),
    `The ${label} is missing from the offline precache manifest.`,
  );
}

const highlightQueryKeys = Object.keys(manifest).filter((key) =>
  /^highlights-.*\.js$/.test(path.basename(manifest[key].file ?? "")),
);
const highlightQueryUrls = collectManifestUrls(collectStaticManifestClosure(highlightQueryKeys));
for (const name of assetNames.filter((name) => /^highlights-.*\.js$/.test(name))) {
  highlightQueryUrls.add(`/assets/${name}`);
}
for (const value of highlightQueryUrls) {
  const url = String(value);
  assert(precacheUrls.has(url), `The highlight-query closure is missing ${url}.`);
}

const eagerlyCachedCodeFenceGrammars = assetNames
  .filter(
    (name) =>
      name.startsWith("tree-sitter-") &&
      name.endsWith(".wasm") &&
      !/^tree-sitter-markdown(?:-inline)?-/.test(name),
  )
  .map((name) => `/assets/${name}`)
  .filter((url) => precacheUrls.has(url));
assert(
  eagerlyCachedCodeFenceGrammars.length == 0,
  `Demand-loaded code-fence grammars must not be precached: ${eagerlyCachedCodeFenceGrammars.join(", ")}`,
);

for (const value of precacheUrls) {
  const url = String(value);
  await stat(path.join(distDirectory, url.replace(/^\//, "")));
}

const indexHtml = await readFile(path.join(distDirectory, "index.html"), "utf8");
assert(!/loro(?:_wasm)?/i.test(indexHtml), "index.html eagerly references Loro.");

const initialJavaScriptBytes = await totalJavaScriptBytes(initialUrls);
console.log(
  `Production bundle contract passed: ${initialJavaScriptBytes.toLocaleString()} initial JS bytes; ` +
    `${precacheUrls.size} offline assets cached.`,
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
