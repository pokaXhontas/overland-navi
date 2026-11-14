/* Overland-Navi – Etappe 1: Karte, GPS, hell/dunkel, Offline-Karten, Plätze speichern */
'use strict';

const BASE = location.origin + location.pathname.replace(/[^/]*$/, '');
const DEM_PREFIX = BASE + 'tiles/dem/';
const DEM_MAXZOOM = 11;
const BASE_MAXZOOM = 14;
const $ = (sel) => document.querySelector(sel);

/* ---------- Einstellungen ---------- */
const store = {
  get(key, def) { try { const v = localStorage.getItem('ovl.' + key); return v === null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(key, val) { try { localStorage.setItem('ovl.' + key, JSON.stringify(val)); } catch (e) { /* voll oder privat */ } }
};
const settings = {
  theme: store.get('theme', 'auto'),
  contours: store.get('contours', true),
  hillshade: store.get('hillshade', true),
  headingUp: store.get('headingUp', true),
  wake: store.get('wake', true),
  hidden: store.get('hiddenCats', [])
};
let places = store.get('places', []);

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function fatal(msg) {
  const f = $('#fatal');
  f.hidden = false;
  f.textContent = msg;
}
function fmtBytes(n) {
  if (!n && n !== 0) return '–';
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' GB';
  if (n >= 1e6) return Math.round(n / 1e6) + ' MB';
  return Math.max(1, Math.round(n / 1e3)) + ' kB';
}

/* ---------- Kartendaten: lokal (OPFS) oder online (PMTiles per Range-Request) ---------- */
class FileSource {
  constructor(file, key) { this.file = file; this.key = key; }
  getKey() { return this.key; }
  async getBytes(offset, length) {
    const data = await this.file.slice(offset, offset + length).arrayBuffer();
    return { data };
  }
}

const Tiles = {
  regions: [],
  build: '',
  archives: new Map(),
  local: new Set(),
  ready: null,

  async init() {
    let json = null;
    try {
      const r = await fetch(BASE + 'data/regions.json', { cache: 'no-cache' });
      if (r.ok) json = await r.json();
    } catch (e) { /* offline: Service Worker liefert die gespeicherte Fassung */ }
    if (!json) json = store.get('regionsCache', null);
    if (json) store.set('regionsCache', json);
    this.regions = (json && json.regions) || [];
    this.build = (json && json.build) || '';
    await this.scanLocal();
  },

  async opfs() {
    if (!navigator.storage || !navigator.storage.getDirectory) return null;
    try { return await navigator.storage.getDirectory(); } catch (e) { return null; }
  },

  fileName(id, layer) { return `${id}-${layer}.${layer === 'search' ? 'json' : 'pmtiles'}`; },

  async scanLocal() {
    this.local.clear();
    const root = await this.opfs();
    if (!root) return;
    for (const r of this.regions) {
      let ok = true;
      for (const layer of ['base', 'dem']) {
        try { await root.getFileHandle(this.fileName(r.id, layer) + '.ok'); } catch (e) { ok = false; }
      }
      if (ok) this.local.add(r.id);
    }
  },

  reset() { this.archives.clear(); },

  async archive(region, layer) {
    const key = `${region.id}/${layer}`;
    if (this.archives.has(key)) return this.archives.get(key);
    let a = null;
    if (this.local.has(region.id)) {
      const root = await this.opfs();
      try {
        const fh = await root.getFileHandle(this.fileName(region.id, layer));
        const file = await fh.getFile();
        a = new pmtiles.PMTiles(new FileSource(file, key));
      } catch (e) { a = null; }
    }
    if (!a && navigator.onLine) a = new pmtiles.PMTiles(BASE + `data/${region.id}/${layer}.pmtiles`);
    if (a) this.archives.set(key, a);
    return a;
  },

  tileBounds(z, x, y) {
    const n = Math.pow(2, z);
    const lon1 = x / n * 360 - 180, lon2 = (x + 1) / n * 360 - 180;
    const lat = (t) => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) * 180 / Math.PI;
    return [lon1, lat(y + 1), lon2, lat(y)];
  },

  regionsFor(z, x, y) {
    const [w, s, e, nn] = this.tileBounds(z, x, y);
    return this.regions
      .filter((r) => !(e < r.bbox[0] || w > r.bbox[2] || nn < r.bbox[1] || s > r.bbox[3]))
      .sort((a, b) => (this.local.has(b.id) ? 1 : 0) - (this.local.has(a.id) ? 1 : 0));
  },

  async tile(layer, z, x, y) {
    await this.ready;
    for (const region of this.regionsFor(z, x, y)) {
      try {
        const a = await this.archive(region, layer);
        if (!a) continue;
        const res = await a.getZxy(z, x, y);
        if (res && res.data && res.data.byteLength) return res.data;
      } catch (e) { /* nächste Region versuchen */ }
    }
    return null;
  },

  regionAt(lon, lat) {
    return this.regions.find((r) => lon >= r.bbox[0] && lon <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3]) || null;
  }
};
Tiles.ready = Tiles.init();

/* Höhendaten-Kacheln für das Höhenlinien-Plugin: fetch abfangen, bevor das Plugin lädt */
const originalFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith(DEM_PREFIX)) {
    const m = url.slice(DEM_PREFIX.length).match(/^(\d+)\/(\d+)\/(\d+)/);
    if (m) {
      const data = await Tiles.tile('dem', +m[1], +m[2], +m[3]);
      if (!data) return new Response(null, { status: 404, statusText: 'Keine Höhendaten' });
      return new Response(data, { status: 200, headers: { 'Content-Type': 'image/webp' } });
    }
  }
  return originalFetch(input, init);
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Konnte ' + src + ' nicht laden'));
    document.head.appendChild(s);
  });
}

/* ---------- Farbschema ---------- */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function isDark() {
  return settings.theme === 'dark' || (settings.theme === 'auto' && darkQuery.matches);
}
function applyThemeClass() {
  document.documentElement.classList.toggle('dark', isDark());
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = isDark() ? '#0B0F12' : '#F2F0EA';
}

/* ---------- Kartenstil ---------- */
let demSource = null;
let map = null;

function buildStyle() {
  const dark = isDark();
  const flavorName = dark ? 'dark' : 'light';
  const B = window.basemaps || window.protomaps_basemaps;
  const baseLayers = B.layers('protomaps', B.namedFlavor(flavorName), { lang: 'de' });

  const hill = {
    id: 'hillshade', type: 'hillshade', source: 'dem',
    layout: { visibility: settings.hillshade ? 'visible' : 'none' },
    paint: dark
      ? { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': 'rgba(255,255,255,0.18)', 'hillshade-accent-color': '#000000' }
      : { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': '#4A3B2A', 'hillshade-highlight-color': '#FFFFFF', 'hillshade-accent-color': '#6B5A45' }
  };
  const lineColor = dark ? 'rgba(181,195,202,0.35)' : 'rgba(110,80,50,0.45)';
  const contourLine = {
    id: 'contours', type: 'line', source: 'contours', 'source-layer': 'contours',
    layout: { visibility: settings.contours ? 'visible' : 'none', 'line-join': 'round' },
    paint: { 'line-color': lineColor, 'line-width': ['match', ['get', 'level'], 1, 1.1, 0.5] }
  };
  const contourText = {
    id: 'contour-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours',
    filter: ['>', ['get', 'level'], 0],
    layout: {
      visibility: settings.contours ? 'visible' : 'none',
      'symbol-placement': 'line', 'text-size': 10, 'text-font': ['Noto Sans Regular'],
      'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m']
    },
    paint: { 'text-color': dark ? '#B5C3CA' : '#6E5234', 'text-halo-color': dark ? '#0B0F12' : '#FFFFFF', 'text-halo-width': 1.2 }
  };

  let at = baseLayers.findIndex((l) => /^roads/.test(l.id) || /^buildings/.test(l.id));
  if (at < 0) at = baseLayers.findIndex((l) => l.type === 'symbol');
  if (at < 0) at = baseLayers.length;
  const layers = [...baseLayers.slice(0, at), hill, contourLine, ...baseLayers.slice(at), contourText];

  layers.push(
    {
      id: 'tracks-casing', type: 'line', source: 'tracks',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': dark ? '#0B0F12' : '#FFFFFF', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 14, 8], 'line-opacity': 0.9 }
    },
    {
      id: 'tracks-line', type: 'line', source: 'tracks',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.2, 14, 4.5] }
    },
    {
      id: 'tracks-label', type: 'symbol', source: 'tracks', minzoom: 11,
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-offset': [0, -1] },
      paint: { 'text-color': ['get', 'color'], 'text-halo-color': dark ? '#0B0F12' : '#FFFFFF', 'text-halo-width': 1.6 }
    }
  );
  layers.push(
    {
      id: 'places-icon', type: 'symbol', source: 'places',
      layout: { 'icon-image': ['concat', 'cat-', ['get', 'cat']], 'icon-allow-overlap': true, 'icon-ignore-placement': true }
    },
    {
      id: 'places-label', type: 'symbol', source: 'places',
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 13, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': dark ? '#EEF2F4' : '#15191D', 'text-halo-color': dark ? '#0B0F12' : '#FFFFFF', 'text-halo-width': 1.5 }
    }
  );

  return {
    version: 8,
    glyphs: BASE + 'fonts/{fontstack}/{range}.pbf',
    sprite: BASE + 'sprites/v4/' + flavorName,
    sources: {
      protomaps: {
        type: 'vector', tiles: ['ovl://base/{z}/{x}/{y}'], maxzoom: BASE_MAXZOOM,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>'
      },
      dem: {
        type: 'raster-dem', tiles: [demSource.sharedDemProtocolUrl], tileSize: 512, maxzoom: DEM_MAXZOOM, encoding: 'terrarium',
        attribution: 'Höhen: <a href="https://mapterhorn.com">Mapterhorn</a>'
      },
      contours: {
        type: 'vector', maxzoom: 15,
        tiles: [demSource.contourProtocolUrl({
          multiplier: 1,
          thresholds: { 9: [200, 1000], 10: [100, 500], 11: [100, 500], 12: [50, 250], 13: [20, 100], 14: [10, 50], 15: [10, 50] },
          elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours', overzoom: 1
        })]
      },
      places: { type: 'geojson', data: placesGeoJSON() },
      tracks: { type: 'geojson', data: tracksGeoJSON() }
    },
    layers
  };
}

