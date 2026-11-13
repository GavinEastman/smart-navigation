// Keeps the app itself cached so it opens fast on a weak signal.
// Logins, routes, address search, routing and map tiles always use the network.
const CACHE = 'smartnav-v1.6';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'logic.js', 'locations.js', 'config.js', 'manifest.json',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const shell = url.origin === location.origin || SHELL.includes(e.request.url);
  if (!shell) return;
  // Network first so updates appear right away; cached copy when offline
  e.respondWith(
    // 'no-cache' = always ask GitHub if there's a newer file (cheap check), so updates show up right away
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
