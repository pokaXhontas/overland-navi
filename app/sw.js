/* Service Worker: hält die App selbst offline bereit. Kartendaten liegen im App-Speicher (OPFS). */
'use strict';

const VERSION = '__BUILD__';
const SHELL_CACHE = 'ovl-shell-' + VERSION;
const ASSET_CACHE = 'ovl-assets';
const DATA_CACHE = 'ovl-data';

const SHELL = [
  './',
  'index.html',
  'style.css',
  'access.js',
  'app.js',
  'lists.js',
  'trash.js',
  'menu.js',
  'sync.js',
  'live.js',
  'dl-worker.js',
  'extract.js',
  'vehicles.js',
  'nav.js',
  'router-worker.js',
  'planner.js',
  'draw.js',
  'swipe.js',
  'hike.js',
  'tours.js',
  'poi.js',
  'handbuch.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'vendor/maplibre-gl.js',
  'vendor/maplibre-gl.css',
  'vendor/pmtiles.js',
  'vendor/basemaps.js',
  'vendor/maplibre-contour.js',
  'vendor/qrcode.js',
  'vendor/country-coder.js',
  'vendor/jsqr.js'
];

self.addEventListener('install', (event) => {
  // cache: 'reload' – sonst kann der Browser-Zwischenspeicher (bis 10 min) noch die alte Fassung liefern
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('ovl-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname;

  // Große Kartendateien: nie über den Cache, damit Bereichsanfragen und Downloads direkt laufen
  if (path.endsWith('.pmtiles')) return;

  // Liste der Kartengebiete: erst Netz, sonst gespeicherte Fassung
  if (path.endsWith('/data/regions.json') || path.endsWith('/data/countries.json')) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      try {
        const resp = await fetch(req);
        if (resp.ok) cache.put(req, resp.clone());
        return resp;
      } catch (e) {
        return (await cache.match(req)) || new Response('{"regions":[]}', { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // Empfohlene Touren: erst Netz, sonst gespeicherte Fassung (offline verfügbar)
  if (path.includes('/tours/')) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      try {
        const resp = await fetch(req);
        if (resp.ok) cache.put(req, resp.clone());
        return resp;
      } catch (e) {
        return (await cache.match(req)) || new Response(null, { status: 404 });
      }
    })());
    return;
  }

  // Bilder fürs Handbuch: aus dem Speicher, im Hintergrund erneuern
  if (path.includes('/handbuch/')) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then((resp) => { if (resp.ok) cache.put(req, resp.clone()); return resp; }).catch(() => null);
      return hit || (await net) || new Response(null, { status: 404 });
    })());
    return;
  }

  // Schriften und Kartensymbole: erst Cache, sonst Netz und merken
  if (path.includes('/fonts/') || path.includes('/sprites/') || (path.includes('/voices/') && path.endsWith('.mp3'))) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const resp = await fetch(req);
        if (resp.ok) cache.put(req, resp.clone());
        return resp;
      } catch (e) {
        return new Response(null, { status: 404 });
      }
    })());
    return;
  }

  // App-Dateien: erst Cache, im Hintergrund aktualisieren
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    // Seitenaufrufe (navigate) lassen sich nicht mit Optionen weiterreichen, daher über die Adresse
    const net = fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' }).then((resp) => {
      if (resp.ok && resp.type === 'basic') cache.put(req, resp.clone());
      return resp;
    }).catch(() => null);
    if (hit) return hit;
    const resp = await net;
    if (resp) return resp;
    if (req.mode === 'navigate') {
      const index = await cache.match('index.html');
      if (index) return index;
    }
    return new Response('Offline', { status: 503 });
  })());
});

/* Push-Nachrichten: neue Zugangsanfragen (für Verwalter) und „Zugang freigegeben“ */
self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (e) { m = { title: 'Overland-Navi', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(m.title || 'Overland-Navi', {
    body: m.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: m.url === '#zugaenge' ? 'zugang' : undefined, data: { url: m.url || '' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = (event.notification.data && event.notification.data.url) || '';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) { c.postMessage({ type: 'open', hash }); return c.focus(); }
    }
    return self.clients.openWindow(self.registration.scope + hash);
  })());
});
