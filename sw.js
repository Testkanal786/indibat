// Indibat fuers Handy: haelt nur die Programmdateien vor, damit die App auch ohne Netz startet.
// Deine Daten (Aufgaben, Gebete, Links) laufen nie hier durch; sie gehen direkt an deine Nextcloud.
const VERSION = 'indibat-6';
const DATEIEN = ['./', 'index.html', 'app.js', 'stil.css', 'manifest.webmanifest', 'icons/indibat-64.png', 'icons/indibat-256.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(DATEIEN.map((d) => new Request(d, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n !== VERSION).map((n) => caches.delete(n)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return; // Nextcloud-Zugriffe nicht anfassen
  // Erst das Netz, und zwar am Zwischenspeicher des Browsers vorbei (sonst kaemen Updates bis zu 10 Minuten verspaetet an),
  // ohne Netz die gespeicherte Fassung.
  e.respondWith(fetch(e.request.url, { cache: 'no-cache' }).then((r) => {
    if (r.ok) { const kopie = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, kopie)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
