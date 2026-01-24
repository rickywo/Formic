// Formic Service Worker
// Minimal service worker for PWA installability (no offline caching per non-goals)

const CACHE_NAME = 'formic-v1';

// Install event - skip waiting to activate immediately
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker');
  self.skipWaiting();
});

// Activate event - claim clients immediately
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker');
  event.waitUntil(self.clients.claim());
});

// Fetch event - pass through to network (no caching)
self.addEventListener('fetch', (event) => {
  // Simply fetch from network, no caching
  event.respondWith(fetch(event.request));
});
