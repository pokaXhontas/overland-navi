/* Lädt ein Kartengebiet: schneidet Karte und Höhenmodell direkt aus den großen Online-Archiven aus
 * und speichert alles im privaten App-Speicher (Origin Private File System).
 * Ein abgebrochener Download wird beim nächsten Start an der gleichen Stelle fortgesetzt. */
'use strict';
importScripts('extract.js');

async function writeWhole(root, name, bytes) {
  const fh = await root.getFileHandle(name, { create: true });
  const h = await fh.createSyncAccessHandle();
  try { h.truncate(0); h.write(bytes, { at: 0 }); h.flush(); } finally { h.close(); }
}
async function readJson(root, name) {
  try { return JSON.parse(await (await (await root.getFileHandle(name)).getFile()).text()); } catch (e) { return null; }
}
async function exists(root, name) {
  try { await root.getFileHandle(name); return true; } catch (e) { return false; }
}
async function remove(root, name) {
  try { await root.removeEntry(name); } catch (e) { /* gab es nicht */ }
}

/* ---------- Suchindex direkt aus OpenStreetMap (Overpass), für selbst hinzugefügte Gebiete ---------- */
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const QUERY = `[out:json][timeout:170];
(
  node["place"~"^(city|town|village|hamlet|suburb|quarter|locality|isolated_dwelling)$"]["name"]({b});
  node["natural"~"^(peak|volcano|saddle|spring)$"]["name"]({b});
  node["mountain_pass"="yes"]["name"]({b});
  way["natural"~"^(water|glacier)$"]["name"]({b});
  relation["natural"~"^(water|glacier)$"]["name"]({b});
  relation["waterway"="river"]["name"]({b});
  nwr["tourism"~"^(camp_site|caravan_site|alpine_hut|wilderness_hut|viewpoint|attraction)$"]["name"]({b});
  nwr["amenity"="fuel"]({b});
  node["amenity"="drinking_water"]({b});
  node["barrier"="border_control"]({b});
);
out center tags qt;`;
const ALT_KEYS = ['name:de', 'name:en', 'int_name', 'name:ru', 'name:latin', 'old_name'];
const DEFAULT_NAMES = { fuel: 'Tankstelle', drink: 'Trinkwasser', border: 'Grenzkontrolle' };

function classify(t) {
  if (t.place) return t.place;
  if (t.mountain_pass === 'yes' || t.natural === 'saddle') return 'pass';
  if (t.natural === 'peak' || t.natural === 'volcano') return 'peak';
  if (['spring', 'glacier', 'water'].includes(t.natural)) return t.natural;
  if (t.waterway === 'river') return 'river';
  if (t.amenity === 'fuel') return 'fuel';
  if (t.amenity === 'drinking_water') return 'drink';
  if (t.barrier === 'border_control') return 'border';
  return { camp_site: 'camp', caravan_site: 'camp', alpine_hut: 'hut', wilderness_hut: 'hut', viewpoint: 'view', attraction: 'sight' }[t.tourism] || 'other';
}

function toItems(elements) {
  const items = [];
  for (const el of elements) {
    const t = el.tags || {};
    const typ = classify(t);
    const name = t.name || DEFAULT_NAMES[typ];
    if (!name) continue;
    const lat = el.type === 'node' ? el.lat : el.center && el.center.lat;
    const lon = el.type === 'node' ? el.lon : el.center && el.center.lon;
    if (lat === undefined || lon === undefined) continue;
    const alts = [];
    for (const k of ALT_KEYS) if (t[k] && t[k] !== name && !alts.includes(t[k])) alts.push(t[k]);
    let ele = t.ele ? parseInt(parseFloat(String(t.ele).replace(',', '.')), 10) : null;
    if (isNaN(ele)) ele = null;
    items.push([name, alts.join('|'), typ, Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, ele]);
  }
  return items;
}

function searchChunks(boxes, step) {
  const out = [];
  for (const [w, s, e, n] of boxes) {
    const nx = Math.max(1, Math.ceil((e - w) / step)), ny = Math.max(1, Math.ceil((n - s) / step));
    const dx = (e - w) / nx, dy = (n - s) / ny;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      out.push([w + i * dx, s + j * dy, w + (i + 1) * dx, s + (j + 1) * dy].map((v) => Math.round(v * 1e4) / 1e4));
    }
  }
  return out;
}

