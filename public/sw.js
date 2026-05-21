const CACHE_VERSION = 'v1';
const CACHE_NAME    = `san-queue-${CACHE_VERSION}`;

const PRECACHE = [
  '/',
  '/admin',
  '/manifest.json',
  '/js/utils.js',
  '/js/driver/app.js',
  '/js/driver/auth.controller.js',
  '/js/driver/dashboard.controller.js',
  '/js/driver/history.controller.js',
  '/js/driver/schedule.controller.js',
  '/js/admin/app.js',
  '/js/admin/auth.controller.js',
  '/js/admin/daySchedule.controller.js',
  '/js/admin/drivers.controller.js',
  '/js/admin/logs.controller.js',
  '/js/admin/monitor.controller.js',
  '/js/admin/overview.controller.js',
  '/js/admin/scheduledDrivers.controller.js',
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
