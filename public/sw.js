// IMPORTANT: bump this on every frontend deploy that includes user-visible
// changes (HTML/CSS/JS edits). Without a bump, installed PWA users keep
// seeing the cached old version forever.
//
// What happens when this changes:
//   1. Browser fetches the new sw.js on next app launch
//   2. New SW installs in background, precaches the latest assets
//   3. activate handler purges any caches not matching CACHE_NAME
//   4. clients.claim() takes over open tabs immediately
//   5. Next navigation (or app reopen) serves the new files
const CACHE_VERSION = 'v25';
const CACHE_NAME    = `san-queue-${CACHE_VERSION}`;

const PRECACHE = [
  '/',
  '/admin',
  '/manifest.json',
  '/js/utils.js',
  '/js/driver/app.js',
  '/js/driver/auth.controller.js',
  '/js/driver/dashboard.controller.js',
  '/js/driver/dispatchAlerts.controller.js',
  '/js/driver/history.controller.js',
  '/js/driver/schedule.controller.js',
  '/js/driver/sos.controller.js',
  '/js/admin/app.js',
  '/js/admin/auth.controller.js',
  '/js/admin/daySchedule.controller.js',
  '/js/admin/drivers.controller.js',
  '/js/admin/logs.controller.js',
  '/js/admin/monitor.controller.js',
  '/js/admin/overview.controller.js',
  '/js/admin/scheduledDrivers.controller.js',
  '/js/admin/sos.controller.js',
  '/js/admin/watchlist.controller.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Web Push: SOS alerts (admin) and dispatch alerts (driver) ───────────────
// Payload shape from the server:
//   { title, body, tag, data: { type: 'dispatch'|'sos.new'|'sos.updated', url, ... } }
// Type-specific handling (vibrate pattern, requireInteraction) lets each
// notification feel right for its urgency — SOS demands attention until
// dismissed; a dispatch notification just needs to land and stay readable.
self.addEventListener('push', (event) => {
  let payload = { title: 'SAN Queue', body: 'New event', data: {} };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; }
  catch { /* non-JSON payload — keep defaults */ }

  const isDispatch = payload.data?.type === 'dispatch';

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body:      payload.body,
      tag:       payload.tag || (isDispatch ? 'dispatch' : 'sos'),
      icon:      '/icons/icon-192.png',
      badge:     '/icons/icon-192.png',
      data:      payload.data || {},
      // SOS = stays until clicked (admin must see it).
      // Dispatch = OS controls when it's dismissed — driver may already be moving.
      requireInteraction: !isDispatch,
      vibrate:   isDispatch ? [120, 60, 120] : [200, 100, 200, 100, 200],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url  = data.url || (data.type === 'dispatch' ? '/' : '/admin');
  const focusToken = data.type === 'dispatch' ? '/' : '/admin';

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Focus an existing tab on the matching surface if there is one.
    // /admin match must be exact-ish to avoid matching the driver root '/'.
    for (const c of all) {
      const path = new URL(c.url).pathname;
      if (focusToken === '/admin' ? path.startsWith('/admin') : !path.startsWith('/admin')) {
        c.focus();
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

// ─── Background Sync: flush queued SOS alerts when network returns ───────────
// Driver SOS controller falls back to localStorage + this sync tag when the
// network is down at the moment of fire. There's no API access from the SW,
// so we just wake a client tab to do the actual POST.
self.addEventListener('sync', (event) => {
  if (event.tag !== 'sos-flush') return;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window' });
    for (const c of all) c.postMessage({ type: 'sos-flush' });
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache: API calls, SSE streams, or cross-origin requests
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/events') ||
    url.origin !== self.location.origin
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // Cache-first for static assets; fall back to network
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        return response;
      });
    })
  );
});
