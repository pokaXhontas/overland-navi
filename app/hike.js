/* Wanderwege: eigene Kartenebene aus OpenStreetMap mit SAC-Schwierigkeit (T1–T6) und Wanderrouten.
 * Pro Land eine Datei; offline aus dem App-Speicher, sonst über den Kartenproxy. */
'use strict';

const SAC_INFO = [
  null,
  { t: 'T1', name: 'Wandern', color: '#E3A700', text: 'Gut angelegter Weg, kaum Absturzgefahr. Turnschuhe reichen.' },
  { t: 'T2', name: 'Bergwandern', color: '#D62828', text: 'Durchgehende Wegspur, teils steil. Trittsicherheit und Wanderschuhe nötig.' },
  { t: 'T3', name: 'Anspruchsvolles Bergwandern', color: '#D62828', text: 'Spur nicht überall sichtbar, ausgesetzte Stellen, evtl. Hände nötig. Gute Trittsicherheit.' },
  { t: 'T4', name: 'Alpinwandern', color: '#1C6DD0', text: 'Teils weglos, Hände oft nötig, steile Gras- und Schrofenhänge. Alpine Erfahrung.' },
  { t: 'T5', name: 'Anspruchsvolles Alpinwandern', color: '#1C6DD0', text: 'Oft weglos, einfache Kletterstellen, Gletscher möglich. Bergsteigerausrüstung.' },
  { t: 'T6', name: 'Schwieriges Alpinwandern', color: '#1C6DD0', text: 'Meist weglos, Kletterstellen bis II, sehr ausgesetzt. Nur für Erfahrene.' }
];
const VIS_TEXT = [null, 'sehr gut sichtbar', 'gut sichtbar', 'stellenweise undeutlich', 'kaum sichtbar', 'nur mit Orientierung', 'weglos'];
const ROUTE_COLORS = { red: '#D62828', blue: '#1C6DD0', yellow: '#E3A700', green: '#2F9E44', orange: '#E8590C', purple: '#7048E8', black: '#343A40', white: '#ADB5BD', brown: '#8B5A2B' };

