const SHELL = 'atlas-shell-__SHELL_VERSION__';
// Cache the canonical root; static hosts may redirect /index.html to /.
const FILES = __SHELL_FILES__.map(file => file === '/index.html' ? '/' : file);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(FILES)));
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('message', event => {
  if (event.data === 'activate') self.skipWaiting();
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/packs/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    if (url.pathname === '/release.json') {
      try { return await fetch(event.request); } catch { return cache.match('/release.json'); }
    }
    const cached = await cache.match(event.request.mode === 'navigate' ? '/' : event.request);
    return cached || fetch(event.request);
  })());
});