function refreshStyle() {
  if (!map) return;
  Tiles.reset();
  applyThemeClass();
  map.setStyle(buildStyle(), { diff: false });
}

/* ---------- GPS ---------- */
const gps = { pos: null, last: null, heading: null, speed: null, alt: null, follow: true, watch: null };
let meMarker = null;

function compassText(deg) {
  const dirs = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8] + ' ' + Math.round(deg) + '°';
}

function distance(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearingDeg(a, b) {
  const toR = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * toR) * Math.cos(b.lat * toR);
  const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lon - a.lon) * toR);
  return (Math.atan2(y, x) / toR + 360) % 360;
}

function onPosition(p) {
  const c = p.coords;
  const cur = { lat: c.latitude, lon: c.longitude, t: p.timestamp };
  let speed = (c.speed !== null && c.speed >= 0) ? c.speed : null;
  let heading = (c.heading !== null && !isNaN(c.heading) && c.heading >= 0) ? c.heading : null;
  if (gps.last) {
    const d = distance(gps.last, cur);
    const dt = (cur.t - gps.last.t) / 1000;
    if (speed === null && dt > 0) speed = d / dt;
    if (heading === null && d > 8) heading = bearingDeg(gps.last, cur);
  }
  if (!gps.last || distance(gps.last, cur) > 5) gps.last = cur;
  if (heading !== null && (speed === null || speed > 0.8)) gps.heading = heading;
  gps.speed = speed;
  gps.pos = cur;
  gps.alt = (c.altitude === null || c.altitude === undefined) ? null : c.altitude;

  $('#spd').textContent = speed === null ? '0' : Math.round(speed * 3.6);
  $('#crs').textContent = gps.heading === null ? '–' : compassText(gps.heading);
  $('#alt').textContent = (c.altitude === null || c.altitude === undefined) ? '–' : Math.round(c.altitude).toLocaleString('de-DE') + ' m';
  $('#acc').textContent = '± ' + Math.round(c.accuracy) + ' m';

  if (!map) return;
  if (!meMarker) {
    const el = document.createElement('div');
    el.className = 'me nohead';
    el.innerHTML = '<svg viewBox="0 0 24 24"><path class="arrow" d="M12 2.5 20 21l-8-4.2L4 21Z"/></svg>';
    meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([cur.lon, cur.lat]).addTo(map);
  }
  meMarker.setLngLat([cur.lon, cur.lat]);
  const el = meMarker.getElement();
  if (gps.heading !== null) { el.classList.remove('nohead'); meMarker.setRotation(gps.heading); } else { el.classList.add('nohead'); }

  if (!gps.hadFix) {
    gps.hadFix = true;
    if (gps.follow && !editor.open) map.jumpTo({ center: [cur.lon, cur.lat], zoom: Math.max(map.getZoom(), 14) });
  }
  if (gps.follow && !editor.open) {
    const moving = speed !== null && speed > 1.5;
    const opts = { center: [cur.lon, cur.lat], duration: 700, essential: true };
    if (settings.headingUp && moving && gps.heading !== null) opts.bearing = gps.heading;
    map.easeTo(opts);
  }
}

function onPositionError(err) {
  if (err.code === 1) {
    stopGPS();
    $('#acc').textContent = 'aus';
    toast('Standort ist blockiert. Einstellungen → Datenschutz & Sicherheit → Ortungsdienste → Safari-Websites → „Beim Verwenden der App“ wählen und „Genauer Standort“ einschalten.', 10000);
  } else if (err.code === 3) {
    $('#acc').textContent = 'sucht';
    if (!gps.pos) toast('Suche GPS-Signal … draußen oder am Fenster geht es schneller.', 4000);
  } else {
    $('#acc').textContent = 'kein';
    toast('Kein GPS-Signal. Ortungsdienste eingeschaltet?', 5000);
  }
}

function stopGPS() {
  if (gps.watch !== null) { navigator.geolocation.clearWatch(gps.watch); gps.watch = null; }
}

function startGPS() {
  if (!('geolocation' in navigator)) { toast('Dieses Gerät meldet keine Standortfunktion.'); return; }
  if (gps.watch !== null) return;
  gps.watch = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 0 });
}

function locateNow() {
  if (editor.open) closeEditor();
  gps.follow = true;
  $('#btn-locate').classList.add('active');
  if (gps.pos) {
    map.easeTo({ center: [gps.pos.lon, gps.pos.lat], zoom: Math.max(map.getZoom(), 14), duration: 600 });
  } else {
    toast('Suche Standort …', 3000);
    $('#acc').textContent = 'sucht';
  }
  if (!('geolocation' in navigator)) return;
  // Direkt beim Antippen fragen: so zeigt iOS die Erlaubnis-Abfrage zuverlässig
  navigator.geolocation.getCurrentPosition(
    (p) => { gps.hadFix = false; onPosition(p); },
    onPositionError,
    { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }
  );
  stopGPS();
  startGPS();
}

/* ---------- Bildschirm anlassen ---------- */
let wakeLock = null;
async function updateWakeLock() {
  try {
    if (settings.wake && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } else if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) { /* nicht unterstützt oder abgelehnt */ }
}
document.addEventListener('visibilitychange', updateWakeLock);

/* ---------- Statusanzeige oben rechts ---------- */
function updateChip() {
  if (!map) return;
  const c = map.getCenter();
  const r = Tiles.regionAt(c.lng, c.lat);
  const dot = $('#mapdot'), txt = $('#maptxt');
  dot.className = 'dot';
  if (r && Tiles.local.has(r.id)) { dot.classList.add('ok'); txt.textContent = 'Offline: ' + r.name; }
  else if (r && navigator.onLine) { dot.classList.add('warn'); txt.textContent = 'Online: ' + r.name; }
  else if (r) { dot.classList.add('err'); txt.textContent = r.name + ' nicht geladen'; }
  else { dot.classList.add('err'); txt.textContent = 'Keine Karte für dieses Gebiet'; }
}
window.addEventListener('online', () => { Tiles.reset(); updateChip(); });
window.addEventListener('offline', () => { Tiles.reset(); updateChip(); });

