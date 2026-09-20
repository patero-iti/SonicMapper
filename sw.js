/**
 * SonicMapper Service Worker (PWA Offline Field Resilience)
 * Caches application shell, assets, audio files, and vector map tiles for offline nature fieldwalks.
 */
const CACHE_NAME = 'sonicmapper-app-v0.9.0';
const TILE_CACHE_NAME = 'sonicmapper-tiles-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './style-maplibre.css',
  './version.json',
  './manifest.webmanifest',
  './data/sample-soundscape.json',
  './js/maplibre-gl.js',
  './js/app.js',
  './js/audio-engine.js',
  './js/map-controller.js',
  './js/geo-engine.js',
  './js/storage-engine.js',
  './js/ui-controller.js',
  './js/ambisonic-decoder.js'
];

// Install Event - Pre-cache core application shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event - Clean up obsolete caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME && name !== TILE_CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Dynamic caching for vector tiles & cache-first for local assets
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // Handle Vector Map Tiles (OpenFreeMap / MapTiler)
  if (requestUrl.hostname.includes('tiles.openfreemap.org') || requestUrl.hostname.includes('unpkg.com')) {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then(async (cache) => {
        const cachedResponse = await cache.match(event.request);
        if (cachedResponse) {
          // Return cached and update in background (Stale-While-Revalidate)
          fetch(event.request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(event.request, networkResponse);
            }
          }).catch(() => {});
          return cachedResponse;
        }

        try {
          const networkResponse = await fetch(event.request);
          if (networkResponse && networkResponse.status === 200) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          return cachedResponse || Response.error();
        }
      })
    );
    return;
  }

  // Handle Core App Assets (Cache-First, Fallback to Network)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});