// Minimal service worker: makes the app installable. Never caches orders or API calls.
const SHELL = 'canteen-shell-v1';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then(c => c.add('/'))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok && u.pathname === '/') { const c = r.clone(); caches.open(SHELL).then(x => x.put('/', c)); } return r; })
    .catch(() => caches.match(e.request).then(m => m || caches.match('/'))));
});
