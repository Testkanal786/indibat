'use strict';
// Indibat fuers Handy. Spricht direkt mit deiner Nextcloud (CalDAV fuer Aufgaben und Gebete, WebDAV fuer die Links).
// Es gibt keinen eigenen Server: Zugangsdaten und Daten liegen nur auf diesem Geraet und in deiner Nextcloud.

/* ================= Helfer ================= */
const $ = (s) => document.querySelector(s);
function h(tag, attr, ...kinder) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attr || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) IndibatKern.an(e, k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kinder.flat(Infinity)) if (k != null && k !== false) e.append(k);
  return e;
}
// Inhalt angleichen statt ersetzen (siehe morph in kern.js): so laufen Uebergaenge weich.
const fuelle = (el, ...kinder) => IndibatKern.morphInhalt(el, kinder.flat(Infinity).filter((k) => k != null && k !== false));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const tagVersetzt = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const lager = {
  lies(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  schreib(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* voll oder gesperrt */ } },
  weg(k) { try { localStorage.removeItem(k); } catch { /* egal */ } },
};
let toastUhr = 0;
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastUhr);
  toastUhr = setTimeout(() => { t.hidden = true; }, 3500);
}
let blattNeu = null;
let blattUhr = 0;
let blattAuffrischen = false;
function blatt(titel, ...inhalt) {
  blattNeu = null;
  const b = $('#blatt');
  clearTimeout(blattUhr); b.classList.remove('zu');
  // Neues Blatt: alten Inhalt ersetzen. Wuerde es angeglichen, blieben die alten Eingabefelder stehen,
  // waehrend "Speichern" die neuen (unsichtbaren) liest - Aenderungen gingen verloren.
  const box = h('div', { class: 'blatt-box' }, h('h3', null, titel), inhalt);
  if (blattAuffrischen) fuelle(b, box); else b.replaceChildren(box);
  b.hidden = false;
}
// Schliessen mit kurzer Animation nach unten.
const blattZu = () => {
  blattNeu = null;
  const b = $('#blatt');
  if (b.hidden) return;
  b.classList.add('zu');
  clearTimeout(blattUhr);
  blattUhr = setTimeout(() => { b.hidden = true; b.classList.remove('zu'); b.replaceChildren(); }, 200);
};

/* ================= Nextcloud (CalDAV / WebDAV) ================= */
let konto = lager.lies('indibat-konto'); // { url, login, pass, user }
const wurzel = () => konto.url.replace(/\/+$/, '');
const heim = () => `${wurzel()}/remote.php/dav/calendars/${encodeURIComponent(konto.user)}/`;
const auth = () => 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(`${konto.login}:${konto.pass}`)));

