const CACHE_NAME = 'travel-memo-v2-8-7';
const OFFLINE_URL = '/offline.html';
const PRECACHE_URLS = [
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/app-mark.svg',
  '/icons/travel-memo/travel-memo-icons.sprite.svg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('travel-memo') && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'CLEAR_TRAVEL_MEMO_CACHES') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('travel-memo')).map((key) => caches.delete(key)))));
  }
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.ok && request.method === 'GET') {
      await cache.put(request, response.clone()).catch(() => null);
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    return cached || (fallbackUrl ? caches.match(fallbackUrl) : Promise.reject(error));
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) await cache.put(request, response.clone()).catch(() => null);
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, OFFLINE_URL));
    return;
  }

  if (['script', 'style', 'worker'].includes(request.destination) || url.pathname.includes('/assets/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});
