const VERSION = "cheng-v163";
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
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC)));
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
    isCodeAsset ? new Request(event.request, { cache: "no-cache" }) : event.request
  ).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  });

  if (isCodeAsset) {
    event.respondWith(refresh.catch(() => caches.match(event.request)));
    return;
  }

  event.waitUntil(refresh.catch(() => undefined));
  event.respondWith(caches.match(event.request).then((cached) => cached || refresh));
});

