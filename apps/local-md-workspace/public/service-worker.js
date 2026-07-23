const CACHE_PREFIX = "grove-local-md-workspace";
const SHELL_CACHE = `${CACHE_PREFIX}-shell-__GROVE_SHELL_CACHE_KEY__`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime`;
const SHARE_TARGET_PATH = "/share";
const SHARED_DRAFT_SEARCH_PARAM = "shared-draft";
const SHARED_DRAFT_ERROR_SEARCH_PARAM = "shared-draft-error";
const DB_NAME = "local-md-workspace";
const DB_VERSION = 1;
const DB_STORE_NAME = "workspace";
const DRAFT_KEY_PREFIX = "single-file-draft:";
const LAST_DRAFT_KEY = "single-file-draft:last";
const COLLABORATION_PRECACHE_URLS = [
  /* __GROVE_COLLABORATION_PRECACHE__ */
];

const APP_SHELL_URLS = [
  "/",
  "/index.html",
  "/site.webmanifest",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  ...COLLABORATION_PRECACHE_URLS,
];

const CACHEABLE_DESTINATIONS = new Set([
  "audio",
  "font",
  "image",
  "manifest",
  "script",
  "style",
  "track",
  "video",
  "worker",
]);
const CACHEABLE_EXTENSION = /\.(?:avif|css|gif|ico|jpe?g|js|json|mjs|png|svg|wasm|webp|woff2?)$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith(CACHE_PREFIX) && key != SHELL_CACHE && key != RUNTIME_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  let request = event.request;
  let url = new URL(request.url);

  if (
    request.method == "POST" &&
    url.origin == self.location.origin &&
    url.pathname == SHARE_TARGET_PATH
  ) {
    event.respondWith(importSharedMarkdownDraft(request));
    return;
  }

  if (request.method != "GET") return;

  if (url.origin != self.location.origin || isRelayOrDebugRequest(url)) return;

  if (isNavigationRequest(request)) {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isCacheableAssetRequest(request, url)) {
    event.respondWith(staleWhileRevalidate(request, event));
  }
});

async function networkFirstNavigation(request) {
  let cache = await caches.open(SHELL_CACHE);

  try {
    let response = await fetch(request);
    if (isCacheableResponse(response)) {
      await cache.put("/index.html", response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    return (await cache.match(request)) ?? (await cache.match("/index.html")) ?? Response.error();
  }
}

async function cacheAppShell() {
  let cache = await caches.open(SHELL_CACHE);
  await cache.addAll(APP_SHELL_URLS);

  let index = await cache.match("/index.html");
  if (!index) return;

  let assetUrls = appShellAssetUrls(await index.text());
  await Promise.all(assetUrls.map((url) => cache.add(url).catch(() => undefined)));
}

async function staleWhileRevalidate(request, event) {
  let cache = await caches.open(RUNTIME_CACHE);
  let cachedResponse = (await cache.match(request)) ?? (await caches.match(request));
  let networkResponse = fetchAndCache(request, cache);

  if (cachedResponse) {
    event.waitUntil(networkResponse.catch(() => undefined));
    return cachedResponse;
  }

  return (await networkResponse.catch(() => undefined)) ?? Response.error();
}

async function fetchAndCache(request, cache) {
  let response = await fetch(request);
  if (isCacheableResponse(response)) {
    await cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

function isNavigationRequest(request) {
  return (
    request.mode == "navigate" ||
    request.destination == "document" ||
    (request.headers.get("Accept") ?? "").includes("text/html")
  );
}

function isCacheableAssetRequest(request, url) {
  if (url.pathname == "/service-worker.js") return false;
  return CACHEABLE_DESTINATIONS.has(request.destination) || isCacheableAssetUrl(url);
}

function appShellAssetUrls(html) {
  let urls = new Set();
  for (let match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
    let url = new URL(match[1], self.location.origin);
    if (url.origin == self.location.origin && isCacheableAssetUrl(url)) {
      urls.add(url.pathname + url.search);
    }
  }
  return Array.from(urls);
}

function isCacheableAssetUrl(url) {
  if (url.pathname == "/service-worker.js") return false;
  return url.pathname.startsWith("/assets/") || CACHEABLE_EXTENSION.test(url.pathname);
}

function isRelayOrDebugRequest(url) {
  return url.pathname.startsWith("/api/") || url.pathname == "/__debug";
}

function isCacheableResponse(response) {
  return response.ok && (response.type == "basic" || response.type == "default");
}

async function importSharedMarkdownDraft(request) {
  let draft;
  try {
    draft = await sharedMarkdownDraftFromRequest(request);
  } catch {
    return redirectToApp({ error: "unsupported" });
  }

  try {
    await saveSingleFileDraft(draft);
    return redirectToApp({ draftId: draft.id });
  } catch {
    return redirectToApp({ error: "failed" });
  }
}

async function sharedMarkdownDraftFromRequest(request) {
  let formData = await request.formData();
  let file = formData.getAll("files").find(isMarkdownFile);

  if (file) {
    let now = Date.now();
    return {
      createdAt: now,
      id: createDraftId(),
      name: markdownFileName(file.name),
      updatedAt: now,
      value: await file.text(),
    };
  }

  let text = stringFormValue(formData.get("text"));
  let url = stringFormValue(formData.get("url"));
  let title = stringFormValue(formData.get("title")) || "Shared.md";
  let value = [text, url].filter(Boolean).join("\n\n");
  if (!value.trim()) throw new Error("No Markdown content was shared.");

  let now = Date.now();
  return {
    createdAt: now,
    id: createDraftId(),
    name: markdownFileName(title),
    updatedAt: now,
    value,
  };
}

function redirectToApp(result) {
  let url = new URL("/", self.location.origin);
  if (result.draftId) url.searchParams.set(SHARED_DRAFT_SEARCH_PARAM, result.draftId);
  if (result.error) url.searchParams.set(SHARED_DRAFT_ERROR_SEARCH_PARAM, result.error);
  return Response.redirect(url.href, 303);
}

function isMarkdownFile(value) {
  if (!isFileLike(value)) return false;
  let name = value.name.toLowerCase();
  let type = String(value.type || "").toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    type == "text/markdown" ||
    type == "text/plain"
  );
}

function isFileLike(value) {
  return (
    value &&
    typeof value == "object" &&
    typeof value.name == "string" &&
    typeof value.text == "function"
  );
}

function markdownFileName(name) {
  let fileName = String(name || "")
    .split(/[\\/]/)
    .at(-1)
    ?.trim();
  fileName ||= "Shared.md";
  if (/\.md$/i.test(fileName) || /\.markdown$/i.test(fileName)) return fileName;
  let withoutExtension = fileName.replace(/\.[^.]*$/, "").trim();
  return `${withoutExtension || "Shared"}.md`;
}

function stringFormValue(value) {
  return typeof value == "string" ? value.trim() : "";
}

function createDraftId() {
  return typeof globalThis.crypto?.randomUUID == "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function saveSingleFileDraft(draft) {
  let db = await openDatabase();
  try {
    let transaction = db.transaction(DB_STORE_NAME, "readwrite");
    let store = transaction.objectStore(DB_STORE_NAME);
    let done = transactionComplete(transaction);
    await Promise.all([
      requestResult(store.put(draft, `${DRAFT_KEY_PREFIX}${draft.id}`)),
      requestResult(store.put(draft.id, LAST_DRAFT_KEY)),
      done,
    ]);
  } finally {
    db.close();
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    let request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      let db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE_NAME)) {
        db.createObjectStore(DB_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked."));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}
