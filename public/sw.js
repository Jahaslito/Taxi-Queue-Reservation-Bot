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
const CACHE_VERSION = 'v33';
const CACHE_NAME    = `san-queue-${CACHE_VERSION}`;

// On localhost the service worker only gets in the way: cache-first serving of
// stale assets is what forces a hard refresh after every edit. When running in
// dev we tear the SW down (purge caches + unregister + reload open tabs) and
// never intercept fetches, so a normal save shows up immediately. Production
// (any non-localhost host) keeps the full offline-capable behaviour below.
const DEV = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';

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
  '/js/driver/messages.controller.js',
  '/js/admin/app.js',
  '/js/admin/auth.controller.js',
  '/js/admin/daySchedule.controller.js',
  '/js/admin/drivers.controller.js',
  '/js/admin/logs.controller.js',
  '/js/admin/monitor.controller.js',
  '/js/admin/overview.controller.js',
  '/js/admin/scheduledDrivers.controller.js',
  '/js/admin/sos.controller.js',
  '/js/admin/messages.controller.js',
  '/js/admin/watchlist.controller.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  if (DEV) { self.skipWaiting(); return; }
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  if (DEV) {
    // Dev kill-switch: remove ourselves so the page is served straight from the
    // network from now on, then reload any open tabs to drop the stale assets.
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(c => c.navigate(c.url));
    })());
    return;
  }
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Web Push: SOS alerts (admin), dispatch + admin messages (driver) ────────
// Payload shape from the server:
//   { title, body, tag, data: { type: 'dispatch'|'admin_message'|'sos.new'|'sos.updated', url, ... } }
// Type-specific handling (vibrate pattern, requireInteraction) lets each
// notification feel right for its urgency — SOS demands attention until
// dismissed; an admin message should stay readable until acknowledged; a
// dispatch notification just needs to land (driver may already be moving).
self.addEventListener('push', (event) => {
  let payload = { title: 'SAN Queue', body: 'New event', data: {} };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; }
  catch { /* non-JSON payload — keep defaults */ }

  const type       = payload.data?.type;
  const isDispatch = type === 'dispatch';
  const isAdminMsg = type === 'admin_message';

  event.waitUntil((async () => {
    await self.registration.showNotification(payload.title, {
      body:      payload.body,
      tag:       payload.tag || (isDispatch ? 'dispatch' : isAdminMsg ? 'admin-msg' : 'sos'),
      icon:      '/icons/icon-192.png',
      badge:     '/icons/icon-192.png',
      data:      payload.data || {},
      // SOS + admin messages stay until clicked; dispatch can auto-dismiss.
      requireInteraction: !isDispatch,
      vibrate:   isDispatch ? [120, 60, 120] : [200, 100, 200, 100, 200],
    });

    // Live in-app update: if a driver tab is open, tell it to refresh its bell
    // badge + show the banner immediately (don't wait for the next poll).
    if (isAdminMsg) {
      const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clientsArr) {
        c.postMessage({ type: 'admin_message', messageId: payload.data?.messageId });
      }
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // dispatch + admin_message belong to the driver app (root); SOS to /admin.
  const isDriverSurface = data.type === 'dispatch' || data.type === 'admin_message';
  const url  = data.url || (isDriverSurface ? '/' : '/admin');
  const focusToken = isDriverSurface ? '/' : '/admin';

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Focus an existing tab on the matching surface if there is one.
    // /admin match must be exact-ish to avoid matching the driver root '/'.
    for (const c of all) {
      const path = new URL(c.url).pathname;
      if (focusToken === '/admin' ? path.startsWith('/admin') : !path.startsWith('/admin')) {
        await c.focus();
        // Deep-link the driver app straight to the tapped message (open inbox,
        // highlight + mark read). A freshly opened window picks it up on boot.
        if (data.type === 'admin_message') {
          c.postMessage({ type: 'open_message', messageId: data.messageId });
        }
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
  // Dev: never intercept — let every request hit the network for fresh assets.
  if (DEV) return;

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