/* ---------- Plätze ---------- */
const CATS = [
  { id: 'wild', label: 'Wildcamping', color: '#FF7A1A', ink: '#140A02', d: 'M2 20h20M4 20 12 5l8 15M12 20l-3-5M12 20l3-5' },
  { id: 'camp', label: 'Campingplatz', color: '#2F9E44', ink: '#FFFFFF', d: 'M3 20h18M5 20V10l7-6 7 6v10M10 20v-5h4v5' },
  { id: 'water', label: 'Wasser', color: '#1C7ED6', ink: '#FFFFFF', d: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z' },
  { id: 'mech', label: 'Werkstatt', color: '#6741D9', ink: '#FFFFFF', d: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z' },
  { id: 'fuel', label: 'Diesel', color: '#495057', ink: '#FFFFFF', d: 'M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M4 10h10M14 8l3 3v6a1.5 1.5 0 0 0 3 0V9l-3-3' },
  { id: 'border', label: 'Grenze', color: '#C2255C', ink: '#FFFFFF', d: 'M5 21V4M5 4h11l-2 4 2 4H5' },
  { id: 'warn', label: 'Warnung', color: '#F59F00', ink: '#2A1E00', d: 'M12 4 2.5 20h19ZM12 10v4M12 17h.01' },
  { id: 'other', label: 'Sonstiges', color: '#868E96', ink: '#FFFFFF', d: 'M12 21s6-5.4 6-10.5a6 6 0 0 0-12 0C6 15.6 12 21 12 21ZM12 10.5h.01' }
];
const CAT = Object.fromEntries(CATS.map((c) => [c.id, c]));
const FEATS = [
  ['eben', 'Eben'], ['wind', 'Windgeschützt'], ['wasser', 'Wasser in der Nähe'],
  ['netz', 'Handynetz'], ['ruhig', 'Ruhig'], ['allrad', 'Nur mit Allrad'], ['schatten', 'Schatten']
];

// ältere Einträge auf das neue Format bringen
places = places.map((p, i) => ({
  id: p.id || Date.now() + i,
  name: p.name || 'Platz ' + (i + 1),
  cat: CAT[p.cat] ? p.cat : 'wild',
  rating: p.rating || 0,
  feats: Array.isArray(p.feats) ? p.feats : [],
  note: p.note || '',
  photos: Array.isArray(p.photos) ? p.photos : [],
  lat: p.lat, lon: p.lon,
  ele: typeof p.ele === 'number' ? p.ele : (parseInt(String(p.ele || '').replace(/\D/g, ''), 10) || null),
  time: p.time || new Date().toISOString(),
  updated: p.updated || p.time || new Date().toISOString()
}));

function placesGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: places.filter((p) => !settings.hidden.includes(p.cat)).map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { id: p.id, name: p.name, cat: p.cat }
    }))
  };
}

function placeIconImage(cat) {
  const c = CAT[cat] || CAT.other;
  const ratio = 2, size = 44;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size * ratio;
  const g = cv.getContext('2d');
  g.scale(ratio, ratio);
  g.beginPath();
  g.arc(size / 2, size / 2, 18, 0, Math.PI * 2);
  g.fillStyle = c.color;
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = isDark() ? '#0B0F12' : '#FFFFFF';
  g.stroke();
  g.translate(size / 2 - 10.8, size / 2 - 10.8);
  g.scale(0.9, 0.9);
  g.strokeStyle = c.ink;
  g.lineWidth = 2.4;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.stroke(new Path2D(c.d));
  return { image: g.getImageData(0, 0, size * ratio, size * ratio), ratio };
}

function savePlaces() {
  store.set('places', places);
  const src = map && map.getSource('places');
  if (src) src.setData(placesGeoJSON());
  $('#places-count').textContent = places.length + (places.length === 1 ? ' Ort' : ' Orte');
  renderPlaceList();
}

/* Fotos: verkleinert in IndexedDB */
const PhotoDB = {
  put(id, blob) { return DB.run('photos', 'readwrite', (st) => st.put(blob, id)); },
  get(id) { return DB.run('photos', 'readonly', (st) => st.get(id)); },
  del(id) { return DB.run('photos', 'readwrite', (st) => st.delete(id)); }
};

async function shrinkPhoto(file) {
  try {
    const bmp = await createImageBitmap(file);
    const max = 1600;
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * k);
    cv.height = Math.round(bmp.height * k);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return await new Promise((res) => cv.toBlob((b) => res(b || file), 'image/jpeg', 0.82));
  } catch (e) { return file; }
}

/* Bearbeiten-Fenster */
const editor = { open: false, id: null, draft: null, moving: false, newPhotos: [], removedPhotos: [], confirmDelete: false };

function wideLayout() { return window.innerWidth > 600; }

function setEditorPadding() {
  const sheet = $('#spot');
  let pad = { top: 0, left: 0, right: 0, bottom: 0 };
  if (editor.open) {
    if (wideLayout()) pad.right = sheet.offsetWidth;
    else pad.bottom = sheet.offsetHeight;
  }
  document.documentElement.style.setProperty('--pad-r', pad.right + 'px');
  document.documentElement.style.setProperty('--pad-b', pad.bottom + 'px');
  return pad;
}

function editorCenter() {
  if (editor.moving) { const c = map.getCenter(); return { lat: c.lat, lon: c.lng }; }
  return { lat: editor.draft.lat, lon: editor.draft.lon };
}

function updateEditorCoords() {
  if (!editor.open) return;
  const c = editorCenter();
  const ele = editor.draft.ele ? ' · ' + editor.draft.ele.toLocaleString('de-DE') + ' m' : '';
  $('#spot-coords').textContent = `${c.lat.toFixed(5).replace('.', ',')}° N · ${c.lon.toFixed(5).replace('.', ',')}° O${ele}`;
}

function setMoving(on) {
  editor.moving = on;
  $('#crosshair').hidden = !on;
  $('#move-hint').hidden = !on;
  $('#spot-move').textContent = on ? 'Position wird verschoben …' : 'Position verschieben';
  $('#spot-move').disabled = on;
  if (map.getLayer('places-icon')) {
    const f = on && editor.id ? ['!=', ['get', 'id'], editor.id] : null;
    map.setFilter('places-icon', f);
    map.setFilter('places-label', f);
  }
  updateEditorCoords();
}

function renderChips() {
  const cats = $('#spot-cats');
  cats.innerHTML = '';
  for (const c of CATS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn' + (editor.draft.cat === c.id ? ' on' : '');
    b.setAttribute('aria-pressed', String(editor.draft.cat === c.id));
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${c.d}"/></svg><span></span>`;
    b.querySelector('span').textContent = c.label;
    b.onclick = () => { editor.draft.cat = c.id; renderChips(); };
    cats.appendChild(b);
  }
  const feats = $('#spot-feats');
  feats.innerHTML = '';
  for (const [id, label] of FEATS) {
    const on = editor.draft.feats.includes(id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn small' + (on ? ' on-soft' : '');
    b.setAttribute('aria-pressed', String(on));
    b.textContent = label;
    b.onclick = () => {
      const f = editor.draft.feats;
      editor.draft.feats = on ? f.filter((x) => x !== id) : [...f, id];
      renderChips();
    };
    feats.appendChild(b);
  }
  const stars = $('#spot-stars');
  stars.innerHTML = '';
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'star' + (n <= editor.draft.rating ? ' on' : '');
    b.setAttribute('aria-label', n + (n === 1 ? ' Stern' : ' Sterne'));
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9Z"/></svg>';
    b.onclick = () => { editor.draft.rating = editor.draft.rating === n ? 0 : n; renderChips(); };
    stars.appendChild(b);
  }
}

async function renderPhotos() {
  const box = $('#spot-photos');
  box.querySelectorAll('.thumb').forEach((t) => { URL.revokeObjectURL(t.dataset.url); t.remove(); });
  const add = $('#spot-photo-add');
  const all = [...editor.draft.photos.filter((id) => !editor.removedPhotos.includes(id)).map((id) => ({ id })), ...editor.newPhotos];
  for (const ph of all) {
    let blob = ph.blob;
    if (!blob) { try { blob = await PhotoDB.get(ph.id); } catch (e) { blob = null; } }
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    const div = document.createElement('div');
    div.className = 'thumb';
    div.dataset.url = url;
    div.style.backgroundImage = `url("${url}")`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'thumb-del';
    del.setAttribute('aria-label', 'Foto entfernen');
    del.textContent = '×';
    del.onclick = () => {
      if (ph.blob) editor.newPhotos = editor.newPhotos.filter((x) => x !== ph);
      else editor.removedPhotos.push(ph.id);
      renderPhotos();
    };
    div.appendChild(del);
    box.insertBefore(div, add);
  }
}

function openEditor(place, at) {
  closeSheet();
  gps.follow = false;
  $('#btn-locate').classList.remove('active');
  const isNew = !place;
  let ele = null;
  if (isNew && gps.pos && gps.alt !== null && at && distance(gps.pos, at) < 60) ele = Math.round(gps.alt);
  editor.open = true;
  editor.id = isNew ? null : place.id;
  editor.draft = isNew
    ? { name: '', cat: null, rating: 0, feats: [], note: '', photos: [], lat: at.lat, lon: at.lon, ele }
    : JSON.parse(JSON.stringify(place));
  editor.newPhotos = [];
  editor.removedPhotos = [];
  editor.confirmDelete = false;

  $('#spot-title').textContent = isNew ? 'Neuer Ort' : 'Ort bearbeiten';
  $('#spot-name').value = editor.draft.name;
  $('#spot-note').value = editor.draft.note;
  $('#spot-delete').hidden = isNew;
  $('#spot-delete').textContent = 'Ort löschen';
  $('#spot-move').hidden = isNew;
  renderChips();
  renderPhotos();

  const sheet = $('#spot');
  sheet.hidden = false;
  sheet.querySelector('.sheet-body').scrollTop = 0;
  requestAnimationFrame(() => {
    const padding = setEditorPadding();
    map.easeTo({ center: [editor.draft.lon, editor.draft.lat], zoom: Math.max(map.getZoom(), 15), padding, duration: 500 });
    setMoving(isNew);
  });
}

