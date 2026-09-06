/* Sultrix PWA v2.2.11 — Service Worker
 *
 * Caching strategy:
 *   - app shell  : stale-while-revalidate
 *   - /api/pwa/*  : network-first with safe cached fallback (never stale-live)
 *   - /api/notify : network-only (mutates server state)
 *   - charts / tv : stale-while-revalidate
 *   - icons / statics: cache-first
 */
const VERSION = 'sultrix-pwa-v2.2.11';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(APP_SHELL))
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

async function networkFirst(req, cacheName) {
  const cache = await caches.open(VERSION);
  try {
    const fresh = await fetch(req);
    // Only cache successful + JSON-shaped GETs.
    if (fresh && fresh.status === 200) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline', cached: false }),
      { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then((fresh) => {
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
