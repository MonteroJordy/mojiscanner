/* Keeps the door app opening with no signal. The guest list itself lives in IndexedDB. */
var CACHE = 'door-shell-v10';
var FONTS = 'door-fonts-v1';
var SHELL = ['/', '/css/app.css', '/js/codes.js', '/js/scanner.js', '/js/door.js', '/js/qr-worker.js', '/js/qr-decoder.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/favicon.png', '/brand/moji-logo.png', '/fonts/ArchivoBlack-Regular.ttf'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== FONTS; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Web fonts: cache first, so the door keeps its look with no signal once they've loaded once.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(function (c) {
      return c.match(e.request).then(function (hit) {
        return hit || fetch(e.request).then(function (res) { if (res.ok || res.type === 'opaque') c.put(e.request, res.clone()); return res; });
      });
    }).catch(function () { return new Response('', { status: 504 }); }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/hooks/') === 0) return;
  // Network first so new versions arrive; cache when there's no signal.
  e.respondWith(fetch(e.request).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(e.request).then(function (r) { return r || caches.match('/'); });
  }));
});