async function overpass(b) {
  const body = 'data=' + encodeURIComponent(QUERY.replaceAll('{b}', `${b[1]},${b[0]},${b[3]},${b[2]}`));
  let last = null;
  for (const url of OVERPASS) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 200000);
      const r = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const res = await r.json();
      if (res.remark && /runtime error/.test(res.remark)) throw new Error('zu groß');
      return res.elements || [];
    } catch (err) { last = err; }
  }
  throw last || new Error('Overpass nicht erreichbar');
}

async function buildSearch(root, id, boxes, post) {
  const name = `${id}-search.json`;
  const old = await readJson(root, name);
  const st = (old && old.v === 1 && old.done) ? old : { v: 1, complete: false, items: [], done: [] };
  const chunks = searchChunks(boxes, 2);
  const done = new Set(st.done);
  const seen = new Set(st.items.map((it) => it[0] + '|' + it[3] + '|' + it[4]));
  const add = (items) => { for (const it of items) { const k = it[0] + '|' + it[3] + '|' + it[4]; if (!seen.has(k)) { seen.add(k); st.items.push(it); } } };
  const enc = new TextEncoder();
  let failed = 0, n = 0;
  for (const c of chunks) {
    n++;
    const key = c.join(',');
    if (done.has(key)) continue;
    post({ type: 'search', done: n - 1, total: chunks.length });
    try {
      let items;
      try { items = toItems(await overpass(c)); } catch (err) {
        // zu viele Daten auf einmal: in vier kleinere Teile zerlegen
        items = [];
        for (const sub of searchChunks([c], (c[2] - c[0]) / 2 + 1e-9)) items.push(...toItems(await overpass(sub)));
      }
      add(items);
      done.add(key);
      st.done = [...done];
      await writeWhole(root, name, enc.encode(JSON.stringify(st)));
    } catch (err) {
      failed++;
      if (!navigator.onLine) break;
    }
  }
  st.complete = chunks.every((c) => done.has(c.join(',')));
  await writeWhole(root, name, enc.encode(JSON.stringify(st)));
  return { done: done.size, total: chunks.length, complete: st.complete };
}

