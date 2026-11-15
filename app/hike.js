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
  archives: new Map(),
  local: new Set(),

  on() { return store.get('hikeOn', true); },
  max() { return store.get('hikeMax', 6); },
  regions() { return Tiles.regions.filter((r) => r.hike); },
  url(r) { return Tiles.sources.hike ? Tiles.sources.hike.replace('{id}', r.id) : null; },

  async scan() {
    this.local.clear();
    const root = await Tiles.opfs();
    if (!root) return;
    for (const r of Tiles.regions) if (await Tiles.exists(root, `${r.id}-hike.ok`)) this.local.add(r.id);
    this.archives.clear();
  },

  async archive(r) {
    const key = r.id + (this.local.has(r.id) ? '/lokal' : '/online');
    if (this.archives.has(key)) return this.archives.get(key);
    let a = null;
    try {
      if (this.local.has(r.id)) {
        const root = await Tiles.opfs();
        const file = await (await root.getFileHandle(`${r.id}-hike.pmtiles`)).getFile();
        a = new pmtiles.PMTiles(new FileSource(file, key));
      } else if (navigator.onLine && this.url(r)) {
        a = new pmtiles.PMTiles(this.url(r));
      }
    } catch (e) { a = null; }
    this.archives.set(key, a);
    return a;
  },

  async tile(z, x, y) {
    const n = Math.pow(2, z);
    const lon = (x + 0.5) / n * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI;
    const hits = this.regions().filter((r) => r.boxes.some((b) => lon >= b[0] - 0.5 && lon <= b[2] + 0.5 && lat >= b[1] - 0.5 && lat <= b[3] + 0.5));
    hits.sort((a, b) => this.local.has(b.id) - this.local.has(a.id));
    for (const r of hits) {
      const a = await this.archive(r);
      if (!a) continue;
      try {
        const t = await a.getZxy(z, x, y);
        if (t && t.data) return t.data;
      } catch (e) { /* nächste Datei */ }
    }
    return null;
  },

  /* Kartenebenen; werden in buildStyle eingefügt */
  layers(dark, sat) {
    if (!this.on() || !this.regions().length) return { lines: [], labels: [] };
    const max = this.max();
    const f = ['any', ['==', ['get', 's'], 0], ['<=', ['get', 's'], max]];
    const sacColor = ['match', ['get', 's'], 1, '#E3A700', 2, '#D62828', 3, '#D62828', 4, '#1C6DD0', 5, '#1C6DD0', 6, '#1C6DD0', dark || sat ? '#C9A27A' : '#8A5A2B'];
    const routeColor = ['match', ['coalesce', ['get', 'c'], ''], ...Object.entries(ROUTE_COLORS).flat(), '#C2255C'];
    const w = (a, b) => ['interpolate', ['linear'], ['zoom'], 11, a, 16, b];
    return {
      lines: [
        { id: 'hike-route', type: 'line', source: 'hike', 'source-layer': 'wege', filter: ['all', f, ['has', 'net']], layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': routeColor, 'line-opacity': 0.28, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 12, 7, 16, 12] } },
        { id: 'hike-casing', type: 'line', source: 'hike', 'source-layer': 'wege', filter: f, minzoom: 11, layout: { 'line-join': 'round' },
          paint: { 'line-color': dark || sat ? 'rgba(11,15,18,0.65)' : 'rgba(255,255,255,0.85)', 'line-width': w(2.6, 5.4) } },
        { id: 'hike-line', type: 'line', source: 'hike', 'source-layer': 'wege', filter: f, layout: { 'line-join': 'round' },
          paint: { 'line-color': sacColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 11, 1.4, 16, 3.2], 'line-dasharray': [2, 1.3] } },
        { id: 'hike-hit', type: 'line', source: 'hike', 'source-layer': 'wege', filter: f, minzoom: 11, paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 } }
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
          : '<div class="hk-head"><span class="hk-badge" style="background:#8A5A2B">–</span><b>Pfad ohne Schwierigkeitsangabe</b></div>'}
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
    this.renderSheet();
    $('#hike-sheet').hidden = false;
  },
  close() { $('#hike-sheet').hidden = true; },

  renderSheet() {
    $('#hk-on').checked = this.on();
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
    const have = this.regions();
    const off = have.filter((r) => this.local.has(r.id)).map((r) => r.name);
    const need = have.filter((r) => Tiles.local.has(r.id) && !this.local.has(r.id)).map((r) => r.name);
    let txt = have.length ? `Wanderwege gibt es für: ${have.map((r) => r.name).join(', ')}.` : 'Die Wanderwege werden gerade erstellt. Schau später nochmal rein.';
    if (off.length) txt += ` Offline gespeichert: ${off.join(', ')}.`;
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
    this.scan().then(() => { if (this.on() && this.regions().length) refreshStyle(); });
    $('#btn-hike').onclick = () => ($('#hike-sheet').hidden ? this.open() : this.close());
    $('#hk-close').onclick = () => this.close();
    $('#hk-on').onchange = () => { store.set('hikeOn', $('#hk-on').checked); refreshStyle(); };
    document.querySelectorAll('[data-hkmax]').forEach((b) => {
      b.onclick = () => { store.set('hikeMax', +b.dataset.hkmax); this.renderSheet(); refreshStyle(); };
    });
    map.on('click', 'hike-hit', (e) => {
      if ((typeof Draw !== 'undefined' && Draw.active) || editor.open || editor.moving) return;
      if (map.queryRenderedFeatures(e.point, { layers: ['places-icon', 'tracks-hit'].filter((l) => map.getLayer(l)) }).length) return;
      const f = e.features && e.features[0];
      if (f) this.showInfo(f, e.lngLat);
    });
  }
};
