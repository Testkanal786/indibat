'use strict';
// Indibat-Kern fuer Gebetsverlauf und taegliche Gewohnheiten.
// Dieselbe Datei laeuft auf dem Laptop (Electron) und in der Handy-App, damit beide gleich rechnen.
// Daten liegen in der Nextcloud: Indibat/taeglich.json und Indibat/gebete-JJJJ.json.
(function (global) {
  const GEBETE = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const datum = (s) => { const [j, m, t] = s.split('-').map(Number); return new Date(j, m - 1, t, 12); };
  const plusTage = (s, n) => { const d = datum(s); d.setDate(d.getDate() + n); return ymd(d); };
  const neueId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ---------- Taegliche Gewohnheiten ---------- */
  // Aufbau: { version, gewohnheiten: [{ id, name, art: 'haken'|'zaehler', ziel, seit, archiviert, regeln: [{ ab, tage: [0..6] }] }],
  //           log: { 'JJJJ-MM-TT': { <id>: true | Zahl } } }
  function leer() { return { version: 1, gewohnheiten: [], log: {} }; }
  function normalisieren(d) {
    if (!d || typeof d !== 'object') d = leer();
    if (!Array.isArray(d.gewohnheiten)) d.gewohnheiten = [];
    if (!d.log || typeof d.log !== 'object') d.log = {};
    d.version = 1;
    for (const g of d.gewohnheiten) {
      if (!Array.isArray(g.regeln) || !g.regeln.length) g.regeln = [{ ab: g.seit || '2000-01-01', tage: [0, 1, 2, 3, 4, 5, 6] }];
      g.regeln.sort((a, b) => a.ab.localeCompare(b.ab));
      if (!g.seit) g.seit = g.regeln[0].ab;
      if (g.art !== 'zaehler') { g.art = 'haken'; delete g.ziel; } else g.ziel = Math.max(1, parseInt(g.ziel, 10) || 1);
    }
    return d;
  }
  // Gilt die Gewohnheit an diesem Tag? (angelegt, nicht archiviert, Wochentag laut der damals gueltigen Regel)
  function faellig(g, tag) {
    if (tag < g.seit || (g.archiviert && tag >= g.archiviert)) return false;
    let regel = g.regeln[0];
    for (const r of g.regeln) if (r.ab <= tag) regel = r;
    return regel.tage.includes(datum(tag).getDay());
  }
  const wert = (d, tag, id) => (d.log[tag] ? d.log[tag][id] : undefined);
  function anteil(g, w) {
    if (g.art === 'zaehler') return Math.min(1, (Number(w) || 0) / g.ziel);
    return w ? 1 : 0;
  }
  // Stand eines Tages: welche Gewohnheiten faellig sind und wie viel davon erledigt ist (Zaehler anteilig).
  function tagGewohnheiten(d, tag) {
    const liste = d.gewohnheiten.filter((g) => faellig(g, tag)).map((g) => {
      const w = wert(d, tag, g.id);
      return { g, wert: g.art === 'zaehler' ? (Number(w) || 0) : !!w, anteil: anteil(g, w) };
    });
    return { soll: liste.length, ist: liste.reduce((s, e) => s + e.anteil, 0), liste };
  }

  // Aenderungen: jede Funktion aendert die frisch gelesenen Daten. So gehen Aenderungen vom anderen Geraet nicht verloren.
  const ops = {
    wert(d, { tag, id, wert: w }) {
      if (!d.log[tag]) d.log[tag] = {};
      if (w === false || w === 0 || w == null) delete d.log[tag][id]; else d.log[tag][id] = w;
      if (!Object.keys(d.log[tag]).length) delete d.log[tag];
    },
    zaehlen(d, { tag, id, schritt }) {
      const g = d.gewohnheiten.find((x) => x.id === id);
      if (!g) return;
      ops.wert(d, { tag, id, wert: Math.max(0, (Number(wert(d, tag, id)) || 0) + schritt) });
    },
    speichern(d, { gewohnheit: neu, heute }) {
      let g = neu.id && d.gewohnheiten.find((x) => x.id === neu.id);
      const tage = [...new Set(neu.tage)].filter((t) => t >= 0 && t <= 6).sort();
      if (!g) {
        g = { id: neu.id || neueId(), seit: heute, archiviert: null, regeln: [{ ab: heute, tage }] };
        d.gewohnheiten.push(g);
      } else {
        const letzte = g.regeln[g.regeln.length - 1];
        if (letzte.tage.join() !== tage.join()) {
          // Neue Wochentage gelten ab heute; vergangene Tage behalten ihre Regel.
          if (letzte.ab >= heute) letzte.tage = tage; else g.regeln.push({ ab: heute, tage });
        }
      }
      g.name = String(neu.name || '').trim() || 'Ohne Namen';
      g.art = neu.art === 'zaehler' ? 'zaehler' : 'haken';
      if (g.art === 'zaehler') g.ziel = Math.max(1, parseInt(neu.ziel, 10) || 1); else delete g.ziel;
      return g.id;
    },
    archivieren(d, { id, heute }) { const g = d.gewohnheiten.find((x) => x.id === id); if (g) g.archiviert = g.seit >= heute ? g.seit : heute; },
    wiederherstellen(d, { id }) { const g = d.gewohnheiten.find((x) => x.id === id); if (g) g.archiviert = null; },
    loeschen(d, { id }) {
      d.gewohnheiten = d.gewohnheiten.filter((x) => x.id !== id);
      for (const [tag, e] of Object.entries(d.log)) { delete e[id]; if (!Object.keys(e).length) delete d.log[tag]; }
    },
    sortieren(d, { ids }) {
      const pos = new Map(ids.map((id, i) => [id, i]));
      d.gewohnheiten.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
    },
  };

  /* ---------- Gebetsarchiv ---------- */
  // Aufbau je Jahr: { version, jahr, tage: { 'JJJJ-MM-TT': { fajr: true, dhuhr: false, ... } } }
  const archivName = (jahr) => `gebete-${jahr}.json`;
  function archivLeer(jahr) { return { version: 1, jahr, tage: {} }; }
  const archivOps = {
    // tage: { 'JJJJ-MM-TT': { fajr: bool, ... } }; ueberschreibt nur die angegebenen Tage
    tage(a, { tage }) {
      for (const [tag, werte] of Object.entries(tage)) {
        const neu = {};
        for (const k of GEBETE) neu[k] = !!(werte && werte[k]);
        a.tage[tag] = neu;
      }
    },
    gebet(a, { tag, key, wert: w }) {
      if (!GEBETE.includes(key)) return;
      if (!a.tage[tag]) a.tage[tag] = Object.fromEntries(GEBETE.map((k) => [k, false]));
      a.tage[tag][key] = !!w;
    },
  };
  const gebeteIst = (werte) => (werte ? GEBETE.filter((k) => werte[k]).length : 0);

  // Anteil eines Tages fuer Raster und Ringe. gebete: { fajr: bool, ... } oder null (nichts bekannt).
  function tagesAnteil(modus, gebeteWerte, gew) {
    let soll = 0;
    let ist = 0;
    if (modus !== 'gewohnheiten' && gebeteWerte) { soll += 5; ist += gebeteIst(gebeteWerte); }
    if (modus !== 'gebete' && gew && gew.soll) { soll += gew.soll; ist += gew.ist; }
    return soll ? ist / soll : null;
  }

  /* ---------- Darstellung (nur im Browser) ---------- */
  // Ereignisse merken, damit morph() sie beim Abgleich auf das bestehende Element uebertragen kann.
  function an(el, typ, fn, opt) {
    (el._on || (el._on = [])).push([typ, fn, opt]);
    el.addEventListener(typ, fn, opt);
    return el;
  }
  // Statt den Inhalt jedes Mal neu zu bauen, wird der bestehende an den neuen Stand angeglichen.
  // Elemente bleiben erhalten; nur geaenderte Klassen, Stile und Texte werden gesetzt.
  // Dadurch laufen CSS-Uebergaenge (Ring fuellt sich, Haken blendet ein), statt dass alles neu "aufploppt".
  function morph(a, b) {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) { a.replaceWith(b); return b; }
    if (a.nodeType === 3 || a.nodeType === 8) { if (a.data !== b.data) a.data = b.data; return a; }
    if (a.nodeType !== 1 || a.getAttribute('data-k') !== b.getAttribute('data-k')) { a.replaceWith(b); return b; }
    const warAn = a.classList.contains('an');
    for (const at of [...a.attributes]) if (at.name !== 'style' && !b.hasAttribute(at.name)) a.removeAttribute(at.name);
    for (const at of [...b.attributes]) if (at.name !== 'style' && a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    // Stile nur ueber das Stil-Objekt setzen: Die Sicherheitsregel der Seite (CSP) verbietet das style-Attribut per setAttribute.
    if (a.style && a.style.cssText !== b.style.cssText) a.style.cssText = b.style.cssText;
    // Frisch abgehakt: kurze Bestaetigungs-Animation, auch wenn gleich danach noch einmal abgeglichen wird.
    if (a._frisch) a.classList.add('frisch');
    if (!warAn && a.classList.contains('an')) {
      a.classList.add('frisch');
      clearTimeout(a._frisch);
      a._frisch = setTimeout(() => { a._frisch = 0; a.classList.remove('frisch'); }, 520);
    }
    for (const [t, f, o] of a._on || []) a.removeEventListener(t, f, o);
    for (const [t, f, o] of b._on || []) a.addEventListener(t, f, o);
    a._on = b._on;
    morphKinder(a, [...b.childNodes]);
    if ((a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') && a !== document.activeElement) {
      if (a.value !== b.value) a.value = b.value;
      if (a.checked !== b.checked) a.checked = b.checked;
    }
    return a;
  }
  function morphKinder(el, neue) {
    const alte = [...el.childNodes];
    neue.forEach((n, i) => { if (alte[i]) morph(alte[i], n); else el.append(n); });
    for (let i = neue.length; i < alte.length; i++) alte[i].remove();
  }
  function morphInhalt(el, kinder) {
    morphKinder(el, kinder.map((k) => (k && k.nodeType ? k : document.createTextNode(String(k)))));
  }
  const SVG = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; }
  // Auswahlliste unter einem Eingabefeld: oeffnet sich sofort beim Hineinklicken mit allen vorhandenen Werten,
  // filtert beim Tippen; ein neuer Name kann trotzdem frei eingegeben werden. Ersetzt die Browser-Liste (datalist),
  // die erst beim Tippen oder ueber den kleinen Pfeil aufgeht.
  function vorschlagsliste(feld, werte) {
    feld.removeAttribute('list');
    feld.setAttribute('autocomplete', 'off');
    let box = null;
    let wahl = -1;
    let treffer = [];
    const zu = () => { if (box) { box.remove(); box = null; } wahl = -1; };
    const nimm = (w) => { feld.value = w; zu(); feld.dispatchEvent(new Event('change', { bubbles: true })); };
    function zeigen() {
      const q = feld.value.trim().toLowerCase();
      treffer = [...new Set(werte)].filter((w) => w && (!q || w.toLowerCase().includes(q)) && w !== feld.value);
      if (!treffer.length) { zu(); return; }
      if (!box) {
        box = document.createElement('div');
        box.className = 'vorschlaege';
        box.addEventListener('mousedown', (e) => e.preventDefault()); // Feld behaelt den Fokus
        document.body.append(box);
      }
      box.replaceChildren(...treffer.map((w, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = i === wahl ? 'gewaehlt' : '';
        b.textContent = w;
        b.addEventListener('click', () => nimm(w));
        return b;
      }));
      // Fest unter (oder ueber) dem Feld, damit kein Dialogrand die Liste abschneidet.
      const r = feld.getBoundingClientRect();
      const hoch = Math.min(240, treffer.length * 38 + 10);
      const unten = window.innerHeight - r.bottom > hoch + 12 || r.top < hoch + 12;
      box.style.left = r.left + 'px';
      box.style.width = r.width + 'px';
      box.style.maxHeight = hoch + 'px';
      box.style.top = (unten ? r.bottom + 4 : r.top - hoch - 4) + 'px';
    }
    an(feld, 'focus', zeigen);
    an(feld, 'click', zeigen);
    an(feld, 'input', () => { wahl = -1; zeigen(); });
    an(feld, 'blur', () => setTimeout(zu, 120));
    an(feld, 'keydown', (e) => {
      if (!box) { if (e.key === 'ArrowDown') { zeigen(); e.preventDefault(); } return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        wahl = (wahl + (e.key === 'ArrowDown' ? 1 : -1) + treffer.length) % treffer.length;
        zeigen(); e.preventDefault();
      } else if (e.key === 'Enter' && wahl >= 0) { nimm(treffer[wahl]); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'Escape') { zu(); e.stopPropagation(); e.preventDefault(); }
    });
    return feld;
  }
  // Fortschrittsring. anteil 0..1, text in der Mitte, unter = Beschriftung darunter.
  function ring(anteil, text, unter, klasse) {
    const r = 30;
    const u = 2 * Math.PI * r;
    const s = svg('svg', { viewBox: '0 0 76 76', class: 'ring-svg' });
    s.append(svg('circle', { cx: 38, cy: 38, r, class: 'ring-spur' }));
    const p = svg('circle', { cx: 38, cy: 38, r, class: 'ring-wert', transform: 'rotate(-90 38 38)' });
    p.style.strokeDasharray = `${(u * Math.max(0, Math.min(1, anteil))).toFixed(2)}px ${u.toFixed(2)}px`; // als Stil, damit der Uebergang greift
    if (!(anteil > 0)) p.setAttribute('stroke-opacity', '0'); // sonst bliebe bei 0 ein Punkt stehen
    s.append(p);
    const box = document.createElement('div');
    box.className = 'ring ' + (klasse || '');
    const innen = document.createElement('div');
    innen.className = 'ring-innen';
    const z = document.createElement('div'); z.className = 'ring-zahl'; z.textContent = text;
    innen.append(s, z);
    const l = document.createElement('div'); l.className = 'ring-name'; l.textContent = unter;
    box.append(innen, l);
    return box;
  }
  // Kalender-Raster: eine Spalte je Woche (Mo bis So), eine Zelle je Tag.
  // wert(tag) -> 0..1 oder null; antippen(tag) beim Klick.
  function raster({ wochen, heute, wert: wertVon, antippen, klein }) {
    const box = document.createElement('div');
    box.className = 'kal' + (klein ? ' klein' : '');
    box.setAttribute('data-k', 'kal-' + wochen);
    const h = datum(heute);
    const versatz = (h.getDay() + 6) % 7; // Montag = 0
    const start = plusTage(heute, -versatz - (wochen - 1) * 7);
    const zeilen = document.createElement('div');
    zeilen.className = 'kal-tage';
    for (const t of ['Mo', '', 'Mi', '', 'Fr', '', 'So']) { const s = document.createElement('span'); s.textContent = t; zeilen.append(s); }
    const gitter = document.createElement('div');
    gitter.className = 'kal-gitter';
    gitter.style.gridTemplateColumns = `repeat(${wochen}, 1fr)`;
    const monate = document.createElement('div');
    monate.className = 'kal-monate';
    monate.style.gridTemplateColumns = `repeat(${wochen}, 1fr)`;
    const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
    let letzterMonat = -1;
    for (let w = 0; w < wochen; w++) {
      const m = document.createElement('span');
      const mo = datum(plusTage(start, w * 7)).getMonth();
      if (mo !== letzterMonat) { m.textContent = MON[mo]; letzterMonat = mo; }
      monate.append(m);
    }
    for (let i = 0; i < wochen * 7; i++) {
      const w = Math.floor(i / 7);
      const t = i % 7;
      const tag = plusTage(start, w * 7 + t);
      const z = document.createElement('button');
      z.style.gridColumn = String(w + 1);
      z.style.gridRow = String(t + 1);
      if (tag > heute) { z.className = 'zelle zukunft'; z.disabled = true; gitter.append(z); continue; }
      const a = wertVon(tag);
      z.className = 'zelle' + (tag === heute ? ' heute' : '') + (a == null ? ' ohne' : a === 0 ? ' null' : '');
      if (a != null && a > 0) z.style.background = `color-mix(in srgb, var(--akzent) ${Math.round(28 + 72 * a)}%, transparent)`;
      const d = datum(tag);
      z.title = `${WT[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}` + (a == null ? '' : ` · ${Math.round(a * 100)} %`);
      an(z, 'click', () => antippen(tag));
      gitter.append(z);
    }
    const rechts = document.createElement('div');
    rechts.className = 'kal-rechts';
    rechts.append(monate, gitter);
    box.append(zeilen, rechts);
    return box;
  }

  const K = { vorschlagsliste, an, morph, morphInhalt, neueId, GEBETE, WT, ymd, datum, plusTage, leer, normalisieren, faellig, tagGewohnheiten, ops, archivName, archivLeer, archivOps, gebeteIst, tagesAnteil, ring, raster };
  if (typeof module !== 'undefined' && module.exports) module.exports = K; else global.IndibatKern = K;
}(typeof window !== 'undefined' ? window : globalThis));