function closeEditor() {
  editor.open = false;
  $('#spot').hidden = true;
  $('#crosshair').hidden = true;
  $('#move-hint').hidden = true;
  editor.moving = false;
  if (map.getLayer('places-icon')) { map.setFilter('places-icon', null); map.setFilter('places-label', null); }
  map.easeTo({ padding: setEditorPadding(), duration: 300 });
}

async function saveEditor() {
  const d = editor.draft;
  if (!d.cat) d.cat = 'other';
  const c = editorCenter();
  d.lat = +c.lat.toFixed(6);
  d.lon = +c.lon.toFixed(6);
  d.note = $('#spot-note').value.trim();
  const now = new Date().toISOString();
  if (!editor.id) {
    const n = places.filter((p) => p.cat === d.cat).length + 1;
    d.name = $('#spot-name').value.trim() || `${CAT[d.cat].label} ${n}`;
  } else {
    d.name = $('#spot-name').value.trim() || d.name;
  }
  for (const id of editor.removedPhotos) { try { await PhotoDB.del(id); } catch (e) { /* egal */ } }
  d.photos = d.photos.filter((id) => !editor.removedPhotos.includes(id));
  for (const ph of editor.newPhotos) {
    const id = 'ph-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    try { await PhotoDB.put(id, ph.blob); d.photos.push(id); } catch (e) { toast('Foto konnte nicht gespeichert werden.'); }
  }
  d.updated = now;
  if (editor.id) {
    places = places.map((p) => (p.id === editor.id ? d : p));
  } else {
    d.id = Date.now();
    d.time = now;
    places.push(d);
  }
  savePlaces();
  toast(settings.hidden.includes(d.cat) ? `„${d.name}“ gespeichert. ${CAT[d.cat].label} ist gerade ausgeblendet.` : `„${d.name}“ gespeichert`);
  closeEditor();
}

async function deleteEditorPlace() {
  if (!editor.confirmDelete) {
    editor.confirmDelete = true;
    $('#spot-delete').textContent = 'Wirklich löschen? Nochmal tippen';
    return;
  }
  const p = places.find((x) => x.id === editor.id);
  if (p) for (const id of p.photos) { try { await PhotoDB.del(id); } catch (e) { /* egal */ } }
  places = places.filter((x) => x.id !== editor.id);
  savePlaces();
  toast('Ort gelöscht');
  closeEditor();
}

function newPlaceHere() {
  const at = gps.pos ? { lat: gps.pos.lat, lon: gps.pos.lon } : (() => { const c = map.getCenter(); return { lat: c.lat, lon: c.lng }; })();
  if (!gps.pos) toast('Kein GPS – der Ort startet in der Kartenmitte');
  openEditor(null, at);
}

function renderPlaceList() { renderDataCats(); refreshCatPage(); }
function exportGPX() {
  if (!places.length) { toast('Noch keine Orte gespeichert.'); return; }
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const wpts = places.map((p) => {
    const feats = p.feats.map((f) => (FEATS.find((x) => x[0] === f) || [f, f])[1]);
    const desc = [p.rating ? p.rating + '/5 Sterne' : '', feats.join(', '), p.note].filter(Boolean).join('\n');
    return `  <wpt lat="${p.lat}" lon="${p.lon}">${p.ele ? `<ele>${p.ele}</ele>` : ''}<time>${p.time}</time><name>${esc(p.name)}</name>${desc ? `<desc>${esc(desc)}</desc>` : ''}<type>${esc((CAT[p.cat] || CAT.other).label)}</type></wpt>`;
  }).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Overland-Navi" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts}\n</gpx>\n`;
  const file = new File([gpx], 'overland-orte.gpx', { type: 'application/gpx+xml' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'Overland-Orte' }).catch(() => {});
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

function setupEditorUI() {
  $('#spot-close').onclick = closeEditor;
  $('#spot-cancel').onclick = closeEditor;
  $('#spot-save').onclick = saveEditor;
  $('#spot-delete').onclick = deleteEditorPlace;
  $('#spot-move').onclick = () => {
    map.easeTo({ center: [editor.draft.lon, editor.draft.lat], duration: 300 });
    setMoving(true);
  };
  $('#spot-file').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) editor.newPhotos.push({ blob: await shrinkPhoto(f) });
    renderPhotos();
  };
  window.addEventListener('resize', () => { if (editor.open) map.easeTo({ padding: setEditorPadding(), duration: 0 }); });
}

/* Langes Drücken auf die Karte legt einen Platz an */
function setupLongPress() {
  let timer = null, start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  map.on('touchstart', (e) => {
    cancel();
    if (editor.open || !e.originalEvent || e.originalEvent.touches.length !== 1) return;
    start = e.point;
    const ll = e.lngLat;
    timer = setTimeout(() => {
      timer = null;
      if (navigator.vibrate) navigator.vibrate(20);
      openEditor(null, { lat: ll.lat, lon: ll.lng });
    }, 650);
  });
  map.on('touchmove', (e) => { if (timer && start && (Math.abs(e.point.x - start.x) > 10 || Math.abs(e.point.y - start.y) > 10)) cancel(); });
  map.on('touchend', cancel);
  map.on('touchcancel', cancel);
  map.on('movestart', (e) => { if (e.originalEvent) cancel(); });
  map.on('contextmenu', (e) => { if (!editor.open) openEditor(null, { lat: e.lngLat.lat, lon: e.lngLat.lng }); });
}

/* ---------- Offline-Karten herunterladen ---------- */
const downloads = new Map();

const GLYPH_RANGES = ['0-255', '256-511', '512-767', '768-1023', '1024-1279', '1280-1535', '8192-8447', '8448-8703'];
const FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
async function cacheAssets() {
  if (!('caches' in window)) return;
  const cache = await caches.open('ovl-assets');
  const urls = [];
  for (const f of FONTS) for (const r of GLYPH_RANGES) urls.push(BASE + 'fonts/' + encodeURIComponent(f) + '/' + r + '.pbf');
  for (const fl of ['light', 'dark']) for (const s of ['', '@2x']) for (const ext of ['.json', '.png']) urls.push(BASE + 'sprites/v4/' + fl + s + ext);
  await Promise.all(urls.map((u) => cache.add(u).catch(() => {})));
}

function startDownload(region) {
  if (downloads.has(region.id)) return;
  const worker = new Worker('dl-worker.js');
  const total = region.files.reduce((s, f) => s + f.size, 0);
  const job = { worker, loaded: 0, total };
  downloads.set(region.id, job);
  renderRegions();
  const keepAwake = settings.wake;
  settings.wake = true; updateWakeLock();
  worker.onmessage = async (e) => {
    const m = e.data;
    if (m.type === 'progress') { job.loaded = m.loaded; updateProgress(region.id); }
    if (m.type === 'done') {
      worker.terminate(); downloads.delete(region.id);
      settings.wake = keepAwake; updateWakeLock();
      await cacheAssets();
      await Tiles.scanLocal(); Tiles.reset();
      toast(region.name + ' ist jetzt offline verfügbar');
      renderRegions(); updateStorage(); updateChip();
      refreshStyle();
    }
    if (m.type === 'error') {
      worker.terminate(); downloads.delete(region.id);
      settings.wake = keepAwake; updateWakeLock();
      toast('Download abgebrochen: ' + m.message, 5000);
      renderRegions();
    }
  };
  worker.postMessage({
    files: region.files.map((f) => ({ url: BASE + f.path, name: Tiles.fileName(region.id, f.layer), size: f.size }))
  });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

async function deleteRegion(region) {
  const root = await Tiles.opfs();
  if (!root) return;
  for (const layer of ['base', 'dem', 'search']) {
    for (const suffix of ['.ok', '']) {
      try { await root.removeEntry(Tiles.fileName(region.id, layer) + suffix); } catch (e) { /* schon weg */ }
    }
  }
  await Tiles.scanLocal(); Tiles.reset();
  toast(region.name + ' gelöscht');
  renderRegions(); updateStorage(); updateChip(); refreshStyle();
}

function updateProgress(id) {
  const job = downloads.get(id);
  const el = document.querySelector(`[data-region="${id}"]`);
  if (!job || !el) return;
  const pct = job.total ? Math.min(100, Math.round(job.loaded / job.total * 100)) : 0;
  el.querySelector('.bar > div').style.width = pct + '%';
  el.querySelector('.state').textContent = `${pct} % · ${fmtBytes(job.loaded)} von ${fmtBytes(job.total)}`;
}

function renderRegions() {
  const box = $('#regions');
  if (!Tiles.regions.length) {
    box.innerHTML = '<p class="muted">Keine Kartengebiete gefunden. Ist die App schon veröffentlicht?</p>';
    return;
  }
  box.innerHTML = '';
  for (const r of Tiles.regions) {
    const size = r.files.reduce((s, f) => s + f.size, 0);
    const local = Tiles.local.has(r.id);
    const job = downloads.get(r.id);
    const div = document.createElement('div');
    div.className = 'region';
    div.dataset.region = r.id;
    div.innerHTML = `
      <div class="region-top">
        <span><b></b><small class="muted state"></small></span>
        <button class="btn"></button>
      </div>`;
    div.querySelector('b').textContent = r.name;
    const btn = div.querySelector('button');
    const state = div.querySelector('.state');
    if (job) {
      state.textContent = 'Wird geladen …';
      btn.textContent = 'Läuft';
      btn.disabled = true;
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.innerHTML = '<div></div>';
      div.appendChild(bar);
    } else if (local) {
      state.innerHTML = '<span class="state-ok">✓ Offline verfügbar</span> · ' + fmtBytes(size);
      btn.textContent = 'Löschen';
      btn.classList.add('danger');
      btn.onclick = () => deleteRegion(r);
    } else {
      state.textContent = fmtBytes(size) + ' · nur online';
      btn.textContent = 'Laden';
      btn.classList.add('primary');
      btn.onclick = () => {
        if (!navigator.onLine) { toast('Zum Laden brauchst du eine Internetverbindung.'); return; }
        startDownload(r);
      };
    }
    box.appendChild(div);
    if (job) updateProgress(r.id);
  }
}

async function updateStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  try {
    const e = await navigator.storage.estimate();
    $('#storage').textContent = `Belegt: ${fmtBytes(e.usage)} · verfügbar für die App: ${fmtBytes(e.quota)}`;
  } catch (err) { /* egal */ }
}

