const CACHE_NAME = 'stock-pro-v2-cache-v1';
const STATIC_ASSETS = [
  '/stock-pro-V2/',
  '/stock-pro-V2/index.html',
];

// Install — cache static assets
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
});

// Activate — clear old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first, fallback to cache
self.addEventListener('fetch', e => {
  // ข้าม API calls (ไม่ cache)
  if (e.request.url.includes('finnhub') ||
      e.request.url.includes('workers.dev') ||
      e.request.url.includes('googleapis') ||
      e.request.url.includes('cohere') ||
      e.request.url.includes('groq') ||
      e.request.url.includes('openrouter') ||
      e.request.url.includes('anthropic')) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // cache หน้าหลักเท่านั้น
        if (e.request.url.includes('/stock-pro-V2/')) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
