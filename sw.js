// Indibat fuers Handy: haelt nur die Programmdateien vor, damit die App auch ohne Netz startet.
// Deine Daten (Aufgaben, Gebete, Links) laufen nie hier durch; sie gehen direkt an deine Nextcloud.
const VERSION = 'indibat-15';
const DATEIEN = ['./', 'index.html', 'app.js', 'kern.js', 'taeglich.js', 'pool.js', 'stil.css', 'manifest.webmanifest', 'icons/indibat-64.png', 'icons/indibat-256.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(DATEIEN.map((d) => new Request(d, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n !== VERSION && n !== 'indibat-geteilt').map((n) => caches.delete(n)))).then(() => self.clients.claim()));
});
// Teilen-Menü anderer Apps → Indibat: Dateien und Texte zwischenspeichern, die Seite lädt sie in den Pool hoch.
async function geteiltAnnehmen(request) {
  const f = await request.formData();
  const c = await caches.open('indibat-geteilt');
  let i = 0;
  for (const datei of f.getAll('dateien')) {
    if (!datei || typeof datei === 'string' || !datei.name) continue;
    await c.put(new Request('./geteilt/' + Date.now() + '-' + i++), new Response(datei, { headers: { 'X-Name': encodeURIComponent(datei.name), 'Content-Type': datei.type || 'application/octet-stream' } }));
  }
  const text = ['title', 'text', 'url'].map((k) => f.get(k)).filter(Boolean).join('\n');
  if (text && !i) {
    const name = 'Notiz ' + new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-') + '.txt';
    await c.put(new Request('./geteilt/' + Date.now() + '-t'), new Response(text, { headers: { 'X-Name': encodeURIComponent(name), 'Content-Type': 'text/plain; charset=utf-8' } }));
  }
  return Response.redirect('./?sicht=pool', 303);
}
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method === 'POST' && u.origin === self.location.origin && u.pathname.endsWith('/teilen')) { e.respondWith(geteiltAnnehmen(e.request)); return; }
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return; // Nextcloud-Zugriffe nicht anfassen
  // Erst das Netz, und zwar am Zwischenspeicher des Browsers vorbei (sonst kaemen Updates bis zu 10 Minuten verspaetet an),
  // ohne Netz die gespeicherte Fassung.
  e.respondWith(fetch(e.request.url, { cache: 'no-cache' }).then((r) => {
    if (r.ok) { const kopie = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, kopie)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
