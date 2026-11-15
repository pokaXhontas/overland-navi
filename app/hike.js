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

const Hike = {
  index: store.get('hikeIndex', {}),   // Kennung → { size, date, bbox, name, iso }
  local: new Map(),                     // Gebiet → Set der offline gespeicherten Kennungen
  arch: new Map(),

  on() { return store.get('hikeOn', true); },
  max() { return store.get('hikeMax', 6); },
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
    return ks.length > 0 && !!have && ks.every((k) => have.has(k));
  },

  async scan() {
    this.local.clear();
    this.arch.clear();
    const root = await Tiles.opfs();
    if (!root || !root.keys) return;
    const old = [];
    for await (const name of root.keys()) {
      const m = name.match(/^(.+)-hk-([a-z0-9-]+)\.idx\.ok$/);
      if (m) { if (!this.local.has(m[1])) this.local.set(m[1], new Set()); this.local.get(m[1]).add(m[2]); }
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
  layers(dark, sat) {
    if (!this.on() || (!this.keys().length && !this.local.size)) return { lines: [], labels: [] };
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
        { id: 'hike-hit', type: 'line', source: 'hike', 'source-layer': 'wege', filter: any, minzoom: 11, paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 } }
      ],
      labels: [
        { id: 'hike-label', type: 'symbol', source: 'hike', 'source-layer': 'wege', filter: f, minzoom: 13,
          layout: { 'symbol-placement': 'line', 'text-font': ['Noto Sans Medium'], 'text-size': 11, 'symbol-spacing': 280,
            'text-field': ['case', ['>', ['get', 's'], 0],
              ['concat', 'T', ['to-string', ['get', 's']], ['case', ['has', 'n'], ['concat', ' · ', ['get', 'n']], '']],
              ['coalesce', ['get', 'n'], ['get', 'ref'], '']] },
          paint: { 'text-color': sacColor, 'text-halo-color': dark || sat ? '#0B0F12' : '#FFFFFF', 'text-halo-width': 1.6 } }
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

  /* Wandermenü */
  open() {
    closeSearch(); closeSheet();
    if (typeof closeTrackInfo === 'function') closeTrackInfo();
    if (typeof Tours !== 'undefined') Tours.close();
    this.renderSheet();
    if (typeof Tours !== 'undefined') Tours.renderList();
    $('#hike-sheet').hidden = false;
  },
  close() { $('#hike-sheet').hidden = true; },

  renderSheet() {
    $('#hk-on').checked = this.on();
    $('#hk-tracks').checked = store.get('hikeTracks', true);
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
    map.on('click', 'hike-hit', (e) => {
      if ((typeof Draw !== 'undefined' && Draw.active) || editor.open || editor.moving) return;
      if (map.queryRenderedFeatures(e.point, { layers: ['places-icon', 'tracks-hit', 'tours-hit', 'tours-pt'].filter((l) => map.getLayer(l)) }).length) return;
      const f = e.features && e.features[0];
      if (f) this.showInfo(f, e.lngLat);
    });
  }
};
