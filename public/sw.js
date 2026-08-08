// PDFshelf Service Worker
// Change this version whenever you want to force old caches to be removed.
const CACHE_VERSION = "pdfshelf-v3";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

// Only cache basic app-shell files here.
// CSS/JS will still prefer the latest network version.
const APP_SHELL = [
  "/",
  "/index.html",
  "/library.html",
  "/reader.html",
  "/admin.html",
  "/manifest.json"
];

// --------------------------------------------------
// INSTALL
// --------------------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => {
        return cache.addAll(APP_SHELL);
      })
      .catch((error) => {
        console.warn("Service worker install cache error:", error);
      })
  );

  // Activate the new service worker immediately
  self.skipWaiting();
});

// --------------------------------------------------
// ACTIVATE
// --------------------------------------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            // Delete every old PDFshelf cache
            if (
              cacheName.startsWith("pdfshelf-") &&
              cacheName !== STATIC_CACHE
            ) {
              console.log("Deleting old cache:", cacheName);
              return caches.delete(cacheName);
            }

            return Promise.resolve();
          })
        );
      })
      .then(() => {
        // Take control of already-open pages
        return self.clients.claim();
      })
  );
});

// --------------------------------------------------
// FETCH
// --------------------------------------------------
self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only handle GET requests
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // ------------------------------------------------
  // Never cache API requests
  // ------------------------------------------------
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // ------------------------------------------------
  // Never cache PDF/document responses
  // ------------------------------------------------
  if (
    url.pathname.includes("/pdf") ||
    url.pathname.endsWith(".pdf")
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // ------------------------------------------------
  // CSS and JavaScript:
  // NETWORK FIRST
  //
  // This is important for app.css changes.
  // ------------------------------------------------
  if (
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js")
  ) {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((networkResponse) => {
          // Save a copy only if request succeeded
          if (networkResponse && networkResponse.ok) {
            const responseClone = networkResponse.clone();

            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }

          return networkResponse;
        })
        .catch(async () => {
          // Offline fallback
          const cachedResponse = await caches.match(request);

          if (cachedResponse) {
            return cachedResponse;
          }

          return new Response("Offline", {
            status: 503,
            statusText: "Offline"
          });
        })
    );

    return;
  }

  // ------------------------------------------------
  // HTML navigation:
  // NETWORK FIRST
  // ------------------------------------------------
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const responseClone = networkResponse.clone();

            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }

          return networkResponse;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);

          if (cachedResponse) {
            return cachedResponse;
          }

          return caches.match("/index.html");
        })
    );

    return;
  }

  // ------------------------------------------------
  // Other static files:
  // CACHE FIRST
  // Images, icons, fonts etc.
  // ------------------------------------------------
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request).then((networkResponse) => {
        if (
          !networkResponse ||
          !networkResponse.ok ||
          networkResponse.type === "opaque"
        ) {
          return networkResponse;
        }

        const responseClone = networkResponse.clone();

        caches.open(STATIC_CACHE).then((cache) => {
          cache.put(request, responseClone);
        });

        return networkResponse;
      });
    })
  );
});

// --------------------------------------------------
// OPTIONAL: Allow page to force new SW activation
// --------------------------------------------------
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});