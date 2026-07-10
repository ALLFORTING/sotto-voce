const VERSION = "cheng-v164";
const CACHE_PREFIX = "cheng-static-";
const CACHE = `${CACHE_PREFIX}${VERSION}`;
const CODE_ASSET_RE = /\.(?:js|css|html|json)$/;
const STATIC = [
  "/",
  "/index.html",
  `/manifest.json?v=${VERSION}`,
  `/css/tokens.css?v=${VERSION}`,
  `/css/phone.css?v=${VERSION}`,
  `/css/chat.css?v=${VERSION}`,
  `/css/overlays.css?v=${VERSION}`,
  `/css/journal.css?v=${VERSION}`,
  `/css/memory.css?v=${VERSION}`,
  `/css/settings.css?v=${VERSION}`,
  `/js/router.js?v=${VERSION}`,
  `/js/api.js?v=${VERSION}`,
  `/js/store.js?v=${VERSION}`,
  `/js/components.js?v=${VERSION}`,
  `/js/home.js?v=${VERSION}`,
  `/js/chat.js?v=${VERSION}`,
  `/js/journal.js?v=${VERSION}`,
  `/js/memory.js?v=${VERSION}`,
  `/js/settings.js?v=${VERSION}`,
  `/fonts/CormorantGaramond-Regular.ttf?v=${VERSION}`,
  "/js/router.js",
  "/js/api.js",
  "/js/store.js",
  "/js/components.js",
  "/js/home.js",
  "/js/chat.js",
  "/js/journal.js",
  "/js/memory.js",
  "/js/settings.js",
  "/fonts/CormorantGaramond-Regular.ttf",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

async function cacheStaticAssets() {
  const cache = await caches.open(CACHE);
  await Promise.all(
    STATIC.map(async (url) => {
      try {
        const response = await fetch(new Request(url, { cache: "reload" }));
        if (response.ok) await cache.put(url, response);
      } catch (_) {
        // Best-effort precache: one missing or slow asset must not abort SW install.
      }
    })
  );
}

async function matchCached(request, url) {
  const cached = await caches.match(request);
  if (cached || url.search) return cached;
  return caches.match(`${url.pathname}?v=${VERSION}`);
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheStaticAssets());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || event.request.method !== "GET") return;
  if (url.pathname.startsWith("/uploads/")) return;

  const isCodeAsset = url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname === "/manifest.json" ||
    CODE_ASSET_RE.test(url.pathname);

  const refresh = fetch(
    isCodeAsset ? new Request(event.request, { cache: "reload" }) : event.request
  ).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  });

  event.waitUntil(refresh.catch(() => undefined));
  event.respondWith(matchCached(event.request, url).then((cached) => cached || refresh));
});

