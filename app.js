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
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kinder.flat(Infinity)) if (k != null && k !== false) e.append(k);
  return e;
}
const fuelle = (el, ...kinder) => el.replaceChildren(...kinder.flat(Infinity).filter((k) => k != null && k !== false));
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
function blatt(titel, ...inhalt) {
  const b = $('#blatt');
  fuelle(b, h('div', { class: 'blatt-box' }, h('h3', null, titel), inhalt));
  b.hidden = false;
}
const blattZu = () => { $('#blatt').hidden = true; fuelle($('#blatt')); };

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
    daten = { listen, aufgaben, config, symbole, stand: Date.now() };
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
  return h('div', { class: 'todo' + (t.erledigt ? ' fertig' : '') },
    h('button', { class: 'kreis' + (t.erledigt ? ' an' : ''), 'aria-label': t.erledigt ? 'Wieder öffnen' : 'Abhaken', onclick: () => umschalten(listHref, t) }, t.erledigt ? '✓' : ''),
    h('button', { class: 'todo-text', onclick: () => todoBlatt(listHref, t) },
      h('span', { class: 'titel' }, t.titel || '(ohne Titel)'),
      meta && h('span', { class: 'meta' + (spaet ? ' spaet' : '') }, meta)));
}
function sichtHeute() {
  const heute = ymd(tagVersetzt(0));
  const liste = gebeteAm(heute);
  const naechstes = naechstesGebet();
  const jetzt = new Date();
  const laufend = [...liste].reverse().find((t) => zeitpunkt(t) <= jetzt);
  const out = [];
  if (!gebetsHref() || !liste.length) {
    out.push(h('div', { class: 'karte' }, h('p', { class: 'kopf' }, 'Gebete'),
      h('p', { class: 'leer' }, 'Für heute liegen keine Gebetszeiten in der Nextcloud. Der Laptop trägt sie 14 Tage im Voraus ein – starte Indibat dort einmal.')));
  } else {
    const woche = [];
    for (let i = -6; i <= 0; i++) {
      const d = tagVersetzt(i);
      const g = gebeteAm(ymd(d));
      woche.push(h('div', { class: 'tag' + (i === 0 ? ' heute' : '') }, WOCHENTAGE[d.getDay()],
        h('div', { class: 'punkte' }, g.length ? g.map((t) => h('span', { class: 'punkt' + (t.erledigt ? ' an' : '') })) : h('span', { class: 'punkt' }))));
    }
    out.push(h('div', { class: 'karte' },
      h('p', { class: 'kopf' }, 'Nächstes Gebet'),
      naechstes ? [h('div', { class: 'naechstes' }, h('span', { class: 'name' }, naechstes.titel), h('span', { class: 'uhr' }, naechstes.zeit)),
        h('p', { id: 'countdown' }, restText(zeitpunkt(naechstes)))] : h('p', { class: 'leer' }, 'Keine weiteren Zeiten eingetragen.'),
      liste.map((t) => h('button', { class: 'zeile' + (t.erledigt ? ' fertig' : '') + (laufend && t.uid === laufend.uid ? ' jetzt' : ''), onclick: () => umschalten(gebetsHref(), t) },
        h('span', { class: 'kreis' + (t.erledigt ? ' an' : '') }, t.erledigt ? '✓' : ''), h('span', { class: 'name' }, t.titel), h('span', { class: 'zeit' }, t.zeit))),
      h('div', { class: 'woche' }, woche)));
    if (new Date().getDay() === 4) out.push(h('div', { class: 'karte' }, h('p', { class: 'kopf' }, 'Donnerstag'), h('p', null, 'Heute Abend ist Dhikr.')));
  }
  const faellig = [];
  for (const l of todoListen()) for (const t of daten.aufgaben[l.href] || []) if (!t.erledigt && t.faellig && t.faellig <= heute) faellig.push([l.href, t]);
  faellig.sort((a, b) => a[1].faellig.localeCompare(b[1].faellig));
  out.push(h('div', { class: 'karte' }, h('p', { class: 'kopf' }, 'Heute fällig'),
    faellig.length ? faellig.map(([href, t]) => todoZeile(href, t, true)) : h('p', { class: 'leer' }, 'Nichts fällig.')));
  return out;
}