async function dav(method, url, { body, depth, type } = {}) {
  const headers = { Authorization: auth() };
  if (depth != null) headers.Depth = String(depth);
  if (body != null) headers['Content-Type'] = type || 'application/xml; charset=utf-8';
  let r;
  try { r = await fetch(url, { method, headers, body, credentials: 'omit', signal: AbortSignal.timeout(20000) }); }
  catch { const e = new Error('Keine Verbindung zur Nextcloud'); e.netz = true; throw e; }
  const text = await r.text();
  if (r.status >= 400) { const e = new Error(r.status === 401 ? 'Anmeldung abgelehnt' : `Nextcloud meldet Fehler ${r.status}`); e.status = r.status; throw e; }
  return text;
}
const xmlDec = (s) => String(s).replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#13;/g, '\r').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
const antworten = (xml) => xml.split(/<(?:[\w-]+:)?response[\s>]/).slice(1);
function tag(block, name) {
  const m = block.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`));
  return m ? m[1] : null;
}
async function benutzerErmitteln() {
  const t = await dav('PROPFIND', `${wurzel()}/remote.php/dav/`, { depth: 0, body: '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>' });
  const m = t.match(/principals\/users\/([^/<]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
async function listenLaden() {
  const t = await dav('PROPFIND', heim(), { depth: 1, body: '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>' });
  const out = [];
  for (const b of antworten(t)) {
    if (!/<(?:[\w-]+:)?calendar[\s/>]/.test(b) || !/name="VTODO"/.test(b)) continue;
    out.push({ href: xmlDec(tag(b, 'href') || ''), name: xmlDec(tag(b, 'displayname') || '') });
  }
  return out;
}

/* ---------- iCalendar (gleiche Regeln wie auf dem Laptop, damit beide dieselben Aufgaben verstehen) ---------- */
const zeilen = (ical) => ical.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l !== '');
const txtDec = (s) => s.replace(/\\n/gi, '\n').replace(/\\([;,\\])/g, '$1');
const txtEnc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stempel = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

function parse(ical) {
  const z = zeilen(ical);
  const a = z.indexOf('BEGIN:VTODO');
  const e = z.lastIndexOf('END:VTODO');
  if (a < 0 || e < 0) return null;
  const t = { uid: '', titel: '', erledigt: false, faellig: null, zeit: null, prio: 0, notiz: '', gruppe: '' };
  let tiefe = 0;
  for (const l of z.slice(a + 1, e)) {
    if (l.startsWith('BEGIN:')) { tiefe++; continue; }
    if (l.startsWith('END:')) { tiefe--; continue; }
    if (tiefe) continue;
    const i = l.indexOf(':');
    if (i < 0) continue;
    const name = l.slice(0, i).split(';')[0].toUpperCase();
    const wert = l.slice(i + 1);
    if (name === 'UID') t.uid = wert;
    else if (name === 'SUMMARY') t.titel = txtDec(wert);
    else if (name === 'DESCRIPTION') t.notiz = txtDec(wert);
    else if (name === 'STATUS') t.erledigt = wert.toUpperCase() === 'COMPLETED';
    else if (name === 'PRIORITY') t.prio = parseInt(wert, 10) || 0;
    else if (name === 'CATEGORIES' && !t.gruppe) t.gruppe = txtDec(wert.split(/(?<!\\),/)[0] || '').trim();
    else if (name === 'DUE') {
      const m = wert.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
      if (m) {
        let d = m[4] ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null;
        if (m[7]) d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]));
        t.faellig = d ? ymd(d) : `${m[1]}-${m[2]}-${m[3]}`;
        t.zeit = d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : null;
      }
    }
  }
  return t.uid ? t : null;
}
function setze(ical, name, zeile) {
  const z = zeilen(ical);
  const a = z.indexOf('BEGIN:VTODO');
  const e = z.lastIndexOf('END:VTODO');
  let tiefe = 0;
  let pos = -1;
  for (let i = a + 1; i < e; i++) {
    if (z[i].startsWith('BEGIN:')) tiefe++;
    else if (z[i].startsWith('END:')) tiefe--;
    else if (!tiefe && z[i].split(/[;:]/)[0].toUpperCase() === name) { pos = i; break; }
  }
  if (pos >= 0) { if (zeile == null) z.splice(pos, 1); else z[pos] = zeile; } else if (zeile != null) z.splice(e, 0, zeile);
  return z.join('\r\n') + '\r\n';
}
function neuesIcal(uid) {
  const s = stempel();
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Indibat//DE', 'BEGIN:VTODO', `UID:${uid}`, `CREATED:${s}`, `DTSTAMP:${s}`, 'END:VTODO', 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
async function aufgabenLaden(listHref) {
  const body = '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>';
  const text = await dav('REPORT', wurzel() + listHref, { depth: 1, body });
  const out = [];
  for (const b of antworten(text)) {
    const daten = tag(b, 'calendar-data');
    if (!daten) continue;
    const ical = xmlDec(daten.trim());
    const t = parse(ical);
    if (t) out.push({ ...t, href: xmlDec(tag(b, 'href') || ''), ical });
  }
  return out;
}
async function speichern(listHref, felder, basis) {
  const uid = basis ? basis.uid : crypto.randomUUID();
  const href = basis ? basis.href : `${listHref}${encodeURIComponent(uid)}.ics`;
  let ical = basis ? basis.ical : neuesIcal(uid);
  const s = stempel();
  if ('titel' in felder) ical = setze(ical, 'SUMMARY', 'SUMMARY:' + txtEnc(felder.titel));
  if ('faellig' in felder) {
    let zeile = null;
    if (felder.faellig) {
      const [j, m, t] = felder.faellig.split('-').map(Number);
      if (felder.zeit) { const [st, mi] = felder.zeit.split(':').map(Number); zeile = 'DUE:' + stempel(new Date(j, m - 1, t, st, mi)); }
      else zeile = `DUE;VALUE=DATE:${j}${pad(m)}${pad(t)}`;
    }
    ical = setze(ical, 'DUE', zeile);
  }
  if ('gruppe' in felder) {
    for (let i = 0; i < 5 && /\r\nCATEGORIES[;:]/i.test(ical); i++) ical = setze(ical, 'CATEGORIES', null);
    if (felder.gruppe) ical = setze(ical, 'CATEGORIES', 'CATEGORIES:' + txtEnc(felder.gruppe));
  }
  if ('notiz' in felder) ical = setze(ical, 'DESCRIPTION', felder.notiz ? 'DESCRIPTION:' + txtEnc(felder.notiz) : null);
  if ('erledigt' in felder) {
    ical = setze(ical, 'STATUS', felder.erledigt ? 'STATUS:COMPLETED' : 'STATUS:NEEDS-ACTION');
    ical = setze(ical, 'COMPLETED', felder.erledigt ? 'COMPLETED:' + s : null);
    ical = setze(ical, 'PERCENT-COMPLETE', felder.erledigt ? 'PERCENT-COMPLETE:100' : null);
  }
  ical = setze(ical, 'LAST-MODIFIED', 'LAST-MODIFIED:' + s);
  ical = setze(ical, 'DTSTAMP', 'DTSTAMP:' + s);
  await dav('PUT', wurzel() + href, { body: ical, type: 'text/calendar; charset=utf-8' });
  return { ...parse(ical), href, ical };
}

/* ================= Zustand ================= */
const GEBETSLISTE = 'Gebete';
let daten = lager.lies('indibat-daten') || { listen: [], aufgaben: {}, config: null, symbole: {}, stand: 0 };
let sicht = 'heute';
let filter = lager.lies('indibat-filter') || '';
let zeigeErledigte = false;
let laedt = false;
const merken = () => lager.schreib('indibat-daten', daten);
const todoListen = () => daten.listen.filter((l) => l.name !== GEBETSLISTE);
const gebetsHref = () => (daten.listen.find((l) => l.name === GEBETSLISTE) || {}).href;

async function laden(leise) {
  if (!konto || laedt) return;
  laedt = true;
  $('#btn-neu-laden').classList.add('dreht');
  try {
    const listen = await listenLaden();
    const aufgaben = {};
    await Promise.all(listen.map(async (l) => { aufgaben[l.href] = await aufgabenLaden(l.href); }));
    let config = daten.config;
    try {
      const t = await dav('GET', `${wurzel()}/remote.php/dav/files/${encodeURIComponent(konto.user)}/Indibat/indibat.json`);
      const j = JSON.parse(t);
      config = { links: j.links || [], claude: j.claude || [] };
    } catch (e) { if (!leise && !e.netz) toast('Links konnten nicht geladen werden'); }
    let symbole = daten.symbole || {};
    try { symbole = JSON.parse(await dav('GET', `${wurzel()}/remote.php/dav/files/${encodeURIComponent(konto.user)}/Indibat/symbole.json`)); } catch { /* Symbole sind Zugabe */ }
    let extra = {};
    try { extra = await taeglichLaden(); } catch (e) { if (!leise) toast('Täglich: ' + e.message); }
    daten = { listen, aufgaben, config, symbole, taeglich: extra.taeglich || daten.taeglich, archiv: extra.archiv || daten.archiv, stand: Date.now() };
    merken();
  } catch (e) {
    if (!leise || e.status === 401) toast(e.message + (daten.stand ? ' – zeige den letzten Stand' : ''));
  } finally {
    laedt = false;
    $('#btn-neu-laden').classList.remove('dreht');
    zeichne();
  }
}
function ersetze(listHref, alt, neu) {
  const a = daten.aufgaben[listHref] || (daten.aufgaben[listHref] = []);
  const i = alt ? a.findIndex((t) => t.uid === alt.uid) : -1;
  if (i >= 0) { if (neu) a[i] = neu; else a.splice(i, 1); } else if (neu) a.push(neu);
  merken();
}
async function umschalten(listHref, t) {
  const vorher = t.erledigt;
  t.erledigt = !vorher; zeichne(); // sofort zeigen, dann sichern
  try { ersetze(listHref, t, await speichern(listHref, { erledigt: !vorher }, t)); }
  catch (e) { t.erledigt = vorher; toast('Nicht gespeichert: ' + e.message); }
  zeichne();
}

/* ================= Sicht: Heute ================= */
const WOCHENTAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
function gebeteAm(tag) {
  const vor = `indibat-gebet-${tag.replace(/-/g, '')}-`;
  return (daten.aufgaben[gebetsHref()] || []).filter((t) => t.uid.startsWith(vor) && t.zeit).sort((a, b) => a.zeit.localeCompare(b.zeit));
}
const zeitpunkt = (t) => new Date(`${t.faellig}T${t.zeit}:00`);
function naechstesGebet() {
  const jetzt = new Date();
  return [...gebeteAm(ymd(tagVersetzt(0))), ...gebeteAm(ymd(tagVersetzt(1)))].find((t) => zeitpunkt(t) > jetzt) || null;
}
function restText(bis) {
  const s = Math.max(0, Math.floor((bis - Date.now()) / 1000));
  const st = Math.floor(s / 3600);
  const mi = Math.floor((s % 3600) / 60);
  return st ? `in ${st} Std ${pad(mi)} Min` : `in ${mi} Min ${pad(s % 60)} Sek`;
}
function datumText(tag) {
  if (!tag) return '';
  const heute = ymd(tagVersetzt(0));
  if (tag === heute) return 'Heute';
  if (tag === ymd(tagVersetzt(1))) return 'Morgen';
  if (tag === ymd(tagVersetzt(-1))) return 'Gestern';
  const [j, m, t] = tag.split('-').map(Number);
  const d = new Date(j, m - 1, t);
  return `${WOCHENTAGE[d.getDay()]}, ${t}.${m}.${j === new Date().getFullYear() ? '' : j}`;
}
function todoZeile(listHref, t, mitListe) {
  const spaet = !t.erledigt && t.faellig && t.faellig < ymd(tagVersetzt(0));
  const liste = mitListe ? (daten.listen.find((l) => l.href === listHref) || {}).name : '';
  const meta = [datumText(t.faellig), t.zeit, liste].filter(Boolean).join(' · ');
  return h('div', { class: 'todo' + (t.erledigt ? ' fertig' : ''), 'data-k': t.uid },
    h('button', { class: 'kreis' + (t.erledigt ? ' an' : ''), 'aria-label': t.erledigt ? 'Wieder öffnen' : 'Abhaken', onclick: () => umschalten(listHref, t) }, t.erledigt ? '✓' : ''),
    h('button', { class: 'todo-text', onclick: () => todoBlatt(listHref, t) },
      h('span', { class: 'titel' }, t.titel || '(ohne Titel)'),
      meta && h('span', { class: 'meta' + (spaet ? ' spaet' : '') }, meta)));
}
/* ---------- Design A1: Gebetskarte mit Kreisen oder Gebetsuhr, Raster der letzten 7 Tage ---------- */
let gebetAnsicht = lager.lies('indibat-gebet-ansicht') || 'kreise';
const SVGNS = 'http://www.w3.org/2000/svg';
function sv(tag, attr, ...kinder) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attr || {})) if (v != null && v !== false) e.setAttribute(k, v);
  for (const c of kinder.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const ANSICHT_SYM = {
  kreise: () => sv('svg', { viewBox: '0 0 24 24', fill: 'currentColor' }, sv('circle', { cx: 4, cy: 12, r: 2.6 }), sv('circle', { cx: 12, cy: 12, r: 2.6 }), sv('circle', { cx: 20, cy: 12, r: 2.6 })),
  uhr: () => sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round' }, sv('circle', { cx: 12, cy: 12, r: 8.5 }), sv('path', { d: 'M12 7.5V12l3 2' })),
};
// Gebet aus der Aufgabenliste "Gebete": Schluessel steht am Ende der UID (…-fajr).
const gebetInfo = (t, jetzt) => ({ t, key: t.uid.split('-').pop(), name: t.titel, zeit: t.zeit, wann: zeitpunkt(t),
  zustand: t.erledigt ? 'fertig' : zeitpunkt(t) <= jetzt ? 'offen' : 'spaeter' });

// Gebetsuhr: 24-Stunden-Zifferblatt, Mittag oben; goldener Bogen ab Fajr bis zum Punkt "jetzt" (aktuelle Uhrzeit).
function gebetsuhr(liste, naechstes, jetzt) {
  const C = 150, R = 110;
  const winkel = (min) => (min / 1440) * 360 + 90;
  const punkt = (r, w) => [C + r * Math.cos((w * Math.PI) / 180), C + r * Math.sin((w * Math.PI) / 180)];
  const minVon = (d) => d.getHours() * 60 + d.getMinutes();
  const bogen = (von, bis) => {
    const [x1, y1] = punkt(R, winkel(von)); const [x2, y2] = punkt(R, winkel(bis));
    const gross = ((bis - von + 1440) % 1440) / 4 > 180 ? 1 : 0;
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 ${gross} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  const jetztMin = minVon(jetzt);
  const fajr = minVon(liste[0].wann);
  const letztes = minVon(liste[liste.length - 1].wann);
  const maghrib = liste[3] ? minVon(liste[3].wann) : letztes;
  const teile = [
    sv('circle', { cx: C, cy: C, r: 140, class: 'u-punkte' }),
    sv('circle', { cx: C, cy: C, r: R, class: 'u-spur' }),
    sv('path', { d: bogen(fajr, maghrib), class: 'u-tag' }),
    jetztMin > fajr && sv('path', { d: bogen(fajr, jetztMin), class: 'u-vorbei', pathLength: 1 }),
    sv('circle', { cx: C, cy: C, r: 92, class: 'u-striche' }),
  ];
  // Beschriftungen nah beieinander liegender Gebete (freitags Jumu'a/Asr) auseinanderruecken.
  const schrift = liste.map((g) => winkel(minVon(g.wann)));
  for (let i = 1; i < schrift.length; i++) if (schrift[i] - schrift[i - 1] < 26) schrift[i] = schrift[i - 1] + 26;
  liste.forEach((g, i) => {
    const [x, y] = punkt(R, winkel(minVon(g.wann)));
    const [lx, ly] = punkt(136, schrift[i]);
    const anker = lx < C - 20 ? 'end' : lx > C + 20 ? 'start' : 'middle';
    const oben = ly < 40;
    teile.push(sv('g', { class: 'u-gebet u-' + g.zustand, 'data-k': g.key },
      sv('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: g.zustand === 'fertig' ? 11 : 10 }),
      sv('text', { x: lx.toFixed(1), y: (oben ? ly - 18 : ly - 4).toFixed(1), 'text-anchor': anker, class: 'u-name' }, g.name),
      sv('text', { x: lx.toFixed(1), y: (oben ? ly + 1 : ly + 15).toFixed(1), 'text-anchor': anker, class: 'u-zeit' }, g.zeit)));
  });
  const [nx, ny] = punkt(R, winkel(jetztMin));
  teile.push(sv('circle', { cx: nx.toFixed(1), cy: ny.toFixed(1), r: 7, class: 'u-jetzt' }));
  if (naechstes) {
    teile.push(sv('text', { x: C, y: 128, 'text-anchor': 'middle', class: 'u-klein' }, 'als Nächstes'));
    teile.push(sv('text', { x: C, y: 166, 'text-anchor': 'middle', class: 'u-gross' }, naechstes.titel));
    teile.push(sv('text', { x: C, y: 192, 'text-anchor': 'middle', class: 'u-count', id: 'countdown' }, restText(zeitpunkt(naechstes))));
  }
  return sv('svg', { viewBox: '-84 -40 468 340', class: 'gebetsuhr', role: 'img', 'aria-label': 'Gebetsuhr' }, teile);
}

// Raster der letzten 7 Tage (je fuenf Kaestchen); Antippen oeffnet das Nachtragen.
function wochenRaster(jetzt) {
  let ist = 0, soll = 0;
  const spalten = [];
  for (let i = -6; i <= 0; i++) {
    const d = tagVersetzt(i);
    const liste = gebeteAm(ymd(d)).map((t) => gebetInfo(t, jetzt));
    const faellige = liste.filter((g) => g.zustand !== 'spaeter');
    const zuletzt = faellige[faellige.length - 1];
    const felder = (liste.length ? liste : [0, 1, 2, 3, 4].map(() => null)).map((g) => {
      if (!g) return h('span', { class: 'wk' });
      if (g.zustand !== 'spaeter') { soll++; if (g.zustand === 'fertig') ist++; }
      const offenJetzt = i === 0 && g === zuletzt && g.zustand === 'offen';
      return h('span', { class: 'wk' + (g.zustand === 'fertig' ? ' an' : offenJetzt ? ' offen' : g.zustand === 'offen' ? ' fehlt' : '') });
    });
    spalten.push(h('span', { class: 'wspalte' + (i === 0 ? ' heute' : '') }, h('span', { class: 'wtagname' }, WOCHENTAGE[d.getDay()]), felder));
  }
  return h('button', { class: 'wochenraster', 'aria-label': 'Gebete der letzten 7 Tage ansehen und nachtragen', onclick: gebeteBlatt },
    h('span', { class: 'wr-kopf' }, h('span', null, 'Letzte 7 Tage'), h('span', null, `${ist} von ${soll} · antippen zum Nachtragen`)),
    h('span', { class: 'wr-spalten' }, spalten));
}

function gebetsKarte() {
  const heute = ymd(tagVersetzt(0));
  const jetzt = new Date();
  const liste = gebeteAm(heute).map((t) => gebetInfo(t, jetzt));
  // „offen“ ist nur das zuletzt faellige Gebet; fruehere unerledigte gelten als „verpasst“ (blasser, gestrichelt).
  const zuletzt = [...liste].reverse().find((g) => g.wann <= jetzt);
  for (const g of liste) if (g.zustand === 'offen' && g !== zuletzt) g.zustand = 'verpasst';
  if (!gebetsHref() || !liste.length) {
    return h('section', { class: 'band-karte' }, h('p', { class: 'kopf' }, 'Gebete'),
      h('p', { class: 'leer' }, 'Für heute liegen keine Gebetszeiten in der Nextcloud. Der Laptop trägt sie 14 Tage im Voraus ein – starte Indibat dort einmal.'));
  }
  const naechstes = naechstesGebet();
  const offen = [...liste].reverse().find((g) => g.zustand !== 'spaeter');
  const umschalter = h('div', { class: 'ansicht-wahl' }, ['kreise', 'uhr'].map((a) => h('button', {
    class: gebetAnsicht === a ? 'an' : '', 'aria-label': a === 'kreise' ? 'Gebete als Kreise' : 'Gebete als Uhr',
    onclick: () => { gebetAnsicht = a; lager.schreib('indibat-gebet-ansicht', a); zeichne(); } }, ANSICHT_SYM[a]())));
  const ansicht = gebetAnsicht === 'uhr'
    ? h('div', { class: 'ansicht', 'data-k': 'uhr', onclick: (e) => {
      const g = e.target.closest && e.target.closest('.u-gebet');
      const treffer = g && liste.find((x) => x.key === g.getAttribute('data-k'));
      if (treffer) umschalten(gebetsHref(), treffer.t);
    } }, gebetsuhr(liste, naechstes, jetzt))
    : h('div', { class: 'ansicht', 'data-k': 'kreise' },
      naechstes ? [h('div', { class: 'naechstes' }, h('span', { class: 'name' }, naechstes.titel), h('span', { class: 'uhr' }, naechstes.zeit)),
        h('p', { class: 'status' }, h('span', { id: 'countdown' }, restText(zeitpunkt(naechstes))), offen && offen.zustand === 'offen' ? ` · ${offen.name} offen` : '')]
        : h('p', { class: 'status' }, 'Keine weiteren Zeiten eingetragen.'),
      h('div', { class: 'gebet-kreise' }, liste.map((g) => h('button', { class: 'gk-knopf', 'data-k': g.key, 'aria-label': `${g.name} ${g.zeit}`, onclick: () => umschalten(gebetsHref(), g.t) },
        h('span', { class: 'gk gk-' + g.zustand + (g.zustand === 'fertig' ? ' an' : '') }, g.name.charAt(0)), h('span', { class: 'gk-zeit' }, g.zeit)))));
  return h('section', { class: 'band-karte' },
    h('div', { class: 'band-kopf' }, h('span', null, 'Nächstes Gebet · Wolfhagen'), umschalter),
    ansicht,
    new Date().getDay() === 4 && h('p', { class: 'tageshinweis' }, 'Heute Abend ist Dhikr.'),
    wochenRaster(jetzt));
}

function sichtHeute() {
  const heute = ymd(tagVersetzt(0));
  const faellig = [];
  for (const l of todoListen()) for (const t of daten.aufgaben[l.href] || []) if (!t.erledigt && t.faellig && t.faellig <= heute) faellig.push([l.href, t]);
  faellig.sort((a, b) => a[1].faellig.localeCompare(b[1].faellig));
  return [
    gebetsKarte(),
    typeof taeglichKarte === 'function' ? taeglichKarte() : null,
    h('div', { class: 'karte' }, h('div', { class: 'karten-kopf' }, h('span', { class: 'kopf' }, 'Heute fällig'),
      h('button', { class: 'textlink', onclick: () => wechsle('aufgaben') }, 'Alle ›')),
    faellig.length ? faellig.map(([href, t]) => todoZeile(href, t, true)) : h('p', { class: 'leer' }, 'Nichts fällig.')),
  ];
}

function gebeteBlatt() {
  const tage = [];
  for (let i = 0; i >= -7; i--) {
    const d = tagVersetzt(i);
    const g = gebeteAm(ymd(d));
    if (!g.length) continue;
    tage.push(h('div', { class: 'gtag' },
      h('p', { class: 'gtag-name' }, i === 0 ? 'Heute' : i === -1 ? 'Gestern' : `${WOCHENTAGE[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}.`),
      h('div', { class: 'gtag-reihe' }, g.map((t) => h('button', { class: 'gknopf', 'aria-pressed': String(t.erledigt), onclick: () => umschalten(gebetsHref(), t) },
        h('span', { class: 'kreis' + (t.erledigt ? ' an' : '') }, t.erledigt ? '✓' : ''), h('span', { class: 'gname' }, t.titel))))));
  }
  blatt('Gebete der letzten Tage', tage.length ? tage : h('p', { class: 'leer' }, 'Keine Einträge vorhanden.'),
    h('div', { class: 'reihe' }, h('span', { class: 'links' }), h('button', { class: 'knopf', onclick: blattZu }, 'Schließen')));
  blattNeu = gebeteBlatt;
}

/* ================= Sicht: Aufgaben ================= */
function sichtAufgaben() {
  const listen = todoListen();
  if (!listen.length) return [h('div', { class: 'karte' }, h('p', { class: 'leer' }, 'Noch keine Aufgabenlisten gefunden.'))];
  if (!listen.some((l) => l.href === filter)) filter = listen[0].href;
  const alle = daten.aufgaben[filter] || [];
  const sichtbar = alle.filter((t) => t.erledigt === zeigeErledigte);
  const gruppen = new Map();
  for (const t of sichtbar) { const g = t.gruppe || ''; if (!gruppen.has(g)) gruppen.set(g, []); gruppen.get(g).push(t); }
  const namen = [...gruppen.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'de')));
  const ordnung = (a, b) => (a.erledigt - b.erledigt) || (a.faellig || '9999').localeCompare(b.faellig || '9999') || a.titel.localeCompare(b.titel, 'de');
  const eingabe = h('input', { class: 'feld', placeholder: 'Neue Aufgabe', 'aria-label': 'Neue Aufgabe', enterkeyhint: 'done', autocapitalize: 'sentences' });
  // Nach jedem Neuzeichnen bleibt das sichtbare Feld erhalten; "eingabe" ist dann nur noch eine unsichtbare Kopie.
  const feldJetzt = () => $('#inhalt .neu input') || eingabe;
  const anlegen = async () => {
    const eingabe = feldJetzt();
    const titel = eingabe.value.trim();
    if (!titel) return;
    eingabe.value = '';
    try { ersetze(filter, null, await speichern(filter, { titel, erledigt: false })); zeichne(); }
    catch (e) { eingabe.value = titel; toast('Nicht gespeichert: ' + e.message); }
  };
  IndibatKern.an(eingabe, 'keydown', (e) => { if (e.key === 'Enter') anlegen(); });
  const erledigtZahl = alle.filter((t) => t.erledigt).length;
  return [
    h('div', { class: 'filter' }, listen.map((l) => h('button', { class: l.href === filter ? 'an' : '', onclick: () => { filter = l.href; lager.schreib('indibat-filter', filter); zeichne(); } }, l.name))),
    h('div', { class: 'segment' },
      h('button', { class: zeigeErledigte ? '' : 'an', onclick: () => { zeigeErledigte = false; zeichne(); } }, `Offen (${alle.length - erledigtZahl})`),
      h('button', { class: zeigeErledigte ? 'an' : '', onclick: () => { zeigeErledigte = true; zeichne(); } }, `Erledigt (${erledigtZahl})`)),
    !zeigeErledigte && h('div', { class: 'neu' }, eingabe,
      h('button', { class: 'knopf flach', 'aria-label': 'Mit Datum, Uhrzeit und Gruppe anlegen', onclick: () => { const f = feldJetzt(); const t = f.value.trim(); f.value = ''; todoBlatt(filter, null, t); } }, 'Details'),
      h('button', { class: 'knopf primaer flach', 'aria-label': 'Hinzufügen', onclick: anlegen }, '+')),
    sichtbar.length ? namen.map((g) => [g || namen.length > 1 ? h('p', { class: 'gruppe' }, g || 'Ohne Gruppe') : null,
      h('div', { class: 'karte' }, gruppen.get(g).sort(ordnung).map((t) => todoZeile(filter, t, false)))]) : h('div', { class: 'karte' }, h('p', { class: 'leer' }, zeigeErledigte ? 'In dieser Liste ist noch nichts erledigt.' : 'Alles erledigt.')),
  ];
}
function todoBlatt(listHref, t, titelVor) {
  const neu = !t;
  const alt = t || { titel: titelVor || '', faellig: null, zeit: null, gruppe: '', notiz: '' };
  const listen = todoListen();
  const titel = h('input', { class: 'feld', value: alt.titel, autocapitalize: 'sentences' });
  const liste = neu && listen.length > 1 ? h('select', { class: 'feld' }, listen.map((l) => h('option', { value: l.href, selected: l.href === listHref }, l.name))) : null;
  const datum = h('input', { class: 'feld', type: 'date', value: alt.faellig || '' });
  const zeit = h('input', { class: 'feld', type: 'time', value: alt.zeit || '' });
  const bekannte = [...new Set(listen.flatMap((l) => daten.aufgaben[l.href] || []).map((x) => x.gruppe).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'de'));
  const gruppe = IndibatKern.vorschlagsliste(h('input', { class: 'feld', value: alt.gruppe || '', placeholder: 'z. B. Website', autocapitalize: 'sentences' }), bekannte);
  const notiz = h('textarea', { class: 'feld', autocapitalize: 'sentences' });
  notiz.value = alt.notiz || '';
  const sichern = async () => {
    if (!titel.value.trim()) { toast('Bitte einen Titel eintragen'); return; }
    const ziel = liste ? liste.value : listHref;
    const felder = { titel: titel.value.trim(), faellig: datum.value || null, zeit: datum.value ? (zeit.value || null) : null, gruppe: gruppe.value.trim(), notiz: notiz.value.trim() };
    if (zeit.value && !datum.value) { toast('Eine Uhrzeit braucht auch ein Datum'); return; }
    try {
      ersetze(ziel, t, await speichern(ziel, neu ? { ...felder, erledigt: false } : felder, t || undefined));
      if (neu) { filter = ziel; lager.schreib('indibat-filter', filter); }
      blattZu(); zeichne();
    } catch (e) { toast('Nicht gespeichert: ' + e.message); }
  };
  const loeschen = async () => {
    if (!confirm(`„${t.titel}“ endgültig löschen?`)) return;
    try { await dav('DELETE', wurzel() + t.href); ersetze(listHref, t, null); blattZu(); zeichne(); }
    catch (e) { toast('Nicht gelöscht: ' + e.message); }
  };
  blatt(neu ? 'Neue Aufgabe' : 'Aufgabe',
    h('label', null, 'Titel', titel), liste && h('label', null, 'Liste', liste),
    h('label', null, 'Fällig am', datum), h('label', null, 'Uhrzeit (optional)', zeit),
    h('label', null, 'Gruppe', gruppe),
    h('label', null, 'Notiz', notiz),
    h('div', { class: 'reihe' }, neu ? h('span', { class: 'links' }) : h('button', { class: 'knopf rot links', onclick: loeschen }, 'Löschen'),
      h('button', { class: 'knopf', onclick: blattZu }, 'Abbrechen'), h('button', { class: 'knopf primaer', onclick: sichern }, neu ? 'Anlegen' : 'Sichern')));
  if (neu && !alt.titel) titel.focus();
}

/* ================= Sicht: Links ================= */
// Gleiche Zeichen wie auf dem Laptop ("glyph:name"). Bilder ("datei:..." und Website-Symbole) liefert der Laptop ueber symbole.json.
const GLYPHEN = {
  ordner: ['#5b8def', 'M3 6h6l2 2h10v11H3z'],
  sprechblase: ['#8e6fd8', 'M4 5h16v11H9l-5 4z'],
  bild: ['#d9822b', 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M3 17l5-5 4 4 3-3 6 6 M17 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z'],
  dashboard: ['#2f9e8f', 'M4 4h7v9H4z M13 4h7v5h-7z M13 11h7v9h-7z M4 15h7v5H4z'],
  beleg: ['#c0504d', 'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6'],
  wuerfel: ['#6b7a90', 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5'],
  blatt: ['#4a9d4f', 'M5 19c0-8 5-13 14-14 0 9-5 14-14 14z M5 19l8-8'],
  welt: ['#3a7bd5', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18'],
  haus: ['#b0763a', 'M4 11l8-7 8 7v9H4z M10 20v-6h4v6'],
  stern: ['#d4a017', 'M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8z'],
  datei: ['#7a8699', 'M7 3h7l4 4v14H7z M14 3v4h4'],
  zahnrad: ['#5f6b7a', 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  schloss: ['#8a6d3b', 'M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
};
function zeichen(e) {
  const sym = daten.symbole || {};
  const s = e.symbol || '';
  const bild = (src) => (/^data:image\//.test(src || '') ? h('img', { class: 'logo', src, alt: '' }) : null);
  if (s.startsWith('glyph:') && GLYPHEN[s.slice(6)]) {
    const [farbe, d] = GLYPHEN[s.slice(6)];
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'glyph');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
    const t = h('span', { class: 'mono' }, svg);
    t.style.background = farbe;
    return t;
  }
  let herkunft = '';
  try { herkunft = new URL(e.url).origin; } catch { /* kein Link */ }
  return (s.startsWith('datei:') && bild(sym[s])) || bild(sym['url:' + herkunft])
    || h('span', { class: 'mono' }, (e.name || '?').trim().charAt(0).toUpperCase());
}
function sichtLinks() {
  const c = daten.config;
  if (!c) return [h('div', { class: 'karte' }, h('p', { class: 'leer' }, 'Die Links kommen aus der Datei „Indibat/indibat.json“ in deiner Nextcloud. Sie wurde noch nicht geladen.'))];
  const gruppen = new Map();
  const dazu = (g, e) => { if (!/^https?:\/\//i.test(e.url || '')) return; if (!gruppen.has(g)) gruppen.set(g, []); gruppen.get(g).push(e); };
  for (const l of c.links) dazu(l.gruppe || 'Links', l);
  for (const l of c.claude) dazu('Claude', l);
  if (!gruppen.size) return [h('div', { class: 'karte' }, h('p', { class: 'leer' }, 'Noch keine Links angelegt. Du pflegst sie am Laptop.'))];
  return [...gruppen].map(([g, eintraege]) => [h('p', { class: 'gruppe' }, g),
    h('div', { class: 'karte' }, eintraege.map((e) => h('a', { class: 'link', href: e.url, target: '_blank', rel: 'noopener noreferrer' },
      zeichen(e),
      h('span', { class: 'ltext' }, h('span', { class: 'lname' }, e.name || e.url), h('span', { class: 'lzusatz' }, e.url.replace(/^https?:\/\//i, '').replace(/\/$/, ''))))))]);
}

/* ================= Einrichtung und Konto ================= */
let einrichtungKarte = null;
function sichtEinrichtung() {
  // Dieselbe Karte bei jedem Neuzeichnen zurueckgeben. Sonst zeigt die Seite die alten Felder,
  // waehrend "Verbinden" leere, unsichtbare Kopien liest - es passiert scheinbar nichts.
  if (einrichtungKarte) return [einrichtungKarte];
  const url = h('input', { class: 'feld', type: 'url', inputmode: 'url', placeholder: 'https://…', autocapitalize: 'off' });
  const login = h('input', { class: 'feld', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false' });
  const pass = h('input', { class: 'feld', type: 'password', autocomplete: 'current-password' });
  const knopf = h('button', { class: 'knopf primaer' }, 'Verbinden');
  const meldung = h('p', { class: 'fehler', role: 'alert', hidden: true });
  const melde = (t) => { meldung.textContent = t; meldung.hidden = !t; };
  IndibatKern.an(knopf, 'click', async () => {
    let adresse = url.value.trim().replace(/\/+$/, '');
    melde('');
    if (!/^https:\/\//i.test(adresse)) { melde('Die Adresse muss mit https:// beginnen.'); return; }
    if (!login.value.trim() || !pass.value) { melde('Anmeldename und App-Passwort fehlen.'); return; }
    const wieAppPasswort = /^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){4}$/.test(pass.value.trim());
    knopf.disabled = true; knopf.textContent = 'Prüfe …';
    konto = { url: adresse, login: login.value.trim(), pass: pass.value.trim(), user: '' };
    try {
      konto.user = await benutzerErmitteln();
      if (!konto.user) throw new Error('Benutzer nicht gefunden');
      lager.schreib('indibat-konto', konto);
      einrichtungKarte = null; // Passwort nicht im Speicher behalten
      zeichne(); laden();
    } catch (e) {
      konto = null;
      melde(e.netz ? 'Keine Antwort von der Nextcloud. Nach mehreren Fehlversuchen bremst sie Anmeldungen für einige Minuten – warte kurz und versuche es dann erneut. Sonst prüfe die Adresse und ob diese Seite in „WebAppPassword“ erlaubt ist.'
        : e.status === 401 ? 'Die Nextcloud lehnt Anmeldename oder Passwort ab. ' + (wieAppPasswort ? 'Prüfe den Anmeldenamen: Er steht beim Erstellen des App-Passworts direkt über dem Passwort.' : 'Das eingegebene Passwort hat nicht die Form eines App-Passworts (fünf Gruppen mit je fünf Zeichen, durch Bindestriche getrennt). Dein normales Passwort funktioniert hier nicht.')
        : e.message);
      knopf.disabled = false; knopf.textContent = 'Verbinden';
    }
  });
  einrichtungKarte = h('div', { class: 'karte', 'data-k': 'einrichtung' },
    h('p', { class: 'kopf' }, 'Mit deiner Nextcloud verbinden'),
    h('label', null, 'Adresse der Nextcloud', url), h('label', null, 'Anmeldename', login), h('label', null, 'App-Passwort', pass),
    h('p', { class: 'klein' }, 'Lege das App-Passwort in der Nextcloud unter Einstellungen → Sicherheit → „Geräte & Sitzungen“ an, nicht dein normales Passwort. Es bleibt nur auf diesem Handy und lässt sich dort jederzeit einzeln widerrufen.'),
    meldung, h('div', { class: 'reihe' }, knopf));
  return [einrichtungKarte];
}
function kontoBlatt() {
  if (!konto) return;
  blatt('Konto',
    h('p', { class: 'klein' }, `${konto.login} · ${konto.url.replace(/^https:\/\//, '')}`),
    h('p', { class: 'klein' }, daten.stand ? `Letzter Abgleich: ${new Date(daten.stand).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}` : 'Noch nicht abgeglichen'),
    h('div', { class: 'reihe' },
      h('button', { class: 'knopf rot links', onclick: () => {
        if (!confirm('Abmelden? Zugangsdaten und der gespeicherte Stand werden von diesem Handy gelöscht.')) return;
        lager.weg('indibat-konto'); lager.weg('indibat-daten'); lager.weg('indibat-filter');
        konto = null; daten = { listen: [], aufgaben: {}, config: null, symbole: {}, stand: 0 };
        blattZu(); zeichne();
      } }, 'Abmelden'),
      h('button', { class: 'knopf', onclick: blattZu }, 'Schließen')));
}

/* ================= Rahmen ================= */
const TITEL = { heute: 'Heute', taeglich: 'Täglich', aufgaben: 'Aufgaben', pool: 'Pool', links: 'Links' };
function zeichne() {
  const eingerichtet = !!konto;
  document.querySelector('nav').hidden = !eingerichtet;
  $('#btn-neu-laden').hidden = !eingerichtet;
  $('#btn-konto').hidden = !eingerichtet;
  $('#titel').textContent = eingerichtet ? TITEL[sicht] : 'Indibat';
  $('#datum').textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  // Auf „Heute“ geht das grüne Kopfband nahtlos in die Gebetskarte über.
  document.body.classList.toggle('auf-heute', eingerichtet && sicht === 'heute');
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('an', b.dataset.sicht === sicht);
  const aktiv = document.activeElement;
  if (eingerichtet && sicht === 'aufgaben' && aktiv && aktiv.matches('.neu input') && aktiv.value) return; // Eingabe nicht wegreissen
  if (blattNeu && !$('#blatt').hidden) { const y = ($('.blatt-box') || {}).scrollTop || 0; blattAuffrischen = true; try { blattNeu(); } finally { blattAuffrischen = false; } const box = $('.blatt-box'); if (box) box.scrollTop = y; }
  fuelle($('#inhalt'), !eingerichtet ? sichtEinrichtung() : sicht === 'heute' ? sichtHeute() : sicht === 'taeglich' ? sichtTaeglich() : sicht === 'aufgaben' ? sichtAufgaben() : sicht === 'pool' ? sichtPool() : sichtLinks());
}
for (const b of document.querySelectorAll('nav button')) b.addEventListener('click', () => wechsle(b.dataset.sicht));
const REIHE = ['heute', 'taeglich', 'aufgaben', 'pool', 'links'];
function wechsle(ziel) {
  const von = REIHE.indexOf(sicht);
  const nach = REIHE.indexOf(ziel);
  if (nach < 0 || nach === von) return;
  sicht = ziel; zeichne();
  const m = $('#inhalt');
  m.scrollTop = 0;
  m.classList.remove('von-rechts', 'von-links');
  void m.offsetWidth; // Animation neu starten
  m.classList.add(nach > von ? 'von-rechts' : 'von-links');
}
// Wischen: Der Inhalt haengt am Finger. Loslassen nach einem Viertel der Breite (oder mit Schwung) wechselt, sonst federt er zurueck.
const M = $('#inhalt');
let wisch = null;
M.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  wisch = e.touches.length === 1 && konto && !e.target.closest('.filter, input, textarea, select, .kal') ? { x: t.clientX, y: t.clientY, t: Date.now(), quer: null, dx: 0 } : null;
}, { passive: true });
M.addEventListener('touchmove', (e) => {
  if (!wisch) return;
  const dx = e.touches[0].clientX - wisch.x;
  const dy = e.touches[0].clientY - wisch.y;
  if (wisch.quer === null) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    wisch.quer = Math.abs(dx) > Math.abs(dy);
    if (wisch.quer) { M.classList.remove('von-rechts', 'von-links'); M.style.transition = 'none'; }
  }
  if (!wisch.quer) return;
  const n = REIHE.indexOf(sicht);
  const amRand = (dx > 0 && n === 0) || (dx < 0 && n === REIHE.length - 1);
  wisch.dx = amRand ? dx / 4 : dx; // am Rand nur zaeh nachgeben
  M.style.transform = `translateX(${wisch.dx}px)`;
  M.style.opacity = String(1 - Math.min(0.5, Math.abs(wisch.dx) / (M.clientWidth * 1.5)));
}, { passive: true });
function wischEnde() {
  if (!wisch) return;
  const w = wisch;
  wisch = null;
  if (!w.quer) return;
  const breite = M.clientWidth;
  const tempo = Math.abs(w.dx) / Math.max(1, Date.now() - w.t); // Pixel je Millisekunde
  const ziel = REIHE[REIHE.indexOf(sicht) + (w.dx < 0 ? 1 : -1)];
  const weiter = ziel && (Math.abs(w.dx) > breite * 0.25 || (tempo > 0.35 && Math.abs(w.dx) > 24));
  M.style.transition = 'transform .15s ease-out, opacity .15s ease-out';
  if (!weiter) { M.style.transform = ''; M.style.opacity = ''; return; }
  const richtung = w.dx < 0 ? -1 : 1;
  M.style.transform = `translateX(${richtung * breite}px)`;
  M.style.opacity = '0';
  setTimeout(() => {
    sicht = ziel; zeichne(); M.scrollTop = 0;
    M.style.transition = 'none';
    M.style.transform = `translateX(${-richtung * breite * 0.4}px)`;
    void M.offsetWidth;
    M.style.transition = 'transform .22s cubic-bezier(.2, .8, .2, 1), opacity .22s ease-out';
    M.style.transform = ''; M.style.opacity = '';
  }, 140);
}
M.addEventListener('touchend', wischEnde, { passive: true });
M.addEventListener('touchcancel', wischEnde, { passive: true });
$('#btn-neu-laden').addEventListener('click', () => laden(false));
$('#btn-konto').addEventListener('click', kontoBlatt);
$('#blatt').addEventListener('click', (e) => { if (e.target.id === 'blatt') blattZu(); });

let letztesGebet = '';
setInterval(() => {
  if (!konto || sicht !== 'heute' || !$('#blatt').hidden) return;
  const n = naechstesGebet();
  const id = n ? n.uid : '';
  const c = $('#countdown');
  const minute = new Date().getMinutes();
  if (id !== letztesGebet) { letztesGebet = id; zeichne(); }
  else if (gebetAnsicht === 'uhr' && minute !== letzteMinute) { letzteMinute = minute; zeichne(); } // Uhr: Punkt „jetzt“ rückt weiter
  else if (c && n) c.textContent = restText(zeitpunkt(n));
}, 1000);
let letzteMinute = -1;
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - daten.stand > 60000) laden(true); });

zeichne();
laden(true);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
