const VERSION = "20260627-b2";
const CACHE_PREFIX = "cheng-static-";
const CACHE = `${CACHE_PREFIX}${VERSION}`;
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

  const refresh = fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  });

  event.waitUntil(refresh.catch(() => undefined));
  event.respondWith(caches.match(event.request).then((cached) => cached || refresh));
});