/* ================= Sicht: Aufgaben ================= */
function sichtAufgaben() {
  const listen = todoListen();
  if (!listen.length) return [h('div', { class: 'karte' }, h('p', { class: 'leer' }, 'Noch keine Aufgabenlisten gefunden.'))];
  if (!listen.some((l) => l.href === filter)) filter = listen[0].href;
  const alle = daten.aufgaben[filter] || [];
  const sichtbar = alle.filter((t) => zeigeErledigte || !t.erledigt);
  const gruppen = new Map();
  for (const t of sichtbar) { const g = t.gruppe || ''; if (!gruppen.has(g)) gruppen.set(g, []); gruppen.get(g).push(t); }
  const namen = [...gruppen.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'de')));
  const ordnung = (a, b) => (a.erledigt - b.erledigt) || (a.faellig || '9999').localeCompare(b.faellig || '9999') || a.titel.localeCompare(b.titel, 'de');
  const eingabe = h('input', { class: 'feld', placeholder: 'Neue Aufgabe', 'aria-label': 'Neue Aufgabe', enterkeyhint: 'done' });
  const anlegen = async () => {
    const titel = eingabe.value.trim();
    if (!titel) return;
    eingabe.value = '';
    try { ersetze(filter, null, await speichern(filter, { titel, erledigt: false })); zeichne(); }
    catch (e) { eingabe.value = titel; toast('Nicht gespeichert: ' + e.message); }
  };
  eingabe.addEventListener('keydown', (e) => { if (e.key === 'Enter') anlegen(); });
  const erledigtZahl = alle.filter((t) => t.erledigt).length;
  return [
    h('div', { class: 'filter' }, listen.map((l) => h('button', { class: l.href === filter ? 'an' : '', onclick: () => { filter = l.href; lager.schreib('indibat-filter', filter); zeichne(); } }, l.name))),
    h('div', { class: 'neu' }, eingabe, h('button', { class: 'knopf primaer flach', 'aria-label': 'Hinzufügen', onclick: anlegen }, '+')),
    sichtbar.length ? namen.map((g) => [g || namen.length > 1 ? h('p', { class: 'gruppe' }, g || 'Ohne Gruppe') : null,
      h('div', { class: 'karte' }, gruppen.get(g).sort(ordnung).map((t) => todoZeile(filter, t, false)))]) : h('div', { class: 'karte' }, h('p', { class: 'leer' }, 'Alles erledigt.')),
    erledigtZahl ? h('button', { class: 'knopf', onclick: () => { zeigeErledigte = !zeigeErledigte; zeichne(); } }, zeigeErledigte ? 'Erledigte ausblenden' : `Erledigte anzeigen (${erledigtZahl})`) : null,
  ];
}
function todoBlatt(listHref, t) {
  const titel = h('input', { class: 'feld', value: t.titel });
  const datum = h('input', { class: 'feld', type: 'date', value: t.faellig || '' });
  const zeit = h('input', { class: 'feld', type: 'time', value: t.zeit || '' });
  const bekannte = [...new Set((daten.aufgaben[listHref] || []).map((x) => x.gruppe).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const gruppe = h('input', { class: 'feld', value: t.gruppe || '', list: 'gruppen-liste', placeholder: 'z. B. Website' });
  const notiz = h('textarea', { class: 'feld' });
  notiz.value = t.notiz || '';
  const sichern = async () => {
    if (!titel.value.trim()) { toast('Bitte einen Titel eintragen'); return; }
    try {
      ersetze(listHref, t, await speichern(listHref, { titel: titel.value.trim(), faellig: datum.value || null, zeit: datum.value ? (zeit.value || null) : null, gruppe: gruppe.value.trim(), notiz: notiz.value.trim() }, t));
      blattZu(); zeichne();
    } catch (e) { toast('Nicht gespeichert: ' + e.message); }
  };
  const loeschen = async () => {
    if (!confirm(`„${t.titel}“ endgültig löschen?`)) return;
    try { await dav('DELETE', wurzel() + t.href); ersetze(listHref, t, null); blattZu(); zeichne(); }
    catch (e) { toast('Nicht gelöscht: ' + e.message); }
  };
  blatt('Aufgabe',
    h('label', null, 'Titel', titel), h('label', null, 'Fällig am', datum), h('label', null, 'Uhrzeit (optional)', zeit),
    h('label', null, 'Gruppe', gruppe), h('datalist', { id: 'gruppen-liste' }, bekannte.map((g) => h('option', { value: g }))),
    h('label', null, 'Notiz', notiz),
    h('div', { class: 'reihe' }, h('button', { class: 'knopf rot links', onclick: loeschen }, 'Löschen'), h('button', { class: 'knopf', onclick: blattZu }, 'Abbrechen'), h('button', { class: 'knopf primaer', onclick: sichern }, 'Sichern')));
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
  zahnrad: ['#5f6b7a', 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3 M5.3 5.3l2.1 2.1 M16.6 16.6l2.1 2.1 M5.3 18.7l2.1-2.1 M16.6 7.4l2.1-2.1'],
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
function sichtEinrichtung() {
  const url = h('input', { class: 'feld', type: 'url', inputmode: 'url', placeholder: 'https://…', autocapitalize: 'off' });
  const login = h('input', { class: 'feld', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false' });
  const pass = h('input', { class: 'feld', type: 'password', autocomplete: 'current-password' });
  const knopf = h('button', { class: 'knopf primaer' }, 'Verbinden');
  const meldung = h('p', { class: 'fehler', role: 'alert', hidden: true });
  const melde = (t) => { meldung.textContent = t; meldung.hidden = !t; };
  knopf.addEventListener('click', async () => {
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
      zeichne(); laden();
    } catch (e) {
      konto = null;
      melde(e.netz ? 'Keine Antwort von der Nextcloud. Nach mehreren Fehlversuchen bremst sie Anmeldungen für einige Minuten – warte kurz und versuche es dann erneut. Sonst prüfe die Adresse und ob diese Seite in „WebAppPassword“ erlaubt ist.'
        : e.status === 401 ? 'Die Nextcloud lehnt Anmeldename oder Passwort ab. ' + (wieAppPasswort ? 'Prüfe den Anmeldenamen: Er steht beim Erstellen des App-Passworts direkt über dem Passwort.' : 'Das eingegebene Passwort hat nicht die Form eines App-Passworts (fünf Gruppen mit je fünf Zeichen, durch Bindestriche getrennt). Dein normales Passwort funktioniert hier nicht.')
        : e.message);
      knopf.disabled = false; knopf.textContent = 'Verbinden';
    }
  });
  return [h('div', { class: 'karte' },
    h('p', { class: 'kopf' }, 'Mit deiner Nextcloud verbinden'),
    h('label', null, 'Adresse der Nextcloud', url), h('label', null, 'Anmeldename', login), h('label', null, 'App-Passwort', pass),
    h('p', { class: 'klein' }, 'Lege das App-Passwort in der Nextcloud unter Einstellungen → Sicherheit → „Geräte & Sitzungen“ an, nicht dein normales Passwort. Es bleibt nur auf diesem Handy und lässt sich dort jederzeit einzeln widerrufen.'),
    meldung, h('div', { class: 'reihe' }, knopf))];
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
const TITEL = { heute: 'Heute', aufgaben: 'Aufgaben', links: 'Links' };
function zeichne() {
  const eingerichtet = !!konto;
  document.querySelector('nav').hidden = !eingerichtet;
  $('#btn-neu-laden').hidden = !eingerichtet;
  $('#btn-konto').hidden = !eingerichtet;
  $('#titel').textContent = eingerichtet ? TITEL[sicht] : 'Indibat';
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('an', b.dataset.sicht === sicht);
  const aktiv = document.activeElement;
  if (eingerichtet && sicht === 'aufgaben' && aktiv && aktiv.matches('.neu input') && aktiv.value) return; // Eingabe nicht wegreissen
  fuelle($('#inhalt'), !eingerichtet ? sichtEinrichtung() : sicht === 'heute' ? sichtHeute() : sicht === 'aufgaben' ? sichtAufgaben() : sichtLinks());
}
for (const b of document.querySelectorAll('nav button')) b.addEventListener('click', () => { sicht = b.dataset.sicht; zeichne(); $('#inhalt').scrollTop = 0; });
$('#btn-neu-laden').addEventListener('click', () => laden(false));
$('#btn-konto').addEventListener('click', kontoBlatt);
$('#blatt').addEventListener('click', (e) => { if (e.target.id === 'blatt') blattZu(); });

let letztesGebet = '';
setInterval(() => {
  if (!konto || sicht !== 'heute' || !$('#blatt').hidden) return;
  const n = naechstesGebet();
  const id = n ? n.uid : '';
  const c = $('#countdown');
  if (id !== letztesGebet) { letztesGebet = id; zeichne(); } else if (c && n) c.textContent = restText(zeitpunkt(n));
}, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - daten.stand > 60000) laden(true); });

zeichne();
laden(true);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
