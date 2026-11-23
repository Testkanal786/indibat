'use strict';
// Indibat fürs Handy - Reiter "Täglich": Gewohnheiten, zwei Ringe für heute, Raster für den Verlauf.
// Rechnet mit kern.js (dieselbe Datei wie auf dem Laptop). Daten: Indibat/taeglich.json und Indibat/gebete-JJJJ.json.
/* global IndibatKern, h, fuelle, $, blatt, blattZu, toast, lager, daten, konto, wurzel, auth, zeichne, umschalten, gebeteAm, gebetsHref, merken, WOCHENTAGE */
const K = IndibatKern;
let rasterModus = lager.lies('indibat-modus') || 'beides';
let rasterJahr = false;
const heuteT = () => K.ymd(new Date());

/* ---------- Dateien in der Nextcloud ---------- */
const dateiUrl = (name) => `${wurzel()}/remote.php/dav/files/${encodeURIComponent(konto.user)}/Indibat/${encodeURIComponent(name)}`;
async function dateiLesen(name, leer) {
  let r;
  try { r = await fetch(dateiUrl(name), { headers: { Authorization: auth() }, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20000) }); }
  catch { throw new Error('Keine Verbindung zur Nextcloud'); }
  if (r.status === 404) return { daten: leer(), etag: null };
  if (!r.ok) throw new Error(`${name}: Fehler ${r.status}`);
  // Die Nextcloud liefert eine "schwache" Kennung (W/"..."); für If-Match braucht es die starke Form.
  return { daten: JSON.parse(await r.text()), etag: (r.headers.get('etag') || '').replace(/^W\//, '') || null };
}
// Lesen, ändern, zurückschreiben. Hat der Laptop dazwischen gespeichert, meldet die Nextcloud 412 und es geht mit dem frischen Stand von vorn los.
async function dateiAendern(name, leer, aendern) {
  for (let i = 0; i < 4; i++) {
    const { daten: d, etag } = await dateiLesen(name, leer);
    aendern(d);
    const headers = { Authorization: auth(), 'Content-Type': 'application/json; charset=utf-8' };
    if (etag) headers['If-Match'] = etag; else headers['If-None-Match'] = '*';
    let r;
    try { r = await fetch(dateiUrl(name), { method: 'PUT', headers, body: JSON.stringify(d), credentials: 'omit', signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error('Keine Verbindung zur Nextcloud'); }
    if (r.status === 412) continue;
    if (!r.ok) throw new Error(`${name}: Fehler ${r.status}`);
    return d;
  }
  throw new Error('Gleichzeitige Änderung, bitte noch einmal versuchen');
}
// Wird von laden() aufgerufen.
async function taeglichLaden() {
  const j = new Date().getFullYear();
  const [t, a1, a2] = await Promise.all([
    dateiLesen('taeglich.json', K.leer),
    dateiLesen(K.archivName(j - 1), () => K.archivLeer(j - 1)),
    dateiLesen(K.archivName(j), () => K.archivLeer(j)),
  ]);
  return { taeglich: K.normalisieren(t.daten), archiv: { [j - 1]: a1.daten.tage || {}, [j]: a2.daten.tage || {} } };
}
const tdaten = () => K.normalisieren(daten.taeglich || K.leer());
// Sofort zeigen, im Hintergrund speichern. Mehrere schnelle Tipper werden nacheinander gesichert;
// erst wenn alle durch sind, wird der Stand aus der Nextcloud übernommen. Schlägt etwas fehl, wird neu geladen.
let speicherKette = Promise.resolve();
let speichertNoch = 0;
async function aendern(art, args) {
  args = { heute: heuteT(), ...args };
  if (art === 'speichern' && !args.gewohnheit.id) args.gewohnheit = { ...args.gewohnheit, id: K.neueId() };
  const lokal = K.normalisieren(JSON.parse(JSON.stringify(daten.taeglich || K.leer())));
  K.ops[art](lokal, args);
  daten.taeglich = lokal;
  merken();
  zeichne();
  speichertNoch++;
  speicherKette = speicherKette.then(async () => {
    try {
      const d = await dateiAendern('taeglich.json', K.leer, (x) => { K.normalisieren(x); K.ops[art](x, args); });
      if (--speichertNoch === 0) { daten.taeglich = K.normalisieren(d); merken(); zeichne(); }
    } catch (e) {
      speichertNoch--;
      toast('Nicht gespeichert: ' + e.message);
      try { daten.taeglich = (await taeglichLaden()).taeglich; merken(); zeichne(); } catch { /* bleibt beim letzten Stand */ }
    }
  });
  return true;
}

/* ---------- Gebete eines Tages ---------- */
// Gibt es für den Tag Aufgaben in der Liste "Gebete" (7 Tage zurück bis 13 voraus), gelten sie; sonst das Archiv.
function gebetAufgaben(tag) {
  const out = {};
  for (const t of gebeteAm(tag)) { const k = t.uid.split('-').pop(); out[k] = t; }
  return out;
}
function gebeteWerte(tag) {
  const a = gebetAufgaben(tag);
  if (Object.keys(a).length) return Object.fromEntries(K.GEBETE.map((k) => [k, !!(a[k] && a[k].erledigt)]));
  const arch = (daten.archiv || {})[tag.slice(0, 4)] || {};
  return arch[tag] || null;
}
async function gebetSetzen(tag, key) {
  const t = gebetAufgaben(tag)[key];
  if (t) { await umschalten(gebetsHref(), t); return; }
  const jahr = tag.slice(0, 4);
  const alt = (gebeteWerte(tag) || {})[key];
  // sofort zeigen
  if (!daten.archiv) daten.archiv = {};
  if (!daten.archiv[jahr]) daten.archiv[jahr] = {};
  const vorher = daten.archiv[jahr][tag];
  daten.archiv[jahr][tag] = { ...Object.fromEntries(K.GEBETE.map((k) => [k, false])), ...(vorher || {}), [key]: !alt };
  zeichne();
  try {
    const a = await dateiAendern(K.archivName(jahr), () => K.archivLeer(Number(jahr)), (x) => { if (!x.tage) x.tage = {}; K.archivOps.gebet(x, { tag, key, wert: !alt }); });
    if (!daten.archiv) daten.archiv = {};
    daten.archiv[jahr] = a.tage;
    merken();
  } catch (e) { daten.archiv[jahr][tag] = vorher; toast('Nicht gespeichert: ' + e.message); }
  zeichne();
}

/* ---------- Bausteine ---------- */
// Design A1: ein Doppelring (aussen Gebete, innen Gewohnheiten) mit den Zahlen daneben.
const DR_NS = 'http://www.w3.org/2000/svg';
function drKreis(r, anteil, klasse) {
  const c = document.createElementNS(DR_NS, 'circle');
  for (const [k, v] of Object.entries({ cx: 48, cy: 48, r, class: klasse, transform: 'rotate(-90 48 48)' })) c.setAttribute(k, v);
  if (anteil != null) {
    const u = 2 * Math.PI * r;
    c.style.strokeDasharray = `${(u * Math.max(0, Math.min(1, anteil))).toFixed(2)}px ${u.toFixed(2)}px`; // als Stil, damit der Übergang greift
    if (!(anteil > 0)) c.setAttribute('stroke-opacity', '0');
  }
  return c;
}
function ringe() {
  const heute = heuteT();
  const gi = K.gebeteIst(gebeteWerte(heute));
  const gw = K.tagGewohnheiten(tdaten(), heute);
  const s = document.createElementNS(DR_NS, 'svg');
  s.setAttribute('viewBox', '0 0 96 96');
  s.setAttribute('class', 'doppelring');
  s.append(drKreis(42, null, 'dr-spur'), drKreis(42, gi / 5, 'dr-wert dr-gebete'), drKreis(29, null, 'dr-spur'), drKreis(29, gw.soll ? gw.ist / gw.soll : 0, 'dr-wert dr-gew'));
  return h('div', { class: 'ringe' }, s,
    h('span', { class: 'dr-legende' },
      h('span', { class: 'dr-zeile' }, h('span', { class: 'dr-zahl' }, `${gi}/5`), h('span', { class: 'dr-name dr-n-gebete' }, 'Gebete')),
      h('span', { class: 'dr-zeile' }, h('span', { class: 'dr-zahl' }, gw.soll ? `${gw.liste.filter((e) => e.anteil >= 1).length}/${gw.soll}` : '–'), h('span', { class: 'dr-name dr-n-gew' }, 'Gewohnheiten'))));
}
// Goldene Karte für „Heute“: Doppelring und die Gewohnheiten von heute.
function taeglichKarte() {
  const heute = heuteT();
  const gw = K.tagGewohnheiten(tdaten(), heute);
  return h('section', { class: 'karte gold' },
    h('div', { class: 'karten-kopf' }, h('span', { class: 'kopf' }, 'Täglich'), h('button', { class: 'textlink', onclick: () => wechsle('taeglich') }, '12 Wochen ›')),
    ringe(),
    gw.liste.length ? gw.liste.map((e) => gewohnheitZeile(e, heute)) : h('p', { class: 'leer' }, 'Heute ist keine Gewohnheit fällig.'));
}
// Zeile einer Gewohnheit. Antippen hakt ab oder zählt hoch; beim Zähler zählt gedrückt halten oder "−" eins herunter.
function gewohnheitZeile(e, tag) {
  const { g } = e;
  const fertig = e.anteil >= 1;
  const weniger = () => aendern('zaehlen', { tag, id: g.id, schritt: -1 });
  let halten = 0;
  let gehalten = false;
  const los = h('button', { class: 'gew-los',
    onclick: () => { if (gehalten) { gehalten = false; return; } if (g.art === 'zaehler') aendern('zaehlen', { tag, id: g.id, schritt: 1 }); else aendern('wert', { tag, id: g.id, wert: !e.wert }); },
  },
  g.art === 'zaehler' ? h('span', { class: 'zaehler' + (fertig ? ' an' : '') }, `${e.wert}/${g.ziel}`) : h('span', { class: 'kreis' + (fertig ? ' an' : '') }, fertig ? '✓' : ''),
  h('span', { class: 'gname' }, g.name));
  if (g.art === 'zaehler') {
    K.an(los, 'touchstart', () => { halten = setTimeout(() => { gehalten = true; if (navigator.vibrate) navigator.vibrate(15); weniger(); }, 550); }, { passive: true });
    for (const ev of ['touchend', 'touchmove', 'touchcancel']) K.an(los, ev, () => clearTimeout(halten), { passive: true });
    K.an(los, 'contextmenu', (ev) => ev.preventDefault());
  }
  return h('div', { class: 'gew-zeile' + (fertig ? ' fertig' : ''), 'data-k': g.id + tag }, los,
    g.art === 'zaehler' && h('button', { class: 'mini', 'aria-label': 'Eins weniger', onclick: weniger }, '−'),
    h('button', { class: 'mini', 'aria-label': 'Bearbeiten', onclick: () => gewohnheitBlatt(g) }, '⋯'));
}

/* ---------- Reiter ---------- */
function sichtTaeglich() {
  const d = tdaten();
  const heute = heuteT();
  const gw = K.tagGewohnheiten(d, heute);
  const aktiv = d.gewohnheiten.filter((g) => !g.archiviert);
  const archiviert = d.gewohnheiten.filter((g) => g.archiviert);
  const raster = K.raster({ wochen: rasterJahr ? 53 : 12, heute, klein: rasterJahr, antippen: tagBlatt,
    wert: (tag) => K.tagesAnteil(rasterModus, gebeteWerte(tag), K.tagGewohnheiten(d, tag)) });
  return [
    h('div', { class: 'karte gold' }, ringe(),
      gw.liste.length ? gw.liste.map((e) => gewohnheitZeile(e, heute))
        : h('p', { class: 'leer mitte' }, aktiv.length ? 'Heute ist keine Gewohnheit fällig.' : 'Noch keine Gewohnheit angelegt.'),
      h('div', { class: 'reihe' }, h('button', { class: 'knopf primaer voll', onclick: () => gewohnheitBlatt(null) }, '+ Gewohnheit'))),
    h('div', { class: 'karte' },
      h('div', { class: 'segment drei' }, [['beides', 'Beides'], ['gebete', 'Gebete'], ['gewohnheiten', 'Gewohnheiten']].map(([m, t]) =>
        h('button', { class: rasterModus === m ? 'an' : '', onclick: () => { rasterModus = m; lager.schreib('indibat-modus', m); zeichne(); } }, t))),
      raster,
      h('p', { class: 'klein' }, 'Je kräftiger ein Kästchen, desto mehr war erledigt. Antippen zum Nachtragen.'),
      h('div', { class: 'reihe' },
        archiviert.length ? h('button', { class: 'knopf links', onclick: archivBlatt }, `Archiv (${archiviert.length})`) : h('span', { class: 'links' }),
        h('button', { class: 'knopf', onclick: () => { rasterJahr = !rasterJahr; zeichne(); if (rasterJahr) requestAnimationFrame(() => { const r = $('.kal'); if (r) r.scrollLeft = r.scrollWidth; }); } }, rasterJahr ? '12 Wochen' : 'Ganzes Jahr'))),
  ];
}

function tagBlatt(tag) {
  const zeichnen = () => {
    const d = K.datum(tag);
    const teile = [];
    if (rasterModus !== 'gewohnheiten') {
      const w = gebeteWerte(tag) || {};
      teile.push(h('p', { class: 'kopf' }, 'Gebete'), h('div', { class: 'gtag-reihe' }, K.GEBETE.map((k) => h('button', { class: 'gknopf', onclick: () => gebetSetzen(tag, k) },
        h('span', { class: 'kreis' + (w[k] ? ' an' : '') }, w[k] ? '✓' : ''),
        h('span', { class: 'gname' }, k === 'dhuhr' && d.getDay() === 5 ? "Jumu'a" : k.charAt(0).toUpperCase() + k.slice(1))))));
    }
    if (rasterModus !== 'gebete') {
      const gw = K.tagGewohnheiten(tdaten(), tag);
      teile.push(h('p', { class: 'kopf abstand' }, 'Gewohnheiten'),
        gw.liste.length ? h('div', { class: 'karte' }, gw.liste.map((e) => gewohnheitZeile(e, tag))) : h('p', { class: 'leer' }, 'An diesem Tag war keine Gewohnheit fällig.'));
    }
    const wahl = h('input', { class: 'feld', type: 'date', value: tag, max: heuteT() });
    K.an(wahl, 'change', (e) => { if (e.target.value) tagBlatt(e.target.value); });
    blatt(`${WOCHENTAGE[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`, teile,
      h('label', null, 'Anderes Datum …', wahl),
      h('div', { class: 'reihe' }, h('span', { class: 'links' }), h('button', { class: 'knopf primaer', onclick: blattZu }, 'Fertig')));
    blattNeu = zeichnen; // eslint-disable-line no-global-assign
  };
  zeichnen();
}

function gewohnheitBlatt(g) {
  const name = h('input', { class: 'feld', value: g ? g.name : '', placeholder: 'z. B. Quran lesen', autocapitalize: 'sentences' });
  const art = h('select', { class: 'feld' }, h('option', { value: 'haken' }, 'Abhaken'), h('option', { value: 'zaehler' }, 'Zählen mit Ziel'));
  art.value = g ? g.art : 'haken';
  const ziel = h('input', { class: 'feld', type: 'number', inputmode: 'numeric', min: '1', value: String(g && g.ziel ? g.ziel : 8) });
  const zielZeile = h('label', null, 'Ziel pro Tag', ziel);
  const zeigeZiel = () => { zielZeile.hidden = art.value !== 'zaehler'; };
  K.an(art, 'change', zeigeZiel);
  zeigeZiel();
  const tage = new Set(g ? g.regeln[g.regeln.length - 1].tage : [0, 1, 2, 3, 4, 5, 6]);
  const chips = h('div', { class: 'tage-wahl' }, [1, 2, 3, 4, 5, 6, 0].map((t) => {
    const b = h('button', { class: tage.has(t) ? 'an' : '' }, WOCHENTAGE[t]);
    K.an(b, 'click', () => { if (tage.has(t)) tage.delete(t); else tage.add(t); b.classList.toggle('an', tage.has(t)); });
    return b;
  }));
  const sichern = async () => {
    if (!name.value.trim()) { toast('Bitte einen Namen eintragen'); return; }
    if (!tage.size) { toast('Bitte mindestens einen Tag wählen'); return; }
    if (await aendern('speichern', { gewohnheit: { id: g && g.id, name: name.value, art: art.value, ziel: ziel.value, tage: [...tage] } })) blattZu();
  };
  blatt(g ? 'Gewohnheit bearbeiten' : 'Neue Gewohnheit',
    h('label', null, 'Name', name), h('label', null, 'Art', art), zielZeile,
    h('label', null, 'An welchen Tagen', chips),
    g && h('p', { class: 'klein' }, 'Geänderte Tage gelten ab heute; vergangene Tage behalten ihre alte Regel.'),
    h('div', { class: 'reihe' },
      g ? h('button', { class: 'knopf rot links', onclick: async () => { if (await aendern('archivieren', { id: g.id })) blattZu(); } }, 'Archivieren') : h('span', { class: 'links' }),
      h('button', { class: 'knopf', onclick: blattZu }, 'Abbrechen'),
      h('button', { class: 'knopf primaer', onclick: sichern }, 'Sichern')));
  if (!g) name.focus();
}

function archivBlatt() {
  const zeichnen = () => {
    const liste = tdaten().gewohnheiten.filter((g) => g.archiviert);
    blatt('Archivierte Gewohnheiten',
      liste.length ? h('div', { class: 'karte' }, liste.map((g) => h('div', { class: 'archiv-zeile' }, h('span', null, g.name),
        h('button', { class: 'knopf', onclick: () => aendern('wiederherstellen', { id: g.id }) }, 'Zurückholen'),
        h('button', { class: 'knopf rot', onclick: () => { if (confirm(`„${g.name}“ mit dem ganzen Verlauf endgültig löschen?`)) aendern('loeschen', { id: g.id }); } }, 'Löschen')))) : h('p', { class: 'leer' }, 'Nichts archiviert.'),
      h('div', { class: 'reihe' }, h('span', { class: 'links' }), h('button', { class: 'knopf primaer', onclick: blattZu }, 'Fertig')));
    blattNeu = zeichnen; // eslint-disable-line no-global-assign
  };
  zeichnen();
}

// taeglich.js wird nach app.js geladen: einmal neu zeichnen, damit die Täglich-Karte auf „Heute“ sofort erscheint.
zeichne();
