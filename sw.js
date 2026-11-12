/* Sultrix PWA v2.2.38 — Service Worker
 *
 * Caching strategy:
 *   - app shell  : stale-while-revalidate
 *   - /api/pwa/*  : network-first with safe cached fallback (never stale-live)
 *   - /api/notify : network-only (mutates server state)
 *   - charts / tv : stale-while-revalidate
 *   - icons / statics: cache-first
 */
const VERSION = 'sultrix-pwa-v2.2.54c';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/index.html',
  '/conn_helpers.js',
  '/app.js',
  '/styles.css',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/mark-96.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // Each file is fetched past the browser's HTTP cache (GitHub Pages sends max-age=600): a user who opened the app within ten minutes before a
    // release must not get the OLD files stored under the NEW version name. Any failure rejects, as addAll did, so a half-installed worker never takes over.
    caches.open(VERSION).then((cache) => Promise.all(APP_SHELL.map((u) =>
      fetch(new Request(u, { cache: 'reload' })).then((r) => {
        if (!r.ok) throw new Error('precache ' + u + ' ' + r.status);
        return cache.put(u, r);
      })
    )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept mutating endpoints — they must hit the network.
  if (req.method !== 'GET') return;

  // The app's own update check (manifest.json?v=<time>) and the worker script must always come from the network: a cached copy would hide a new release.
  if (url.pathname === '/sw.js' || (url.pathname === '/manifest.json' && url.searchParams.has('v'))) return;

  // PWA API: network-first, cached only for offline safe-view.
  if (url.pathname.startsWith('/api/pwa/')) {
    event.respondWith(networkFirst(req, 'pwa-api'));
    return;
  }

  // External chart providers — stale-while-revalidate.
  if (url.hostname.includes('tradingview.com') ||
      url.hostname.includes('s3.tradingview.com')) {
    event.respondWith(staleWhileRevalidate(req, 'tv-cache'));
    return;
  }

  // App shell + same-origin statics — stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, 'app-shell'));
    return;
  }
});

function fetchWithTimeout(req, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const opts = req.signal ? { signal: req.signal } : { signal: controller.signal };
  return fetch(req, opts).finally(() => clearTimeout(timer));
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(VERSION);
  try {
    const fresh = await fetchWithTimeout(req, 8000);
    // Only cache successful + JSON-shaped GETs.
    if (fresh && fresh.status === 200) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    // Only serve cached fallback when the device itself is offline; if online and a cross-origin
    // trycloudflare tunnel failed, return 503 so app.js detects the tunnel change and queries the relay.
    const isCrossOrigin = new URL(req.url).origin !== self.location.origin;
    if (!isCrossOrigin) {
      const cached = await cache.match(req);
      if (cached) return cached;
    }
    return new Response(JSON.stringify({ error: 'offline', cached: false }),
      { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  const networkPromise = fetchWithTimeout(new Request(req, { cache: 'no-cache' }), 10000).then((fresh) => {          // revalidate with the server (a cheap 304), never from the HTTP cache
    if (fresh && fresh.status === 200) cache.put(req, fresh.clone());
    return fresh;
  }).catch(() => null);
  return cached || (await networkPromise) ||
    new Response('', { status: 504 });
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch (_) { data = { title: 'Sultrix', body: event.data.text() }; }
  const title = data.title || 'Sultrix';
  const options = {
    body: data.body || '',
    icon: data.icon || '/assets/icons/icon-192.png',
    badge: '/assets/icons/icon-192.png',
    tag: data.tag || 'sultrix',
    data: { url: data.url || '/' },
    requireInteraction: data.severity === 'CRITICAL',
    vibrate: data.severity === 'CRITICAL' ? [200, 100, 200, 100, 200] : [100],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const c of clientList) {
          if (c.url.endsWith(targetUrl) && 'focus' in c) return c.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      })
  );
});

// A logout must leave no private data on the phone: the page asks the worker to drop every cache.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'logout') {
    event.waitUntil(
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            return caches.delete(cacheName);
          })
        );
      })
    );
  }
});
