// Service Worker for better caching and offline support
const CACHE_NAME = 'movie-player-v1';
const urlsToCache = [
  '/',
  '/index.html',
  'https://cdn.tailwindcss.com'
];

self.addEventListener('install', function(event) {
  console.log('Service Worker: Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        console.log('Service Worker: Caching assets...');
        return cache.addAll(urlsToCache);
      })
  );
});

self.addEventListener('fetch', function(event) {
  event.respondWith(
    caches.match(event.request)
      .then(function(response) {
        if (response) {
          console.log('Service Worker: Serving from cache:', event.request.url);
          return response;
        }
        console.log('Service Worker: Fetching from network:', event.request.url);
        return fetch(event.request);
      })
      .catch(error => {
        console.error('Service Worker: Fetch failed:', error);
      })
  );
});