/* ---------- Bedienelemente ---------- */
function setupUI() {
  const sheet = $('#sheet');
  $('#btn-layers').onclick = () => { if (editor.open) closeEditor(); closeSearch(); renderRegions(); updateStorage(); closeCatPage(); renderDataCats(); sheet.hidden = false; };
  $('#sheet-close').onclick = closeSheet;
  $('#cat-close').onclick = closeSheet;
  $('#cat-back').onclick = closeCatPage;

  document.querySelectorAll('.seg button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.theme === settings.theme));
    b.onclick = () => {
      settings.theme = b.dataset.theme; store.set('theme', settings.theme);
      document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      refreshStyle();
    };
  });
  darkQuery.addEventListener('change', () => { if (settings.theme === 'auto') refreshStyle(); });

  const bindToggle = (id, key, apply) => {
    const el = $(id);
    el.checked = settings[key];
    el.onchange = () => { settings[key] = el.checked; store.set(key, el.checked); apply(); };
  };
  bindToggle('#t-contours', 'contours', () => {
    for (const id of ['contours', 'contour-labels']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', settings.contours ? 'visible' : 'none');
  });
  bindToggle('#t-hillshade', 'hillshade', () => {
    if (map.getLayer('hillshade')) map.setLayoutProperty('hillshade', 'visibility', settings.hillshade ? 'visible' : 'none');
  });
  bindToggle('#t-headingup', 'headingUp', () => { updateCompassButton(); if (!settings.headingUp) map.easeTo({ bearing: 0 }); });
  bindToggle('#t-wake', 'wake', updateWakeLock);

  $('#btn-compass').onclick = () => {
    settings.headingUp = !settings.headingUp; store.set('headingUp', settings.headingUp);
    $('#t-headingup').checked = settings.headingUp;
    updateCompassButton();
    if (!settings.headingUp) map.easeTo({ bearing: 0 });
    toast(settings.headingUp ? 'Karte dreht sich in Fahrtrichtung' : 'Norden ist oben');
  };
  $('#btn-locate').onclick = locateNow;
  $('#zin').onclick = () => map.zoomIn();
  $('#zout').onclick = () => map.zoomOut();
  $('#fab').onclick = newPlaceHere;
  setupEditorUI();
  setupSearchAndImport();
  $('#btn-gpx').onclick = exportGPX;
  savePlaces();
  updateCompassButton();
  $('#btn-locate').classList.add('active');
}

function updateCompassButton() {
  $('#compass-label').textContent = settings.headingUp ? 'FAHRT' : 'N';
  $('#btn-compass').classList.toggle('active', settings.headingUp);
}

/* ---------- Gemeinsame Datenbank (Fotos, Tracks) ---------- */
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('overland', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
        if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  },
  async run(storeName, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const r = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(r && r.result);
      tx.onerror = () => reject(tx.error);
    });
  }
};

/* ---------- Suche ---------- */
const CYR = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya', 'ң': 'ng', 'ө': 'o', 'ү': 'u', 'қ': 'q', 'ғ': 'gh', 'ҳ': 'h', 'ә': 'a', 'і': 'i', 'ұ': 'u', 'ӯ': 'u', 'ҷ': 'j' };
function norm(s) {
  s = String(s || '').toLowerCase();
  let out = '';
  for (const ch of s) out += (CYR[ch] !== undefined ? CYR[ch] : ch);
  return out.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
}

const TYPE_INFO = {
  city: ['Stadt', 30, 11], town: ['Stadt', 26, 12], village: ['Dorf', 18, 14], hamlet: ['Weiler', 12, 15], suburb: ['Stadtteil', 16, 14],
  quarter: ['Viertel', 12, 15], locality: ['Ort', 8, 14], isolated_dwelling: ['Gehöft', 6, 16],
  peak: ['Gipfel', 14, 13], pass: ['Pass', 16, 14], spring: ['Quelle', 10, 16], glacier: ['Gletscher', 10, 13], water: ['See', 14, 13],
  river: ['Fluss', 10, 12], camp: ['Campingplatz', 12, 16], hut: ['Hütte', 10, 16], view: ['Aussicht', 8, 16], sight: ['Sehenswürdigkeit', 8, 16],
  fuel: ['Tankstelle', 10, 16], drink: ['Trinkwasser', 8, 17], border: ['Grenzkontrolle', 14, 15], own: ['Mein Ort', 40, 16], other: ['Ort', 4, 15]
};
const TYPE_ICON = {
  peak: 'm3 20 6-11 4 6 3-4 5 9Z', pass: 'm3 20 6-11 4 6 3-4 5 9Z', glacier: 'm3 20 6-11 4 6 3-4 5 9Z',
  water: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z', spring: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z', drink: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z', river: 'M3 8c3-2 6 2 9 0s6-2 9 0M3 16c3-2 6 2 9 0s6-2 9 0',
  fuel: 'M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M4 10h10M14 8l3 3v6a1.5 1.5 0 0 0 3 0V9l-3-3',
  camp: 'M2 20h20M4 20 12 5l8 15M12 20l-3-5M12 20l3-5', hut: 'M3 20h18M5 20V10l7-6 7 6v10M10 20v-5h4v5',
  border: 'M5 21V4M5 4h11l-2 4 2 4H5', coord: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  default: 'M12 21s6-5.4 6-10.5a6 6 0 0 0-12 0C6 15.6 12 21 12 21ZM12 10.5h.01'
};

