importScripts(
  "https://storage.googleapis.com/workbox-cdn/releases/6.2.0/workbox-sw.js"
);

workbox.setConfig({ debug: true });

const {
  routing: { registerRoute, setCatchHandler },
  strategies: { CacheFirst, NetworkFirst, StaleWhileRevalidate },
  cacheableResponse: { CacheableResponse, CacheableResponsePlugin },
  expiration: { ExpirationPlugin, CacheExpiration },
  precaching: { matchPrecache, precacheAndRoute },
} = workbox;

precacheAndRoute([{ url: "/offline.html", revision: null }]);

// Cache page navigations (html) with a Network First strategy
registerRoute(
  ({ request }) => request.mode === "navigate",
  new NetworkFirst({
    cacheName: "pages",
    plugins: [
      new CacheableResponsePlugin({
        statuses: [200],
      }),
    ],
  })
);

// Cache Google Fonts
registerRoute(
  ({ url }) =>
    url.origin === "https://fonts.googleapis.com" ||
    url.origin === "https://fonts.gstatic.com",
  new StaleWhileRevalidate({
    cacheName: "pwa-google-fonts",
    plugins: [new ExpirationPlugin({ maxEntries: 20 })],
  })
);

// Cache Images
registerRoute(
  ({ request }) => request.destination === "image",
  new CacheFirst({
    cacheName: "pwa-images",
    plugins: [
      new CacheableResponsePlugin({
        statuses: [0, 200],
      }),
      new ExpirationPlugin({
        maxEntries: 60,
        maxAgeSeconds: 30 * 24 * 60 * 60, // 30 Days
      }),
    ],
  })
);

// Cache CSS, JS, Manifest, and Web Worker
registerRoute(
  ({ request }) =>
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "manifest" ||
    request.destination === "worker",
  new StaleWhileRevalidate({
    cacheName: "pwa-static-assets",
    plugins: [
      new CacheableResponsePlugin({
        statuses: [0, 200],
      }),
      new ExpirationPlugin({
        maxEntries: 32,
        maxAgeSeconds: 24 * 60 * 60, // 24 hours
      }),
    ],
  })
);

// Catch routing errors, like if the user is offline
setCatchHandler(async ({ event }) => {
  // Return the precached offline page if a document is being requested
  if (event.request.destination === "document") {
    return matchPrecache("/offline.html");
  }

  return Response.error();
});

const HOSTNAME_WHITELIST = [
  self.location.hostname,
  "fonts.gstatic.com",
  "fonts.googleapis.com",
  "cdn.jsdelivr.net",
];

// The Util Function to hack URLs of intercepted requests
const getFixedUrl = (req) => {
  var now = Date.now();
  var url = new URL(req.url);

  // 1. fixed http URL
  // Just keep syncing with location.protocol
  // fetch(httpURL) belongs to active mixed content.
  // And fetch(httpRequest) is not supported yet.
  url.protocol = self.location.protocol;

  // 2. add query for caching-busting.
  // Github Pages served with Cache-Control: max-age=600
  // max-age on mutable content is error-prone, with SW life of bugs can even extend.
  // Until cache mode of Fetch API landed, we have to workaround cache-busting with query string.
  // Cache-Control-Bug: https://bugs.chromium.org/p/chromium/issues/detail?id=453190
  if (url.hostname === self.location.hostname) {
    url.search += (url.search ? "&" : "?") + "cache-bust=" + now;
  }
  return url.href;
};

/**
 *  @Lifecycle Activate
 *  New one activated when old isnt being used.
 *
 *  waitUntil(): activating ====> activated
 */
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 *  @Functional Fetch
 *  All network requests are being intercepted here.
 *
 *  void respondWith(Promise<Response> r)
 */
self.addEventListener("fetch", (event) => {
  // Skip some of cross-origin requests, like those for Google Analytics.
  if (HOSTNAME_WHITELIST.indexOf(new URL(event.request.url).hostname) > -1) {
    // Stale-while-revalidate
    // similar to HTTP's stale-while-revalidate: https://www.mnot.net/blog/2007/12/12/stale
    // Upgrade from Jake's to Surma's: https://gist.github.com/surma/eb441223daaedf880801ad80006389f1
    const cached = caches.match(event.request);
    const fixedUrl = getFixedUrl(event.request);
    const fetched = fetch(fixedUrl, { cache: "no-store" });
    const fetchedCopy = fetched.then((resp) => resp.clone());

    // Call respondWith() with whatever we get first.
    // If the fetch fails (e.g disconnected), wait for the cache.
    // If there’s nothing in cache, wait for the fetch.
    // If neither yields a response, return offline pages.
    event.respondWith(
      Promise.race([fetched.catch((_) => cached), cached])
        .then((resp) => resp || fetched)
        .catch((_) => {
          /* eat any errors */
        })
    );

    // Update the cache with the version we fetched (only for ok status)
    event.waitUntil(
      Promise.all([
        fetchedCopy,
        caches.open("snowballtools-pwa-template-cache"),
      ])
        .then(
          ([response, cache]) =>
            response.ok && cache.put(event.request, response)
        )
        .catch((_) => {
          /* eat any errors */
        })
    );
  }
});
