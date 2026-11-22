'use strict';
// Indibat fürs Handy - Reiter "Pool": Dateien zwischen Laptop und Handy teilen (Nextcloud-Ordner /Pool).
// Teilen über das Android-Teilen-Menü, Speichern in Downloads. Indibat steht außerdem im Teilen-Menü anderer Apps:
// Was dort geteilt wird, landet im Pool (der Service-Worker nimmt es an, diese Datei lädt es hoch).
/* global IndibatKern, h, fuelle, $, blatt, blattZu, toast, daten, konto, wurzel, auth, zeichne, merken, dateiLesen, dateiAendern, sicht:writable */
const POOL_TAGE = 14;
const p_poolUrl = (name) => `${wurzel()}/remote.php/dav/files/${encodeURIComponent(konto.user)}/Pool${name ? '/' + encodeURIComponent(name) : '/'}`;
let poolDaten = null;
let poolLaedt = false;

async function poolAnfrage(method, url, extra = {}) {
  let r;
  try { r = await fetch(url, { method, credentials: 'omit', ...extra, headers: { Authorization: auth(), ...(extra.headers || {}) } }); }
  catch { throw new Error('Keine Verbindung zur Nextcloud'); }
  return r;
}
const xmlTag = (b, n) => { const m = b.match(new RegExp(`<(?:[\\w-]+:)?${n}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${n}>`)); return m ? m[1] : null; };
async function poolLesen() {
  const body = '<d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:getlastmodified/><d:getcontentlength/><d:getcontenttype/><d:resourcetype/><nc:upload_time/><nc:creation_time/></d:prop></d:propfind>';
  let r = await poolAnfrage('PROPFIND', p_poolUrl(), { headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body });
  if (r.status === 404) { await poolAnfrage('MKCOL', p_poolUrl()); return []; }
  if (r.status >= 400) throw new Error('Pool nicht lesbar (Fehler ' + r.status + ')');
  const text = await r.text();
  const out = [];
  for (const b of text.split(/<(?:[\w-]+:)?response[\s>]/).slice(1)) {
    if (/<(?:[\w-]+:)?collection\s*\/?>/.test(b)) continue;
    const name = decodeURIComponent((xmlTag(b, 'href') || '').replace(/\/+$/, '').split('/').pop());
    const zahl = (s) => { const n = parseInt(s, 10); return n > 0 ? n * 1000 : 0; };
    const geaendert = Date.parse(xmlTag(b, 'getlastmodified') || '') || 0;
    const hoch = zahl(xmlTag(b, 'upload_time')) || zahl(xmlTag(b, 'creation_time')) || geaendert;
    out.push({ name, groesse: parseInt(xmlTag(b, 'getcontentlength') || '0', 10), typ: xmlTag(b, 'getcontenttype') || '', hochgeladen: hoch, ablauf: hoch + POOL_TAGE * 86400000 });
  }
  return out.sort((a, b) => b.hochgeladen - a.hochgeladen);
}
async function poolLaden() {
  if (!konto || poolLaedt) return;
  poolLaedt = true;
  try {
    const [liste, beh] = await Promise.all([poolLesen(), dateiLesen('pool.json', () => ({ behalten: [] }))]);
    const behalten = new Set(beh.daten.behalten || []);
    poolDaten = liste.map((d) => ({ ...d, behalten: behalten.has(d.name) }));
  } catch (e) { if (!poolDaten) poolDaten = []; toast('Pool: ' + e.message); }
  poolLaedt = false;
  zeichne();
}
async function p_freierName(name) {
  const punkt = name.lastIndexOf('.');
  const stamm = punkt > 0 ? name.slice(0, punkt) : name;
  const ext = punkt > 0 ? name.slice(punkt) : '';
  let n = name;
  for (let i = 2; i < 100; i++) {
    const r = await poolAnfrage('PROPFIND', p_poolUrl(n), { headers: { Depth: '0' } });
    if (r.status === 404) return n;
    n = `${stamm} (${i})${ext}`;
  }
  return n;
}
async function poolHochladen(dateien) {
  if (!dateien.length) return;
  toast(dateien.length === 1 ? 'Lädt in den Pool …' : `${dateien.length} Dateien laden …`);
  try {
    await poolAnfrage('MKCOL', p_poolUrl());
    for (const f of dateien) {
      const name = await p_freierName(f.name || 'Datei');
      const r = await poolAnfrage('PUT', p_poolUrl(name), { headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f });
      if (r.status >= 400) throw new Error(`${f.name}: Fehler ${r.status}`);
    }
    toast('Im Pool – auch am Laptop');
  } catch (e) { toast('Nicht hochgeladen: ' + e.message); }
  poolLaden();
}
async function poolHolen(d) {
  const r = await poolAnfrage('GET', p_poolUrl(d.name));
  if (!r.ok) throw new Error('Fehler ' + r.status);
  const blob = await r.blob();
  return new File([blob], d.name, { type: d.typ || blob.type || 'application/octet-stream' });
}
async function poolTeilen(d) {
  try {
    toast('Wird vorbereitet …');
    const f = await poolHolen(d);
    if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: d.name });
    else { poolSpeichernAus(f); toast('Teilen geht hier nicht – stattdessen gespeichert'); }
  } catch (e) { if (e.name !== 'AbortError') toast('Teilen fehlgeschlagen: ' + e.message); }
}
function poolSpeichernAus(f) {
  const url = URL.createObjectURL(f);
  const a = h('a', { href: url, download: f.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function poolSpeichern(d) {
  try { toast('Lädt herunter …'); poolSpeichernAus(await poolHolen(d)); } catch (e) { toast('Fehlgeschlagen: ' + e.message); }
}
async function poolBehalten(d) {
  d.behalten = !d.behalten; zeichne();
  try { await dateiAendern('pool.json', () => ({ behalten: [] }), (x) => { const s = new Set(x.behalten || []); if (d.behalten) s.add(d.name); else s.delete(d.name); x.behalten = [...s]; }); }
  catch (e) { d.behalten = !d.behalten; zeichne(); toast('Nicht gespeichert: ' + e.message); }
}
async function poolLoeschen(d) {
  if (!confirm(`„${d.name}“ aus dem Pool löschen?`)) return;
  poolDaten = poolDaten.filter((x) => x !== d); zeichne();
  const r = await poolAnfrage('DELETE', p_poolUrl(d.name)).catch(() => null);
  if (!r || (r.status >= 400 && r.status !== 404)) { toast('Nicht gelöscht'); poolLaden(); }
  if (d.behalten) dateiAendern('pool.json', () => ({ behalten: [] }), (x) => { x.behalten = (x.behalten || []).filter((n) => n !== d.name); }).catch(() => {});
}

/* ---------- Anzeige ---------- */
const p_groesseText = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');
function p_alterText(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return 'gerade eben';
  if (m < 60) return `vor ${m} Min`;
  if (m < 1440) return `vor ${Math.round(m / 60)} Std`;
  const t = Math.round(m / 1440);
  return t === 1 ? 'gestern' : `vor ${t} Tagen`;
}
const p_restText = (d) => { if (d.behalten) return 'behalten'; const t = Math.ceil((d.ablauf - Date.now()) / 86400000); return t <= 1 ? 'läuft heute ab' : `noch ${t} Tage`; };
const p_typText = (n) => (n.includes('.') ? n.split('.').pop().slice(0, 4).toUpperCase() : 'DATEI');

function poolBlatt(d) {
  blatt(d.name,
    h('p', { class: 'klein' }, `${p_alterText(d.hochgeladen)} · ${p_groesseText(d.groesse)} · ${p_restText(d)}`),
    h('div', { class: 'pool-aktionen' },
      h('button', { class: 'knopf primaer', onclick: () => { blattZu(); poolTeilen(d); } }, 'Teilen …'),
      h('button', { class: 'knopf', onclick: () => { blattZu(); poolSpeichern(d); } }, 'In Downloads speichern'),
      h('button', { class: 'knopf', onclick: () => { blattZu(); poolBehalten(d); } }, d.behalten ? 'Nicht mehr behalten' : 'Behalten (nicht nach 14 Tagen löschen)'),
      h('button', { class: 'knopf rot', onclick: () => { blattZu(); poolLoeschen(d); } }, 'Löschen')),
    h('div', { class: 'reihe' }, h('span', { class: 'links' }), h('button', { class: 'knopf', onclick: blattZu }, 'Schließen')));
}
function sichtPool() {
  if (poolDaten === null) { poolLaden(); return [h('div', { class: 'karte' }, h('p', { class: 'leer' }, 'Wird geladen …'))]; }
  const waehler = h('input', { type: 'file', multiple: true, hidden: true });
  IndibatKern.an(waehler, 'change', () => { poolHochladen([...waehler.files]); waehler.value = ''; });
  return [
    h('div', { class: 'reihe pool-kopf' }, waehler,
      h('button', { class: 'knopf primaer voll', onclick: () => waehler.click() }, '+ Dateien in den Pool'),
      h('button', { class: 'knopf flach', 'aria-label': 'Aktualisieren', onclick: poolLaden }, '↻')),
    poolDaten.length
      ? h('div', { class: 'karte' }, poolDaten.map((d) => h('div', { class: 'pool-zeile' + (d.behalten ? ' behalten' : ''), 'data-k': d.name },
        h('button', { class: 'pool-los', onclick: () => poolBlatt(d) },
          h('span', { class: 'pool-typ' }, p_typText(d.name)),
          h('span', { class: 'pool-text' }, h('span', { class: 'pool-name' }, d.name), h('span', { class: 'pool-meta' }, `${p_alterText(d.hochgeladen)} · ${p_groesseText(d.groesse)} · ${p_restText(d)}`))),
        h('button', { class: 'mini', 'aria-label': 'Teilen', onclick: () => poolTeilen(d) }, '⇪'))))
      : h('div', { class: 'karte' }, h('p', { class: 'leer' }, 'Der Pool ist leer. Lege am Laptop Dateien in die Karte „Pool“ oder teile hier etwas aus einer anderen App mit Indibat.')),
    h('p', { class: 'klein mitte' }, 'Dateien verschwinden nach 14 Tagen, außer du behältst sie. Der Ordner heißt in der Nextcloud „Pool“.'),
  ];
}

/* ---------- Aus anderen Apps geteilt (Teilen-Menü → Indibat) ---------- */
async function geteiltHochladen() {
  if (!konto || !('caches' in window)) return;
  const c = await caches.open('indibat-geteilt');
  const keys = await c.keys();
  if (!keys.length) return;
  const dateien = [];
  for (const k of keys) {
    const r = await c.match(k);
    if (!r) continue;
    const name = decodeURIComponent(r.headers.get('X-Name') || 'Datei');
    dateien.push(new File([await r.blob()], name, { type: r.headers.get('Content-Type') || 'application/octet-stream' }));
    await c.delete(k);
  }
  sicht = 'pool';
  zeichne();
  await poolHochladen(dateien);
}
setTimeout(() => {
  if (new URLSearchParams(location.search).get('sicht') === 'pool') { sicht = 'pool'; history.replaceState(null, '', location.pathname); zeichne(); }
  geteiltHochladen().catch((e) => toast('Geteilte Datei: ' + e.message));
}, 300);
document.addEventListener('visibilitychange', () => { if (!document.hidden && sicht === 'pool') poolLaden(); });