const Search = {
  items: [],
  loaded: new Set(),
  loading: null,
  searchMarker: null,

  async loadAll() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      await Tiles.ready;
      const root = await Tiles.opfs();
      for (const r of Tiles.regions) {
        if (this.loaded.has(r.id)) continue;
        let json = null;
        if (root) {
          try {
            const fh = await root.getFileHandle(Tiles.fileName(r.id, 'search'));
            json = JSON.parse(await (await fh.getFile()).text());
          } catch (e) { json = null; }
        }
        if (!json) {
          const f = (r.files || []).find((x) => x.layer === 'search');
          if (f) { try { const resp = await fetch(BASE + f.path); if (resp.ok) json = await resp.json(); } catch (e) { json = null; } }
        }
        if (!json || !json.items) continue;
        for (const it of json.items) {
          const [name, alts, type, lat, lon, ele] = it;
          const keys = [norm(name), ...String(alts || '').split('|').filter(Boolean).map(norm)];
          this.items.push({ name, alts, type, lat, lon, ele, keys, region: r.name });
        }
        this.loaded.add(r.id);
      }
      this.loading = null;
    })();
    return this.loading;
  },

  parseCoords(q) {
    const t = q.trim();
    let m = t.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
    if (!m) m = t.match(/^(-?\d{1,2}(?:,\d+)?)\s*[;\s]\s*(-?\d{1,3}(?:,\d+)?)$/);
    if (!m) return null;
    const lat = parseFloat(m[1].replace(',', '.')), lon = parseFloat(m[2].replace(',', '.'));
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, type: 'coord', lat, lon, sub: 'Koordinaten' };
  },

  query(q) {
    const nq = norm(q);
    const results = [];
    const coord = this.parseCoords(q);
    if (coord) results.push(coord);
    if (nq.length < 2) return results;
    const ref = gps.pos || (map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : null);
    const score = (keys) => {
      let best = 0;
      for (const k of keys) {
        if (!k) continue;
        if (k === nq) return 100;
        if (k.startsWith(nq)) best = Math.max(best, 80);
        else if (k.includes(' ' + nq)) best = Math.max(best, 60);
        else if (nq.length >= 3 && k.includes(nq)) best = Math.max(best, 30);
      }
      return best;
    };
    for (const p of places) {
      const s = score([norm(p.name), norm(p.note)]);
      if (s) results.push({ name: p.name, type: 'own', lat: p.lat, lon: p.lon, place: p, score: s + 40, sub: 'Mein Ort · ' + (CAT[p.cat] || CAT.other).label });
    }
    const hits = [];
    for (const it of this.items) {
      const s = score(it.keys);
      if (!s) continue;
      const w = (TYPE_INFO[it.type] || TYPE_INFO.other)[1];
      let dist = 0;
      if (ref) dist = distance(ref, it);
      hits.push({ ...it, score: s + w - Math.min(25, dist / 20000) });
    }
    hits.sort((a, b) => b.score - a.score);
    for (const h of hits.slice(0, 40)) {
      const label = (TYPE_INFO[h.type] || TYPE_INFO.other)[0];
      const extra = h.ele ? ` · ${h.ele.toLocaleString('de-DE')} m` : '';
      const alt = h.alts ? ' · ' + h.alts.split('|')[0] : '';
      h.sub = `${label}${extra}${alt}`;
      results.push(h);
    }
    results.sort((a, b) => (b.type === 'coord') - (a.type === 'coord') || (b.score || 0) - (a.score || 0));
    if (ref) for (const r of results) r.dist = distance(ref, r);
    return results.slice(0, 40);
  },

  async online(q) {
    if (!navigator.onLine || q.trim().length < 3) return [];
    const c = map.getCenter();
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=de&limit=8&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}`;
    try {
      const r = await originalFetch(url);
      if (!r.ok) return [];
      const j = await r.json();
      const ref = gps.pos || { lat: c.lat, lon: c.lng };
      return (j.features || []).map((f) => {
        const p = f.properties || {};
        const [lon, lat] = f.geometry.coordinates;
        const where = [p.street && (p.street + (p.housenumber ? ' ' + p.housenumber : '')), p.postcode, p.city || p.county, p.country].filter(Boolean).join(', ');
        return { name: p.name || where || 'Adresse', type: 'web', lat, lon, sub: 'Online · ' + where, dist: distance(ref, { lat, lon }), zoom: p.osm_key === 'place' ? 13 : 16 };
      });
    } catch (e) { return []; }
  },

  show(r) {
    closeSearch();
    if (r.place) { openEditor(r.place); return; }
    gps.follow = false;
    $('#btn-locate').classList.remove('active');
    const zoom = r.zoom || (TYPE_INFO[r.type] || [null, null, 15])[2] || 15;
    map.flyTo({ center: [r.lon, r.lat], zoom, essential: true });
    if (this.searchMarker) this.searchMarker.remove();
    const el = document.createElement('div');
    el.className = 'search-pin';
    el.innerHTML = '<div class="sp-card panel"><b></b><small></small><button class="btn primary sp-save">Als Ort speichern</button><button class="round sp-x" aria-label="Markierung entfernen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div><div class="sp-dot"></div>';
    el.querySelector('b').textContent = r.name;
    el.querySelector('small').textContent = r.sub || '';
    el.querySelector('.sp-save').onclick = (ev) => {
      ev.stopPropagation();
      const at = { lat: r.lat, lon: r.lon };
      this.searchMarker.remove(); this.searchMarker = null;
      openEditor(null, at);
      $('#spot-name').value = r.type === 'coord' ? '' : r.name;
    };
    el.querySelector('.sp-x').onclick = (ev) => { ev.stopPropagation(); this.searchMarker.remove(); this.searchMarker = null; };
    this.searchMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([r.lon, r.lat]).addTo(map);
  }
};

function fmtDist(d) {
  if (d === undefined || d === null) return '';
  return d >= 10000 ? Math.round(d / 1000) + ' km' : d >= 1000 ? (d / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(d) + ' m';
}

function renderSearchResults(list, note) {
  const box = $('#search-results');
  box.innerHTML = '';
  if (note) { const p = document.createElement('p'); p.className = 'muted small sr-note'; p.textContent = note; box.appendChild(p); }
  for (const r of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'place-item';
    const color = r.type === 'own' ? (CAT[r.place.cat] || CAT.other).color : r.type === 'web' ? '#5B6670' : 'var(--faint)';
    const ink = r.type === 'own' ? (CAT[r.place.cat] || CAT.other).ink : r.type === 'web' ? '#fff' : 'var(--text)';
    const d = r.type === 'own' ? (CAT[r.place.cat] || CAT.other).d : (TYPE_ICON[r.type] || TYPE_ICON.default);
    b.innerHTML = `<span class="pi-icon" style="background:${color};color:${ink}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg></span><span class="pi-txt"><b></b><small></small></span><span class="pi-dist"></span>`;
    b.querySelector('b').textContent = r.name;
    b.querySelector('small').textContent = r.sub || '';
    b.querySelector('.pi-dist').textContent = fmtDist(r.dist);
    b.onclick = () => Search.show(r);
    box.appendChild(b);
  }
}

let searchTimer = null, searchSeq = 0;
async function runSearch() {
  const q = $('#search-input').value;
  const seq = ++searchSeq;
  if (!q.trim()) { renderSearchResults([], 'Suche nach Orten, Gipfeln, Pässen, Seen, Flüssen, Tankstellen, deinen eigenen Orten oder Koordinaten (z. B. 39.02, 73.48).'); return; }
  if (Search.loading) renderSearchResults([], 'Suchindex wird geladen …');
  await Search.loadAll();
  if (seq !== searchSeq) return;
  const local = Search.query(q);
  renderSearchResults(local, local.length ? '' : (navigator.onLine ? 'Suche online …' : 'Nichts gefunden. Offline sind nur Orte aus geladenen Kartengebieten suchbar.'));
  const web = await Search.online(q);
  if (seq !== searchSeq) return;
  if (web.length) renderSearchResults([...local, ...web.filter((w) => !local.some((l) => distance(l, w) < 300 && norm(l.name) === norm(w.name)))]);
  else if (!local.length) renderSearchResults([], 'Nichts gefunden.');
}

function openSearch() {
  if (editor.open) closeEditor();
  closeSheet();
  $('#search').hidden = false;
  const inp = $('#search-input');
  inp.focus();
  inp.select();
  runSearch();
  Search.loadAll();
}
function closeSearch() {
  $('#search').hidden = true;
  $('#search-input').blur();
}

/* ---------- Tracks ---------- */
const TRACK_COLORS = ['#4F6FE0', '#C2255C', '#2F9E44', '#7048E8', '#0B7285', '#E8590C', '#5C940D'];
let tracks = [];

function trackLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += distance({ lat: coords[i - 1][1], lon: coords[i - 1][0] }, { lat: coords[i][1], lon: coords[i][0] });
  return d;
}

function tracksGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: (settings.hidden.includes('tracks') ? [] : tracks.filter((t) => t.visible)).map((t) => ({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: t.segments.map((seg) => seg.map((c) => [c[0], c[1]])) },
      properties: { id: t.id, name: t.name, color: t.color }
    }))
  };
}

async function loadTracks() {
  try { tracks = (await DB.run('tracks', 'readonly', (s) => s.getAll())) || []; } catch (e) { tracks = []; }
  tracks.sort((a, b) => (a.created || 0) - (b.created || 0));
  updateTracksSource();
}
function updateTracksSource() {
  const src = map && map.getSource('tracks');
  if (src) src.setData(tracksGeoJSON());
  renderTrackList();
}
async function saveTrack(t) { await DB.run('tracks', 'readwrite', (s) => s.put(t)); }

function trackBounds(t) {
  const b = new maplibregl.LngLatBounds();
  for (const seg of t.segments) for (const c of seg) b.extend([c[0], c[1]]);
  return b;
}

function renderTrackList() { renderDataCats(); refreshCatPage(); }