/* ganze Datei laden, bei Abbruch an der gleichen Stelle weiter (Wanderwege) */
async function downloadFile(root, name, url, size, post) {
  const st = await readJson(root, name + '.state');
  if (st && st.complete && st.size === size && st.url === url && await exists(root, name.replace('.pmtiles', '.ok'))) return false;
  const fh = await root.getFileHandle(name, { create: true });
  const access = await fh.createSyncAccessHandle();
  try {
    let pos = st && st.url === url && st.size === size ? Math.min(access.getSize(), size) : 0;
    if (pos === 0) access.truncate(0);
    for (let attempt = 0; pos < size; attempt++) {
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${pos}-` } });
        if (r.status !== 206 && r.status !== 200) throw new Error('HTTP ' + r.status);
        if (r.status === 200) { pos = 0; access.truncate(0); }
        const reader = r.body.getReader();
        let last = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          access.write(value, { at: pos });
          pos += value.byteLength;
          const now = Date.now();
          if (now - last > 400) { last = now; post({ type: 'hike', loaded: pos, total: size }); access.flush(); await writeWhole(root, name + '.state', new TextEncoder().encode(JSON.stringify({ url, size, complete: false }))); }
        }
        if (pos < size) throw new Error('unvollständig');
      } catch (err) {
        if (attempt >= 6) throw err;
        access.flush();
        await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      }
    }
    access.truncate(size);
    access.flush();
  } finally { access.close(); }
  await writeWhole(root, name + '.state', new TextEncoder().encode(JSON.stringify({ url, size, complete: true })));
  await root.getFileHandle(name.replace('.pmtiles', '.ok'), { create: true });
  return true;
}

self.onmessage = async (e) => {
  if (e.data && e.data.access) self.OVL_ACCESS = e.data.access;
  const { id, boxes, maxzoom, demMaxzoom, sources, searchUrl, buildSearchIndex, mode, hikeLayers, routeLayers } = e.data;
  const post = (m) => self.postMessage(m);
  try {
    if (mode === 'estimate') {
      const res = {};
      for (const [layer, mz] of [['base', maxzoom], ['dem', demMaxzoom]]) {
        const plan = await OvlExtract.planExtract(OvlExtract.httpSource(sources[layer]), boxes, mz, (s) => post({ type: 'scan', layer, tiles: s.tiles }));
        res[layer] = plan.bytes;
      }
      post({ type: 'estimate', sizes: res });
      return;
    }
    if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('Dieses Gerät erlaubt keinen App-Speicher für Dateien');
    const root = await navigator.storage.getDirectory();
    const enc = new TextEncoder();
    const saveState = (layer, st) => writeWhole(root, `${id}-${layer}.state`, enc.encode(JSON.stringify(st)));

    const layers = [['base', sources.base, maxzoom], ['dem', sources.dem, demMaxzoom]];
    // Wanderwege: aus jeder berührten Länderdatei genau das Gebiet ausschneiden
    for (const h of hikeLayers || []) layers.push(['hk-' + h.key, h.url, 14]);
    // Straßennetz fürs Offline-Routing: große Straßen (z7) und alle Wege (z10) des Gebiets
    for (const h of routeLayers || []) layers.push(['rt-' + h.key, h.url, 10]);
    const jobs = [];
    let doneBytes = 0;
    for (const [layer, url, mz] of layers) {
      const st = await readJson(root, `${id}-${layer}.state`);
      if (st && st.complete && st.url === url && await exists(root, `${id}-${layer}.idx.ok`)) { doneBytes += st.bytes || 0; continue; }
      await remove(root, `${id}-${layer}.idx.ok`);
      const src = OvlExtract.httpSource(url);
      post({ type: 'scan', layer, tiles: 0 });
      const plan = await OvlExtract.planExtract(src, boxes, mz, (s) => post({ type: 'scan', layer, tiles: s.tiles }));
      const resume = (st && !st.complete && st.url === url && st.bytes === plan.bytes && st.n === plan.n) ? st : null;
      jobs.push({ layer, url, src, plan, resume });
    }
    const total = doneBytes + jobs.reduce((s, j) => s + j.plan.bytes, 0);
    let before = doneBytes;
    let lastPost = 0;
    for (const { layer, url, src, plan, resume } of jobs) {
      const fh = await root.getFileHandle(`${id}-${layer}.dat`, { create: true });
      const access = await fh.createSyncAccessHandle();
      let index;
      try {
        if (!resume) { access.truncate(0); await saveState(layer, { url, bytes: plan.bytes, n: plan.n, groupsDone: 0, pos: 0, complete: false }); }
        index = await OvlExtract.runExtract(src, plan,
          async (bytes, pos) => { access.write(bytes, { at: pos }); },
          (s) => {
            const now = Date.now();
            if (now - lastPost > 300) { lastPost = now; post({ type: 'progress', loaded: before + s.loaded, total }); }
          },
          resume,
          async (cp) => { access.flush(); await saveState(layer, { url, bytes: plan.bytes, n: plan.n, groupsDone: cp.groupsDone, pos: cp.pos, complete: false }); });
        access.flush();
      } finally {
        access.close();
      }
      await writeWhole(root, `${id}-${layer}.idx`, index);
      await root.getFileHandle(`${id}-${layer}.idx.ok`, { create: true });
      await saveState(layer, { url, bytes: plan.bytes, n: plan.n, complete: true });
      before += plan.bytes;
      post({ type: 'progress', loaded: before, total });
    }

    post({ type: 'tiles-done' });
    if (searchUrl) {
      try {
        const r = await fetch(searchUrl);
        if (r.ok) await writeWhole(root, `${id}-search.json`, new Uint8Array(await r.arrayBuffer()));
      } catch (err) { /* Suche bleibt online */ }
    } else if (buildSearchIndex) {
      try { post({ type: 'search-state', ...(await buildSearch(root, id, boxes, post)) }); } catch (err) { /* Suche bleibt online */ }
    }
    for (const layer of ['base', 'dem']) {
      await remove(root, `${id}-${layer}.pmtiles.ok`);
      await remove(root, `${id}-${layer}.pmtiles`);
    }
    post({ type: 'done' });
  } catch (err) {
    let msg = err && err.message ? err.message : String(err);
    if (/load failed|failed to fetch|networkerror/i.test(msg)) msg = 'Verbindung zum Kartenserver unterbrochen (' + msg + ')';
    post({ type: 'error', message: msg });
  }
};