/* Punkte in den Wanderwege-Dateien */
const HK_PTS = {
  biwak: { label: 'Biwak', long: 'Biwak oder unbewirtschaftete Hütte', color: '#B5482A', d: 'M3 19 12 5l9 14ZM9.5 19l2.5-4 2.5 4' },
  huette: { label: 'Hütte', long: 'Bewirtschaftete Hütte', color: '#C92A2A', d: 'M4 20v-9l8-6 8 6v9M3 20h18M10 20v-5h4v5' },
  wasser: { label: 'Trinkwasser', long: 'Trinkwasser', color: '#1C7ED6', d: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z' },
  quelle: { label: 'Quelle', long: 'Quelle', color: '#0B7285', d: 'M12 4s5 5.5 5 9.2a5 5 0 0 1-10 0C7 9.5 12 4 12 4ZM4 21c2-1.3 4-1.3 6 0s4 1.3 6 0 3-1 4-.5' },
  ruine: { label: 'Ruinen', long: 'Ruine', color: '#7A5230', g: 'see', d: 'M4 20v-9l2-2 2 2V7l2-2 2 2v13M14 20v-6l2-2 2 2v6M3 20h18' },
  burg: { label: 'Burgen', long: 'Burg, Festung oder Turm', color: '#9C4221', g: 'see', d: 'M4 20V8h2.5v2H9V8h2.5v2H14V8h2.5v2H19V8h1v12ZM10 20v-4a2 2 0 0 1 4 0v4' },
  archaeologie: { label: 'Ausgrabungen', long: 'Archäologische Stätte', color: '#A0522D', g: 'see', d: 'M4 8h16M5 8l7-4 7 4M6.5 8v10M10.5 8v10M13.5 8v10M17.5 8v10M4 20h16' },
  aussicht: { label: 'Aussicht', long: 'Aussichtspunkt', color: '#2B8A3E', g: 'see', d: 'M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12ZM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z' },
  wasserfall: { label: 'Wasserfälle', long: 'Wasserfall', color: '#1971C2', g: 'see', d: 'M6 3v8c0 3 2 4 2 7M12 3v10c0 2 1 3 1 5M18 3v8c0 3-2 4-2 7M4 21h16' },
  hoehle: { label: 'Höhlen', long: 'Höhleneingang', color: '#495057', g: 'see', d: 'M3 20a9 9 0 0 1 18 0ZM9 20a3 3 0 0 1 6 0' },
  denkmal: { label: 'Denkmäler', long: 'Denkmal', color: '#6C757D', g: 'see', d: 'M10 20l1-13 1-3 1 3 1 13ZM7 20h10' },
  sehenswert: { label: 'Sehenswürdigkeiten', long: 'Sehenswürdigkeit', color: '#D6336C', g: 'see', d: 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7Z' }
};
const HK_SHELTER = { basic_hut: 'einfache Hütte', lean_to: 'offener Unterstand', rock_shelter: 'Felsunterstand', weather_shelter: 'Wetterschutz' };

function hikePointImage(k) {
  const c = HK_PTS[k];
  const ratio = 2, size = 34;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size * ratio;
  const g = cv.getContext('2d');
  g.scale(ratio, ratio);
  g.beginPath();
  if (k === 'biwak' || k === 'huette') {
    // eckig, damit Unterkünfte von Wasserstellen gut zu unterscheiden sind
    const r = 6, x = 4, y = 4, w = size - 8;
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + w, r); g.arcTo(x + w, y + w, x, y + w, r); g.arcTo(x, y + w, x, y, r); g.arcTo(x, y, x + w, y, r);
  } else g.arc(size / 2, size / 2, 13, 0, Math.PI * 2);
  g.fillStyle = c.color;
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = '#FFFFFF';
  g.stroke();
  g.translate(size / 2 - 8.4, size / 2 - 8.4);
  g.scale(0.7, 0.7);
  g.strokeStyle = '#FFFFFF';
  g.lineWidth = 2.6;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.stroke(new Path2D(c.d));
  return { image: g.getImageData(0, 0, size * ratio, size * ratio), ratio };
}

const Hike = {
  index: store.get('hikeIndex', {}),   // Kennung → { size, date, bbox, name, iso }
  local: new Map(),                     // Gebiet → Set der offline gespeicherten Kennungen
  localDate: new Map(),                 // „Gebiet/Kennung“ → Zeitpunkt des Downloads
  arch: new Map(),

  on() { return store.get('hikeOn', true); },
  max() { return store.get('hikeMax', 6); },
  pts() {
    const known = store.get('hikePtsKnown', ['biwak', 'huette', 'unterstand', 'wasser', 'quelle']);
    const fresh = Object.keys(HK_PTS).filter((k) => !known.includes(k));   // neu dazugekommene Arten sind an
    return [...store.get('hikePts', Object.keys(HK_PTS)), ...fresh].filter((k, i, a) => HK_PTS[k] && a.indexOf(k) === i);
  },
  keys() { return Object.keys(this.index); },
  url(key) { return Tiles.sources.hike ? Tiles.sources.hike.replace('{id}', key) : null; },

  async loadIndex() {
    if (!Tiles.sources.hike || !navigator.onLine) return;
    try {
      const r = await originalFetch(this.url('index').replace('.pmtiles', '.json'), { cache: 'no-cache' });
      if (r.ok) { this.index = await r.json(); store.set('hikeIndex', this.index); }
    } catch (e) { /* alte Liste behalten */ }
  },

  /* Länderdateien, die ein Gebiet berühren */
  keysFor(boxes) {
    return this.keys().filter((k) => {
      const b = this.index[k].bbox;
      return b && boxes.some((x) => x[0] <= b[2] && x[2] >= b[0] && x[1] <= b[3] && x[3] >= b[1]);
    });
  },
  regionDone(r) {
    const ks = this.keysFor(r.boxes), have = this.local.get(r.id);
    return ks.length > 0 && !!have && ks.every((k) => have.has(k) && !this.stale(r.id, k));
  },
  regionStale(r) { const have = this.local.get(r.id); return !!have && this.keysFor(r.boxes).some((k) => have.has(k) && this.stale(r.id, k)); },
  /* gespeicherte Kopie älter als die aktuelle Datei? (neue Ebenen wie Bus & Bahn, Biwaks) */
  stale(rid, key) {
    const d = this.localDate.get(rid + '/' + key), m = this.index[key];
    if (!d || !m || !m.date) return false;
    return d < Date.parse(m.ts || m.date + 'T00:00:00Z');
  },
  /* Download-Adresse mit Datum, damit eine neuere Fassung wirklich neu geladen wird */
  dlUrl(key) { const u = this.url(key); return u && this.index[key] && this.index[key].date ? u + '?v=' + this.index[key].date : u; },

  async scan() {
    this.local.clear();
    this.arch.clear();
    const root = await Tiles.opfs();
    if (!root || !root.keys) return;
    const old = [];
    for await (const name of root.keys()) {
      const m = name.match(/^(.+)-hk-([a-z0-9-]+)\.idx\.ok$/);
      if (m) {
        if (!this.local.has(m[1])) this.local.set(m[1], new Set());
        this.local.get(m[1]).add(m[2]);
        try { this.localDate.set(m[1] + '/' + m[2], (await (await root.getFileHandle(`${m[1]}-hk-${m[2]}.dat`)).getFile()).lastModified); } catch (e) { /* ohne Datum */ }
      }
      if (/-hike\.(pmtiles|ok|pmtiles\.state)$/.test(name)) old.push(name);
    }
    for (const n of old) { try { await root.removeEntry(n); } catch (e) { /* egal */ } }
  },

  async localArchive(rid, key) {
    const k = rid + '/' + key;
    if (this.arch.has(k)) return this.arch.get(k);
    let a = null;
    try {
      const root = await Tiles.opfs();
      const idx = await (await (await root.getFileHandle(`${rid}-hk-${key}.idx`)).getFile()).arrayBuffer();
      const data = await (await root.getFileHandle(`${rid}-hk-${key}.dat`)).getFile();
      a = new OvlExtract.LocalArchive(idx, async (o, l) => new Uint8Array(await data.slice(o, o + l).arrayBuffer()));
    } catch (e) { a = null; }
    this.arch.set(k, a);
    return a;
  },
  remoteArchive(key) {
    const k = 'online/' + key;
    if (!this.arch.has(k)) this.arch.set(k, this.url(key) ? new pmtiles.PMTiles(this.url(key)) : null);
    return this.arch.get(k);
  },

  async tile(z, x, y) {
    const n = Math.pow(2, z);
    const lon = (x + 0.5) / n * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI;
    // zuerst offline gespeicherte Gebiete
    for (const r of Tiles.regions) {
      const have = this.local.get(r.id);
      if (!have || !r.boxes.some((b) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3])) continue;
      for (const key of have) {
        if (navigator.onLine && this.stale(r.id, key)) continue;   // veraltete Kopie: lieber online die neue Fassung
        try {
          const a = await this.localArchive(r.id, key);
          const t = a && await a.getZxy(z, x, y);
          if (t && t.data && t.data.byteLength) return t.data;
        } catch (e) { /* nächste */ }
      }
    }
    if (!navigator.onLine) return null;
    // online: die Länderdatei, deren Ausdehnung passt (kleinste zuerst)
    const hits = this.keys().filter((k) => { const b = this.index[k].bbox; return b && lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]; });
    hits.sort((a, b) => (this.index[a].size || 0) - (this.index[b].size || 0));
    for (const key of hits) {
      try {
        const t = await this.remoteArchive(key).getZxy(z, x, y);
        if (t && t.data && t.data.byteLength) return t.data;
      } catch (e) { /* nächste */ }
    }
    return null;
  },

  /* Kartenebenen; werden in buildStyle eingefügt */
  oev() { return store.get('oevOn', false); },

  /* Bus und Bahn (aus denselben Länderdateien, Ebenen „oev“ und „halt“) */
  oevLayers(dark, sat) {
    if (!this.oev() || (!this.keys().length && !this.local.size)) return { lines: [], top: [] };
    const col = ['case', ['has', 'c'], ['to-color', ['get', 'c'], '#7048E8'],
      ['match', ['get', 'm'], 'bahn', '#495057', 'ubahn', '#1C6DD0', 'sbahn', '#2F9E44', 'tram', '#C92A2A', '#7048E8']];
    const w = ['match', ['get', 'm'], 'bahn', 3, 'ubahn', 3, 'sbahn', 3, 'tram', 2.4, 1.8];
    const halo = dark || sat ? '#0B0F12' : '#FFFFFF';
    return {
      lines: [
        { id: 'oev-casing', type: 'line', source: 'hike', 'source-layer': 'oev', layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': halo, 'line-opacity': 0.8, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['+', w, 1.5], 16, ['+', ['*', w, 2], 3]] } },
        { id: 'oev-line', type: 'line', source: 'hike', 'source-layer': 'oev', layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': col, 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, w, 16, ['*', w, 2]] } },
        { id: 'oev-label', type: 'symbol', source: 'hike', 'source-layer': 'oev', minzoom: 14, filter: ['has', 'r'],
          layout: { 'symbol-placement': 'line', 'text-field': ['get', 'r'], 'text-font': ['Noto Sans Medium'], 'text-size': 10.5, 'symbol-spacing': 320 },
          paint: { 'text-color': col, 'text-halo-color': halo, 'text-halo-width': 1.6 } }
      ],
      top: [
        { id: 'oev-halt', type: 'symbol', source: 'hike', 'source-layer': 'halt',
          layout: { 'icon-image': ['concat', 'halt-', ['get', 'k']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.7, 16, 1], 'icon-allow-overlap': ['step', ['zoom'], false, 15, true],
            'symbol-sort-key': ['match', ['get', 'k'], 'bahn', 0, 'ubahn', 1, 'sbahn', 1, 'tram', 2, 3],
            'text-field': ['step', ['zoom'], '', 15, ['coalesce', ['get', 'n'], '']], 'text-font': ['Noto Sans Medium'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 9 },
          paint: { 'text-color': dark || sat ? '#E9EEF1' : '#343A40', 'text-halo-color': halo, 'text-halo-width': 1.5 } }
      ]
    };
  },

  layers(dark, sat) {
    const ov = this.oevLayers(dark, sat);
    if (!this.on() || (!this.keys().length && !this.local.size)) return { lines: ov.lines, labels: [], top: ov.top };
    const max = this.max();
    const isTrack = ['all', ['==', ['get', 'h'], 't'], ['==', ['get', 's'], 0], ['!', ['has', 'net']]];
    const sacOk = ['any', ['==', ['get', 's'], 0], ['<=', ['get', 's'], max]];
    const f = ['all', sacOk, ['!', isTrack]];
    const ft = store.get('hikeTracks', true) ? isTrack : ['==', 1, 0];
    const any = ['any', f, ft];
    const sacColor = ['match', ['get', 's'], 1, '#E3A700', 2, '#D62828', 3, '#D62828', 4, '#1C6DD0', 5, '#1C6DD0', 6, '#1C6DD0', dark || sat ? '#C9A27A' : '#8A5A2B'];
    const routeColor = ['match', ['coalesce', ['get', 'c'], ''], ...Object.entries(ROUTE_COLORS).flat(), '#C2255C'];
    const w = (a, b) => ['interpolate', ['linear'], ['zoom'], 11, a, 16, b];
    return {
      lines: [
        { id: 'hike-route', type: 'line', source: 'hike', 'source-layer': 'wege', filter: ['all', f, ['has', 'net']], layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': routeColor, 'line-opacity': 0.28, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 12, 7, 16, 12] } },
        { id: 'hike-track', type: 'line', source: 'hike', 'source-layer': 'wege', filter: ft, layout: { 'line-join': 'round' },
          paint: { 'line-color': dark || sat ? '#B89A78' : '#9C7B57', 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 2.4], 'line-dasharray': [4, 2] } },
        { id: 'hike-casing', type: 'line', source: 'hike', 'source-layer': 'wege', filter: f, minzoom: 11, layout: { 'line-join': 'round' },
          paint: { 'line-color': dark || sat ? 'rgba(11,15,18,0.65)' : 'rgba(255,255,255,0.85)', 'line-width': w(2.6, 5.4) } },
        { id: 'hike-line', type: 'line', source: 'hike', 'source-layer': 'wege', filter: f, layout: { 'line-join': 'round' },
          paint: { 'line-color': sacColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 11, 1.4, 16, 3.2], 'line-dasharray': [2, 1.3] } },
        { id: 'hike-hit', type: 'line', source: 'hike', 'source-layer': 'wege', filter: any, minzoom: 11, paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 } },
        ...ov.lines
      ],
      labels: [
        { id: 'hike-label', type: 'symbol', source: 'hike', 'source-layer': 'wege', filter: f, minzoom: 13,
          layout: { 'symbol-placement': 'line', 'text-font': ['Noto Sans Medium'], 'text-size': 11, 'symbol-spacing': 280,
            'text-field': ['case', ['>', ['get', 's'], 0],
              ['concat', 'T', ['to-string', ['get', 's']], ['case', ['has', 'n'], ['concat', ' · ', ['get', 'n']], '']],
              ['coalesce', ['get', 'n'], ['get', 'ref'], '']] },
          paint: { 'text-color': sacColor, 'text-halo-color': dark || sat ? '#0B0F12' : '#FFFFFF', 'text-halo-width': 1.6 } },
      ],
      top: [
        ...ov.top,
        ...(this.pts().length ? [{ id: 'hike-pts', type: 'symbol', source: 'hike', 'source-layer': 'punkte', filter: ['in', ['get', 'k'], ['literal', this.pts()]],
          layout: { 'icon-image': ['concat', 'hkpt-', ['get', 'k']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 14, 1],
            'icon-allow-overlap': ['step', ['zoom'], false, 13, true], 'symbol-sort-key': ['match', ['get', 'k'], 'biwak', 0, 'huette', 1, 'ruine', 2, 'burg', 2, 'wasser', 3, 4],
            'text-field': ['step', ['zoom'], '', 12, ['coalesce', ['get', 'n'], ['match', ['get', 'k'], 'ruine', 'Ruine', 'hoehle', 'Höhle', 'wasserfall', 'Wasserfall', 'aussicht', 'Aussicht', 'archaeologie', 'Ausgrabung', '']]], 'text-font': ['Noto Sans Medium'], 'text-size': 11,
            'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 9 },
          paint: { 'text-color': dark || sat ? '#E9EEF1' : '#3B2A1A', 'text-halo-color': dark || sat ? '#0B0F12' : '#FFFFFF', 'text-halo-width': 1.5 } }] : [])
      ]
    };
  },
  source() {
    return { type: 'vector', tiles: ['hike://{z}/{x}/{y}'], minzoom: 8, maxzoom: 14, attribution: 'Wanderwege © OpenStreetMap' };
  },

  /* Antippen eines Wegs */
  popup: null,
  showInfo(f, lngLat) {
    const p = f.properties || {};
    const s = SAC_INFO[p.s] || null;
    const esc = (t) => String(t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const html = `<div class="hk-pop">
      ${s ? `<div class="hk-head"><span class="hk-badge" style="background:${s.color}">${s.t}</span><b>${s.name}</b></div><p>${s.text}</p>`
          : `<div class="hk-head"><span class="hk-badge" style="background:#8A5A2B">–</span><b>${{ t: 'Feld- oder Fahrweg', f: 'Fußweg', b: 'Saumpfad', s: 'Treppe', k: 'Klettersteig' }[p.h] || 'Pfad'} ohne Schwierigkeitsangabe</b></div>`}
      ${p.n ? `<div class="hk-row"><span>Name</span><b>${esc(p.n)}</b></div>` : ''}
      ${p.v ? `<div class="hk-row"><span>Wegspur</span><b>${VIS_TEXT[p.v]}</b></div>` : ''}
      ${p.r ? `<div class="hk-row"><span>Wanderroute</span><b>${esc(p.r)}${p.ref ? ' (' + esc(p.ref) + ')' : ''}</b></div>` : ''}
    </div>`;
    if (this.popup) this.popup.remove();
    this.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px', className: 'hk-popup' }).setLngLat(lngLat).setHTML(html).addTo(map);
  },

  showPoint(f) {
    const p = f.properties || {};
    const c = HK_PTS[p.k];
    if (!c) return;
    const esc = (t) => String(t).replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
    const yn = (v) => ({ yes: 'ja', no: 'nein', required: 'nötig', recommended: 'empfohlen' }[v] || v);
    const rows = [
      ['Art', p.st && HK_SHELTER[p.st] ? HK_SHELTER[p.st] : c.long],
      ['Höhe', p.e ? p.e.toLocaleString('de-DE') + ' m' : ''],
      ['Schlafplätze', p.cap || ''],
      ['Feuerstelle/Ofen', p.fp ? yn(p.fp) : ''],
      ['Abgeschlossen', p.lk ? yn(p.lk) : ''],
      ['Trinkbar', p.dw ? yn(p.dw) : ''],
      ['Reservierung', p.res ? yn(p.res) : ''],
      ['Gebühr', p.fee ? yn(p.fee) : ''],
      ['Geöffnet', p.oh || ''],
      ['Betreiber', p.op || ''],
      ['Typ', p.ty ? String(p.ty).replace(/_/g, ' ') : ''],
      ['Entstanden', p.sd || '']
    ].filter((r) => r[1] !== '' && r[1] !== undefined);
    const web = [p.wp ? `<a class="hk-link" href="${esc(p.wp)}" target="_blank" rel="noopener">Wikipedia</a>` : '',
      p.web && /^https?:\/\//.test(p.web) ? `<a class="hk-link" href="${esc(p.web)}" target="_blank" rel="noopener">Website öffnen</a>` : ''].filter(Boolean).join(' · ');
    const desc = p.d ? `<p>${esc(p.d)}</p>` : '';
    const ll = f.geometry.coordinates;
    const html = `<div class="hk-pop">
      <div class="hk-head"><span class="hk-badge" style="background:${c.color}">${c.label[0]}</span><b>${esc(p.n || c.label)}</b></div>
      ${desc}
      ${rows.map((r) => `<div class="hk-row"><span>${r[0]}</span><b>${esc(r[1])}</b></div>`).join('')}
      ${web}
      <p class="small">Angaben aus OpenStreetMap, vor Ort können sie abweichen.</p>
      <div class="hk-actions"><button type="button" class="btn small-btn" data-a="save">Als Ort speichern</button><button type="button" class="btn primary small-btn" data-a="nav">Hierhin</button></div>
    </div>`;
    if (this.popup) this.popup.remove();
    this.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px', className: 'hk-popup' }).setLngLat(ll).setHTML(html).addTo(map);
    const el = this.popup.getElement();
    el.querySelector('[data-a="nav"]').onclick = () => { this.popup.remove(); Nav.choose({ lon: ll[0], lat: ll[1], name: p.n || c.label }); };
    el.querySelector('[data-a="save"]').onclick = () => {
      this.popup.remove();
      openEditor(null, { lat: ll[1], lon: ll[0] });
      editor.draft.name = p.n || c.label;
      if (p.e) editor.draft.ele = p.e;
      editor.draft.note = rows.map((r) => r[0] + ': ' + r[1]).join('\n');
      $('#spot-name').value = editor.draft.name;
      $('#spot-note').value = editor.draft.note;
    };
  },

  /* Wandermenü */
  open() {
    closeSearch(); closeSheet();
    if (typeof closeTrackInfo === 'function') closeTrackInfo();
    if (typeof Tours !== 'undefined') Tours.close();
    this.renderSheet();
    if (typeof Tours !== 'undefined') Tours.renderList();
    $('#hike-sheet').hidden = false;
  },
  close() { $('#hike-sheet').hidden = true; if (typeof Tours !== 'undefined' && Tours.browsing) Tours.closeBrowser(); },

  renderSheet() {
    $('#hk-on').checked = this.on();
    $('#hk-tracks').checked = store.get('hikeTracks', true);
    for (const [box, grp] of [[$('#hk-pts'), undefined], [$('#hk-see'), 'see']]) {
      box.innerHTML = '';
      for (const [k, c] of Object.entries(HK_PTS)) {
        if (c.g !== grp) continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hk-chip';
        b.setAttribute('aria-pressed', String(this.pts().includes(k)));
        b.innerHTML = `<span class="hk-chip-dot" style="background:${c.color}"></span>${c.label}`;
        b.onclick = () => {
          const on = new Set(this.pts());
          if (on.has(k)) on.delete(k); else on.add(k);
          store.set('hikePts', Object.keys(HK_PTS).filter((x) => on.has(x)));
          store.set('hikePtsKnown', Object.keys(HK_PTS));
          this.renderSheet();
          refreshStyle();
        };
        box.appendChild(b);
      }
    }
    document.querySelectorAll('[data-hkmax]').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.hkmax === this.max())));
    const legend = $('#hk-legend');
    legend.innerHTML = '';
    for (let i = 1; i <= 6; i++) {
      const s = SAC_INFO[i];
      const row = document.createElement('div');
      row.className = 'hk-leg' + (i > this.max() ? ' off' : '');
      row.innerHTML = `<span class="hk-dash" style="--c:${s.color}"></span><span class="hk-badge" style="background:${s.color}">${s.t}</span><span><b>${s.name}</b><small>${s.text}</small></span>`;
      legend.appendChild(row);
    }
    const n = this.keys().length;
    const off = Tiles.regions.filter((r) => this.regionDone(r)).map((r) => r.name);
    const need = Tiles.regions.filter((r) => Tiles.local.has(r.id) && this.keysFor(r.boxes).length && !this.regionDone(r)).map((r) => r.name);
    let txt = n ? `Online gibt es Wanderwege für ${n} Länder.` : 'Die Wanderwege werden gerade erstellt. Schau später nochmal rein.';
    if (off.length) txt += ` Offline gespeichert für: ${off.join(', ')}.`;
    if (need.length) txt += ` Für ${need.join(', ')} unter Menü → Offline-Karten „Wanderwege laden“ tippen.`;
    $('#hk-status').textContent = txt;
  },

  protocol() {
    maplibregl.addProtocol('hike', async (params) => {
      const m = params.url.match(/^hike:\/\/(\d+)\/(\d+)\/(\d+)/);
      const data = m ? await this.tile(+m[1], +m[2], +m[3]) : null;
      return { data: data || new ArrayBuffer(0) };
    });
  },

  setup() {
    const before = this.keys().length;
    Promise.all([this.scan(), this.loadIndex()]).then(() => { if (this.on() && (this.keys().length !== before || this.local.size)) refreshStyle(); });
    $('#btn-hike').onclick = () => ($('#hike-sheet').hidden ? this.open() : this.close());
    $('#hk-close').onclick = () => this.close();
    $('#hk-on').onchange = () => { store.set('hikeOn', $('#hk-on').checked); refreshStyle(); };
    $('#hk-tracks').onchange = () => { store.set('hikeTracks', $('#hk-tracks').checked); refreshStyle(); };
    document.querySelectorAll('[data-hkmax]').forEach((b) => {
      b.onclick = () => { store.set('hikeMax', +b.dataset.hkmax); this.renderSheet(); refreshStyle(); };
    });
    map.on('styleimagemissing', (e) => {
      if (!e.id || !e.id.startsWith('halt-') || map.hasImage(e.id)) return;
      const k = e.id.slice(5);
      const ratio = 2, size = 26;
      const cv = document.createElement('canvas');
      cv.width = cv.height = size * ratio;
      const g = cv.getContext('2d');
      g.scale(ratio, ratio);
      const color = { bahn: '#495057', ubahn: '#1C6DD0', sbahn: '#2F9E44', tram: '#C92A2A', bus: '#7048E8' }[k] || '#7048E8';
      g.beginPath();
      if (k === 'bus' || k === 'tram') g.arc(size / 2, size / 2, 10, 0, Math.PI * 2);
      else { const r = 4; g.moveTo(3 + r, 3); g.arcTo(size - 3, 3, size - 3, size - 3, r); g.arcTo(size - 3, size - 3, 3, size - 3, r); g.arcTo(3, size - 3, 3, 3, r); g.arcTo(3, 3, size - 3, 3, r); }
      g.fillStyle = color; g.fill(); g.lineWidth = 2; g.strokeStyle = '#FFFFFF'; g.stroke();
      g.fillStyle = '#FFFFFF'; g.font = '700 12px -apple-system, Helvetica, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText({ bus: 'H', tram: 'T', ubahn: 'U', sbahn: 'S', bahn: 'B' }[k] || 'H', size / 2, size / 2 + 0.5);
      map.addImage(e.id, g.getImageData(0, 0, size * ratio, size * ratio), { pixelRatio: ratio });
    });
    map.on('click', 'oev-halt', (e) => {
      const f = e.features && e.features[0];
      if (!f || (typeof Draw !== 'undefined' && Draw.active) || editor.open) return;
      this._ptTap = e.originalEvent;
      const p = f.properties;
      const kind = { bus: 'Bushaltestelle', tram: 'Straßenbahn', ubahn: 'U-Bahn', sbahn: 'S-Bahn / Stadtbahn', bahn: 'Bahnhof' }[p.k] || 'Haltestelle';
      const ll = f.geometry.coordinates;
      if (this.popup) this.popup.remove();
      const esc = (t) => String(t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
      this.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px', className: 'hk-popup' }).setLngLat(ll)
        .setHTML(`<div class="hk-pop"><div class="hk-head"><b>${esc(p.n || kind)}</b></div><p>${kind}</p><div class="hk-actions"><button type="button" class="btn primary small-btn" data-a="nav">Route hierher</button></div></div>`).addTo(map);
      this.popup.getElement().querySelector('[data-a="nav"]').onclick = () => { this.popup.remove(); Nav.choose({ lon: ll[0], lat: ll[1], name: p.n || kind }); };
    });
    map.on('styleimagemissing', (e) => {
      if (!e.id || !e.id.startsWith('hkpt-') || map.hasImage(e.id) || !HK_PTS[e.id.slice(5)]) return;
      const { image, ratio } = hikePointImage(e.id.slice(5));
      map.addImage(e.id, image, { pixelRatio: ratio });
    });
    map.on('click', 'hike-pts', (e) => {
      if ((typeof Draw !== 'undefined' && Draw.active) || editor.open || editor.moving) return;
      if (map.queryRenderedFeatures(e.point, { layers: ['places-icon', 'poi-icon'].filter((l) => map.getLayer(l)) }).length) return;
      const f = e.features && e.features[0];
      if (f) { this._ptTap = e.originalEvent; this.showPoint(f); }
    });
    map.on('mouseenter', 'hike-pts', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'hike-pts', () => { map.getCanvas().style.cursor = ''; });
    map.on('click', 'hike-hit', (e) => {
      if (this._ptTap === e.originalEvent) return;
      if (map.getLayer('oev-halt') && map.queryRenderedFeatures(e.point, { layers: ['oev-halt'] }).length) return;
      if ((typeof Draw !== 'undefined' && Draw.active) || editor.open || editor.moving) return;
      if (map.queryRenderedFeatures(e.point, { layers: ['places-icon', 'tracks-hit', 'tours-hit', 'tours-pt', 'hike-pts', 'poi-icon'].filter((l) => map.getLayer(l)) }).length) return;
      const f = e.features && e.features[0];
      if (f) this.showInfo(f, e.lngLat);
    });
  }
};