function buildTrackRow(t) {
  const row = document.createElement('div');
  row.className = 'track-item';
  row.innerHTML = `<button type="button" class="ti-main"><span class="ti-color"></span><span class="pi-txt"><b></b><small></small></span></button><input type="checkbox" class="switch" aria-label="Track anzeigen"><button type="button" class="round ti-del" aria-label="Track löschen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button>`;
  row.querySelector('.ti-color').style.background = t.color;
  row.querySelector('b').textContent = t.name;
  row.querySelector('small').textContent = fmtDist(t.length) + (t.source ? ' · ' + t.source : '');
  row.querySelector('.ti-main').onclick = () => {
    closeSheet();
    if (!t.visible) { t.visible = true; saveTrack(t); }
    if (settings.hidden.includes('tracks')) setCatHidden('tracks', false);
    updateTracksSource();
    gps.follow = false; $('#btn-locate').classList.remove('active');
    map.fitBounds(trackBounds(t), { padding: 80, maxZoom: 15 });
  };
  const sw = row.querySelector('.switch');
  sw.checked = !!t.visible;
  sw.onchange = () => { t.visible = sw.checked; saveTrack(t); updateTracksSource(); };
  const del = row.querySelector('.ti-del');
  del.onclick = async () => {
    if (!del.classList.contains('confirm')) { del.classList.add('confirm'); toast('Zum Löschen nochmal tippen'); setTimeout(() => del.classList.remove('confirm'), 3000); return; }
    await DB.run('tracks', 'readwrite', (st) => st.delete(t.id));
    tracks = tracks.filter((x) => x !== t);
    updateTracksSource();
    toast('Track gelöscht');
  };
  return row;
}

/* ---------- Kategorien: ein-/ausblenden und Inhalte ansehen ---------- */
const TRACK_CAT = { id: 'tracks', label: 'Tracks', color: '#4F6FE0', ink: '#FFFFFF', d: 'M4 19c3-6 5 2 8-4s5-2 8-8M4 19h.01M20 7h.01' };
let openCat = null;

function catDef(id) { return id === 'tracks' ? TRACK_CAT : (CAT[id] || CAT.other); }
function catItems(id) { return id === 'tracks' ? tracks : places.filter((p) => p.cat === id); }

function setCatHidden(id, hidden) {
  const set = new Set(settings.hidden);
  if (hidden) set.add(id); else set.delete(id);
  settings.hidden = [...set];
  store.set('hiddenCats', settings.hidden);
  const ps = map && map.getSource('places');
  if (ps) ps.setData(placesGeoJSON());
  const ts = map && map.getSource('tracks');
  if (ts) ts.setData(tracksGeoJSON());
  renderDataCats();
}

function renderDataCats() {
  const box = $('#cat-list');
  if (!box) return;
  $('#places-count').textContent = places.length + (places.length === 1 ? ' Ort' : ' Orte') + ' · ' + tracks.length + (tracks.length === 1 ? ' Track' : ' Tracks');
  box.innerHTML = '';
  for (const c of [TRACK_CAT, ...CATS]) {
    const n = catItems(c.id).length;
    const row = document.createElement('div');
    row.className = 'cat-row' + (n ? '' : ' empty');
    row.innerHTML = `<button type="button" class="cat-open"><span class="pi-icon" style="background:${c.color};color:${c.ink}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${c.d}"/></svg></span><span class="pi-txt"><b></b><small></small></span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button><input type="checkbox" class="switch">`;
    row.querySelector('b').textContent = c.label;
    const hidden = settings.hidden.includes(c.id);
    row.querySelector('small').textContent = (n === 0 ? 'leer' : n + (c.id === 'tracks' ? (n === 1 ? ' Track' : ' Tracks') : (n === 1 ? ' Ort' : ' Orte'))) + (hidden ? ' · ausgeblendet' : '');
    row.querySelector('.cat-open').onclick = () => openCatPage(c.id);
    const sw = row.querySelector('.switch');
    sw.checked = !hidden;
    sw.setAttribute('aria-label', c.label + ' auf der Karte zeigen');
    sw.onchange = () => setCatHidden(c.id, !sw.checked);
    box.appendChild(row);
  }
}

function openCatPage(id) {
  openCat = id;
  refreshCatPage();
  const page = $('#cat-page');
  page.hidden = false;
  page.querySelector('.sheet-body').scrollTop = 0;
}
function closeCatPage() { openCat = null; $('#cat-page').hidden = true; }
function closeSheet() { closeCatPage(); $('#sheet').hidden = true; }

function refreshCatPage() {
  if (!openCat) return;
  const c = catDef(openCat);
  const items = catItems(openCat);
  const icon = $('#cat-icon');
  icon.style.background = c.color;
  icon.style.color = c.ink;
  icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${c.d}"/></svg>`;
  $('#cat-name').textContent = c.label;
  $('#cat-count').textContent = items.length ? `${items.length} Einträge, bleiben gespeichert, auch wenn ausgeblendet` : 'Noch nichts in dieser Kategorie';
  const tg = $('#cat-toggle');
  tg.checked = !settings.hidden.includes(openCat);
  tg.onchange = () => setCatHidden(openCat, !tg.checked);
  const box = $('#cat-items');
  box.innerHTML = '';
  if (openCat === 'tracks') {
    for (const t of tracks) box.appendChild(buildTrackRow(t));
    return;
  }
  const ref = gps.pos || (map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : null);
  const list = items.map((p) => ({ p, d: ref ? distance(ref, p) : null })).sort((a, b) => (a.d || 0) - (b.d || 0));
  for (const { p, d } of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'place-item';
    b.innerHTML = `<span class="pi-icon" style="background:${c.color};color:${c.ink}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${c.d}"/></svg></span><span class="pi-txt"><b></b><small></small></span><span class="pi-dist"></span>`;
    b.querySelector('b').textContent = p.name;
    b.querySelector('small').textContent = [p.rating ? '★'.repeat(p.rating) : '', p.note ? p.note.slice(0, 60) : '', p.source ? 'aus ' + p.source : ''].filter(Boolean).join(' · ') || ' ';
    b.querySelector('.pi-dist').textContent = fmtDist(d);
    b.onclick = () => { closeSheet(); openEditor(p); };
    box.appendChild(b);
  }
}

/* ---------- Import: GPX, KML, KMZ, ZIP ---------- */
async function unzip(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine gültige ZIP-Datei');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true), xlen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, off + 46, nlen));
    off += 46 + nlen + xlen + clen;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const data = new Uint8Array(buf, start, csize);
    entries.push({
      name,
      async text() {
        if (method === 0) return new TextDecoder().decode(data);
        if (method !== 8) throw new Error('Unbekannte Kompression in ' + name);
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return await new Response(stream).text();
      }
    });
  }
  return entries;
}

function xmlText(el, tag) {
  const n = el.getElementsByTagName(tag)[0];
  return n ? n.textContent.trim() : '';
}

function parseGPX(text, source) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('GPX-Datei ist fehlerhaft');
  const wpts = [], trks = [];
  for (const w of doc.getElementsByTagName('wpt')) {
    wpts.push({ lat: +w.getAttribute('lat'), lon: +w.getAttribute('lon'), name: xmlText(w, 'name'), desc: xmlText(w, 'desc') || xmlText(w, 'cmt'), type: xmlText(w, 'type') + ' ' + xmlText(w, 'sym'), ele: parseFloat(xmlText(w, 'ele')) || null });
  }
  const lines = (el, ptTag) => [...el.getElementsByTagName(ptTag)].map((p) => [+p.getAttribute('lon'), +p.getAttribute('lat'), parseFloat(xmlText(p, 'ele')) || null]);
  for (const t of doc.getElementsByTagName('trk')) {
    const segs = [...t.getElementsByTagName('trkseg')].map((s) => lines(s, 'trkpt')).filter((s) => s.length > 1);
    if (segs.length) trks.push({ name: xmlText(t, 'name') || source, segments: segs });
  }
  for (const r of doc.getElementsByTagName('rte')) {
    const seg = lines(r, 'rtept');
    if (seg.length > 1) trks.push({ name: xmlText(r, 'name') || source, segments: [seg] });
  }
  return { wpts, trks };
}

function parseKML(text, source) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('KML-Datei ist fehlerhaft');
  const wpts = [], trks = [];
  const parseCoords = (s) => s.trim().split(/\s+/).map((c) => c.split(',').map(Number)).filter((c) => c.length >= 2 && !isNaN(c[0]) && !isNaN(c[1])).map((c) => [c[0], c[1], c[2] || null]);
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const name = xmlText(pm, 'name');
    const desc = xmlText(pm, 'description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const segs = [];
    for (const ls of pm.getElementsByTagName('LineString')) {
      const c = parseCoords(xmlText(ls, 'coordinates'));
      if (c.length > 1) segs.push(c);
    }
    const gxTracks = pm.getElementsByTagNameNS('*', 'Track');
    for (const tr of gxTracks) {
      const c = [...tr.getElementsByTagNameNS('*', 'coord')].map((n) => n.textContent.trim().split(/\s+/).map(Number)).filter((v) => v.length >= 2).map((v) => [v[0], v[1], v[2] || null]);
      if (c.length > 1) segs.push(c);
    }
    if (segs.length) { trks.push({ name: name || source, segments: segs }); continue; }
    const pt = pm.getElementsByTagName('Point')[0];
    if (pt) {
      const c = parseCoords(xmlText(pt, 'coordinates'))[0];
      if (c) wpts.push({ lat: c[1], lon: c[0], ele: c[2], name, desc, type: '' });
    }
  }
  return { wpts, trks };
}

