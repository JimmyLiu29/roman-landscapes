const SHELL = 'atlas-shell-__SHELL_VERSION__';
// Cache the canonical root; static hosts may redirect /index.html to /.
const FILES = __SHELL_FILES__.map(file => file === '/index.html' ? '/' : file);
let legacyTakeover = false;

async function previousShells() {
  return (await caches.keys()).filter(key => key.startsWith('atlas-shell-') && key !== SHELL);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(FILES.map(path => new Request(path, { cache: 'reload' })));
    for (const key of await previousShells()) {
      const response = await caches.match('/release.json', { cacheName: key });
      const manifest = await response?.json().catch(() => null);
      if (manifest && typeof manifest === 'object' && !('view_bounds' in manifest)) {
        legacyTakeover = true;
        await self.skipWaiting();
        break;
      }
    }
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await previousShells()).map(key => caches.delete(key)));
    await self.clients.claim();
    if (legacyTakeover) {
      const clients = await self.clients.matchAll({ type: 'window' });
      // Navigations can fetch through this worker once activation finishes.
      for (const client of clients) client.navigate(client.url).catch(() => {}); // A tab may have closed.
    }
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
