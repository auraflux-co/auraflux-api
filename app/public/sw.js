// AuraFlux service worker — CPD-118
// Enables PWA installability. Caches the app shell for fast loads.

const CACHE = 'auraflux-v2';
const SHELL = ['/dashboard/jobs', '/dashboard/jobs/active'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for API calls, cache-first for static assets
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Always network for API, auth routes, and Clerk
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/sign-in') ||
    url.pathname.startsWith('/sign-up') ||
    url.hostname.includes('clerk')
  ) return;

  // Network-first for navigation with safe fallback
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match('/dashboard/jobs');
        return cached || Response.error();
      })
    );
    return;
  }

  // Skip cross-origin requests (e.g. New Relic, Clerk CDN) — let browser handle them
  if (url.origin !== self.location.origin) return;

  // Cache-first for same-origin static assets, with safe fetch fallback
  e.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).catch(() => Response.error()))
  );
});

// Push notifications — ready for VAPID integration
self.addEventListener('push', (e) => {
  if (!e.data) return;
  const data = e.data.json();
  e.waitUntil(
    self.registration.showNotification(data.title || 'AuraFlux', {
      body:  data.body  || '',
      icon:  '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data:  { url: data.url || '/dashboard/jobs' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then((ws) => {
      const url = e.notification.data?.url || '/dashboard/jobs';
      const w = ws.find((w) => w.focus);
      if (w) { w.focus(); w.navigate(url); }
      else clients.openWindow(url);
    })
  );
});
