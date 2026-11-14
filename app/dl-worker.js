/* Lädt ein Kartengebiet: schneidet Karte und Höhenmodell direkt aus den großen Online-Archiven aus
 * und speichert alles im privaten App-Speicher (Origin Private File System). */
'use strict';
importScripts('extract.js');

async function writeWhole(root, name, bytes) {
  const fh = await root.getFileHandle(name, { create: true });
  const h = await fh.createSyncAccessHandle();
  try { h.truncate(0); h.write(bytes, { at: 0 }); h.flush(); } finally { h.close(); }
}

async function remove(root, name) {
  try { await root.removeEntry(name); } catch (e) { /* gab es nicht */ }
}

self.onmessage = async (e) => {
  const { id, boxes, maxzoom, demMaxzoom, sources, searchUrl } = e.data;
  const post = (m) => self.postMessage(m);
  try {
    const root = await navigator.storage.getDirectory();
    for (const layer of ['base', 'dem']) await remove(root, `${id}-${layer}.idx.ok`);

    const layers = [['base', sources.base, maxzoom], ['dem', sources.dem, demMaxzoom]];
    const plans = [];
    for (const [layer, url, mz] of layers) {
      const src = OvlExtract.httpSource(url);
      const plan = await OvlExtract.planExtract(src, boxes, mz, (s) => post({ type: 'scan', layer, tiles: s.tiles }));
      plans.push({ layer, src, plan });
    }
    const total = plans.reduce((s, p) => s + p.plan.bytes, 0);
    let before = 0;
    let lastPost = 0;
    for (const { layer, src, plan } of plans) {
      const fh = await root.getFileHandle(`${id}-${layer}.dat`, { create: true });
      const access = await fh.createSyncAccessHandle();
      let index;
      try {
        access.truncate(0);
        index = await OvlExtract.runExtract(src, plan, async (bytes, pos) => { access.write(bytes, { at: pos }); }, (s) => {
          const now = Date.now();
          if (now - lastPost > 300) { lastPost = now; post({ type: 'progress', loaded: before + s.loaded, total }); }
        });
        access.flush();
      } finally {
        access.close();
      }
      await writeWhole(root, `${id}-${layer}.idx`, index);
      await root.getFileHandle(`${id}-${layer}.idx.ok`, { create: true });
      before += plan.bytes;
      post({ type: 'progress', loaded: before, total });
    }

    if (searchUrl) {
      try {
        const r = await fetch(searchUrl);
        if (r.ok) await writeWhole(root, `${id}-search.json`, new Uint8Array(await r.arrayBuffer()));
      } catch (err) { /* Suche bleibt online */ }
    }
    // ältere Fassung dieses Gebiets aufräumen
    for (const layer of ['base', 'dem']) {
      await remove(root, `${id}-${layer}.pmtiles.ok`);
      await remove(root, `${id}-${layer}.pmtiles`);
    }
    post({ type: 'done' });
  } catch (err) {
    post({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
