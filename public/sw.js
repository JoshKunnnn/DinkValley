/**
 * Dink Valley Service Worker
 * Provides offline support, app shell caching, and PWA capabilities.
 */

const CACHE_NAME = "dv-pwa-v2";

const PRECACHE_ASSETS = [
  "/",
  "/offline.html",
  "/manifest.webmanifest",
  "/manifest.json",
  "/favicon.png",
  "/DinkValley.jpg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/facility-court-main.jpg",
  "/facility-overview.jpg"
];

// Install Event: pre-cache the critical app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate Event: cleanup outdated caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((name) => {
            if (name.startsWith("dv-pwa-") && name !== CACHE_NAME) {
              return caches.delete(name);
            }
            return null;
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch Event: handle navigation and static asset requests
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== "GET") {
    return;
  }

  // Bypass non-http(s) schemes like chrome-extension://
  if (!url.protocol.startsWith("http")) {
    return;
  }

  // Bypass external API calls, Supabase endpoints, and live SSE/web-sockets
  if (
    url.hostname.includes("supabase.co") ||
    url.pathname.startsWith("/api/") ||
    request.headers.get("accept")?.includes("text/event-stream")
  ) {
    return;
  }

  // 1. Navigation requests (HTML pages)
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            return cachedResponse;
          }
          const offlineFallback = await caches.match("/offline.html");
          return (
            offlineFallback ||
            new Response("Dink Valley is offline.", {
              headers: { "Content-Type": "text/plain" }
            })
          );
        })
    );
    return;
  }

  // 2. Static Assets: Fonts, Images, Icons, CSS/JS Bundles
  const isStaticAsset =
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/icons/") ||
      url.pathname.endsWith(".png") ||
      url.pathname.endsWith(".jpg") ||
      url.pathname.endsWith(".jpeg") ||
      url.pathname.endsWith(".svg") ||
      url.pathname.endsWith(".webp") ||
      url.pathname.endsWith(".woff2") ||
      url.pathname.endsWith(".woff") ||
      url.pathname.endsWith(".css") ||
      url.pathname.endsWith(".js"));

  const isGoogleFont =
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com";

  if (isStaticAsset || isGoogleFont) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        const fetchPromise = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, clone);
              });
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);

        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // 3. Default: Network first with cache fallback
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, clone);
          });
        }
        return networkResponse;
      })
      .catch(() => caches.match(request))
  );
});

// Listen for message to skip waiting
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
