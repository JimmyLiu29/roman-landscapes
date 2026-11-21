const SHELL = 'atlas-shell-__SHELL_VERSION__';
// Cache the canonical root; static hosts may redirect /index.html to /.
const FILES = __SHELL_FILES__.map(file => file === '/index.html' ? '/' : file);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(FILES.map(path => new Request(path, { cache: 'reload' })))));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('atlas-shell-') && key !== SHELL).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data === 'activate') self.skipWaiting();
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/packs/')) return;
  if (url.pathname === '/release.json' && url.searchParams.has('check')) {
    return; // Network-only update checks must also surface a disconnected network.
  }
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    if (url.pathname === '/release.json') {
      return (await cache.match(event.request)) || fetch(event.request);
    }
    const cached = await cache.match(event.request.mode === 'navigate' ? '/' : event.request);
    return cached || fetch(event.request);
  })());
});
