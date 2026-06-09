const CACHE_PREFIX = "grove-local-md-workspace";
const SHELL_CACHE = `${CACHE_PREFIX}-shell-2026-06-09`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime`;

const APP_SHELL_URLS = [
  "/",
  "/index.html",
  "/site.webmanifest",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
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
  if (request.method != "GET") return;

  let url = new URL(request.url);
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