function guessCategory(w) {
  const s = norm(`${w.name} ${w.type} ${w.desc}`);
  const has = (re) => re.test(s);
  if (has(/\b(wasser|water|quelle|spring|brunnen|trinkwasser|drinking)/)) return 'water';
  if (has(/\b(diesel|fuel|tank|petrol|gas station|benzin|azs)/)) return 'fuel';
  if (has(/\b(werkstatt|mechanic|garage|repair|reifen|tyre|tire)/)) return 'mech';
  if (has(/\b(grenze|border|checkpoint|zoll|customs)/)) return 'border';
  if (has(/\b(warnung|achtung|danger|gefahr|warning|furt|ford)/)) return 'warn';
  if (has(/\b(campingplatz|campground|camping|guesthouse|hostel)/)) return 'camp';
  if (has(/\b(camp|zelt|tent|biwak|bivouac|wild|stellplatz|schlafplatz|overnight|nacht)/)) return 'wild';
  return 'other';
}

async function importFiles(fileList) {
  const jobs = [];
  for (const f of fileList) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.zip') || lower.endsWith('.kmz')) {
      try {
        for (const e of await unzip(await f.arrayBuffer())) {
          const n = e.name.toLowerCase();
          if (n.endsWith('.gpx') || n.endsWith('.kml')) jobs.push({ name: e.name.split('/').pop(), kind: n.endsWith('.gpx') ? 'gpx' : 'kml', text: () => e.text(), source: f.name });
        }
      } catch (err) { toast(f.name + ': ' + err.message, 5000); }
    } else if (lower.endsWith('.kml')) {
      jobs.push({ name: f.name, kind: 'kml', text: () => f.text(), source: f.name });
    } else {
      jobs.push({ name: f.name, kind: 'gpx', text: () => f.text(), source: f.name });
    }
  }
  let nPlaces = 0, nTracks = 0, skipped = 0, errors = 0;
  const bounds = new maplibregl.LngLatBounds();
  for (const j of jobs) {
    let res;
    try {
      const text = await j.text();
      const base = j.name.replace(/\.(gpx|kml)$/i, '');
      res = j.kind === 'kml' ? parseKML(text, base) : parseGPX(text, base);
    } catch (err) { errors++; continue; }
    for (const w of res.wpts) {
      if (!isFinite(w.lat) || !isFinite(w.lon)) continue;
      const dupe = places.some((p) => distance(p, w) < 25 && (!w.name || norm(p.name) === norm(w.name)));
      if (dupe) { skipped++; continue; }
      const cat = guessCategory(w);
      const now = new Date().toISOString();
      places.push({
        id: Date.now() + Math.floor(Math.random() * 100000), name: w.name || `${CAT[cat].label} ${places.length + 1}`, cat,
        rating: 0, feats: [], note: w.desc || '', photos: [], lat: +w.lat.toFixed(6), lon: +w.lon.toFixed(6),
        ele: w.ele ? Math.round(w.ele) : null, time: now, updated: now, source: j.source
      });
      bounds.extend([w.lon, w.lat]);
      nPlaces++;
    }
    for (const t of res.trks) {
      const track = {
        id: 'trk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        name: t.name, color: TRACK_COLORS[tracks.length % TRACK_COLORS.length],
        segments: t.segments, visible: true, created: Date.now(), source: j.source
      };
      track.length = track.segments.reduce((s, seg) => s + trackLength(seg), 0);
      try { await saveTrack(track); } catch (e) { errors++; continue; }
      tracks.push(track);
      for (const seg of t.segments) for (const c of seg) bounds.extend([c[0], c[1]]);
      nTracks++;
    }
  }
  savePlaces();
  updateTracksSource();
  const parts = [];
  if (nTracks) parts.push(nTracks + (nTracks === 1 ? ' Track' : ' Tracks'));
  if (nPlaces) parts.push(nPlaces + (nPlaces === 1 ? ' Ort' : ' Orte'));
  let msg = parts.length ? parts.join(' und ') + ' importiert' : 'Nichts gefunden, was sich importieren lässt';
  if (skipped) msg += ` · ${skipped} doppelt übersprungen`;
  if (errors) msg += ` · ${errors} Datei(en) fehlerhaft`;
  toast(msg, 5000);
  if (!bounds.isEmpty()) {
    closeSheet();
    gps.follow = false; $('#btn-locate').classList.remove('active');
    map.fitBounds(bounds, { padding: 80, maxZoom: 14 });
  }
}

function setupSearchAndImport() {
  $('#btn-search').onclick = openSearch;
  $('#search-close').onclick = closeSearch;
  $('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 220); });
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSearch();
    if (e.key === 'Enter') { const first = $('#search-results .place-item'); if (first) first.click(); }
  });
  $('#import-file').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) { toast('Importiere …'); await importFiles(files); }
  };
}

/* ---------- Start ---------- */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Neue Version: einmal automatisch neu laden, damit Updates sofort greifen
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !downloads.size) location.reload();
    hadController = true;
  });
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  } catch (e) { console.warn('Service Worker:', e); }
}

async function main() {
  applyThemeClass();
  if (!window.maplibregl || !window.pmtiles || !(window.basemaps || window.protomaps_basemaps)) {
    fatal('Die Kartenbibliotheken fehlen. Öffne die App einmal mit Internetverbindung.');
    return;
  }
  registerServiceWorker();
  try {
    await loadScript('vendor/maplibre-contour.js');
  } catch (e) {
    fatal('Das Höhenlinien-Modul fehlt. Öffne die App einmal mit Internetverbindung.');
    return;
  }

  maplibregl.addProtocol('ovl', async (params) => {
    const m = params.url.match(/^ovl:\/\/(\w+)\/(\d+)\/(\d+)\/(\d+)/);
    if (!m) throw new Error('Ungültige Kachel');
    const data = await Tiles.tile(m[1], +m[2], +m[3], +m[4]);
    return { data: data || new ArrayBuffer(0) };
  });

  demSource = new mlcontour.DemSource({
    url: DEM_PREFIX + '{z}/{x}/{y}.webp',
    encoding: 'terrarium',
    maxzoom: DEM_MAXZOOM,
    worker: false,
    cacheSize: 100,
    timeoutMs: 20000
  });
  demSource.setupMaplibre(maplibregl);

  await Tiles.ready;
  const view = store.get('view', { center: [13.405, 52.52], zoom: 11 });
  map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(),
    center: view.center,
    zoom: view.zoom,
    maxZoom: 18,
    minZoom: 3,
    attributionControl: { compact: true },
    dragRotate: true,
    pitchWithRotate: false
  });
  map.touchZoomRotate.enableRotation();

  map.on('dragstart', () => { gps.follow = false; $('#btn-locate').classList.remove('active'); });
  map.on('rotate', () => { $('#needle').style.transform = `rotate(${-map.getBearing()}deg)`; });
  map.on('moveend', () => {
    const c = map.getCenter();
    store.set('view', { center: [+c.lng.toFixed(5), +c.lat.toFixed(5)], zoom: +map.getZoom().toFixed(2) });
    updateChip();
  });
  map.on('load', updateChip);
  map.on('styleimagemissing', (e) => {
    if (!e.id || !e.id.startsWith('cat-') || map.hasImage(e.id)) return;
    const { image, ratio } = placeIconImage(e.id.slice(4));
    map.addImage(e.id, image, { pixelRatio: ratio });
  });
  map.on('click', 'places-icon', (e) => {
    if (editor.moving) return;
    const f = e.features && e.features[0];
    const p = f && places.find((x) => x.id === f.properties.id);
    if (p) openEditor(p);
  });
  map.on('mouseenter', 'places-icon', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'places-icon', () => { map.getCanvas().style.cursor = ''; });
  map.on('move', () => { if (editor.open && editor.moving) updateEditorCoords(); });
  setupLongPress();
  loadTracks();
  map.on('error', (e) => { if (e && e.error) console.warn('Karte:', e.error.message || e.error); });

  setupUI();
  startGPS();
  updateWakeLock();
}

main().catch((e) => fatal('Fehler beim Start: ' + (e && e.message ? e.message : e)));
