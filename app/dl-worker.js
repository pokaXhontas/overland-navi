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

self.onmessage = async (e) => {
  const { id, boxes, maxzoom, demMaxzoom, sources, searchUrl } = e.data;
  const post = (m) => self.postMessage(m);
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('Dieses Gerät erlaubt keinen App-Speicher für Dateien');
    const root = await navigator.storage.getDirectory();
    const enc = new TextEncoder();
    const saveState = (layer, st) => writeWhole(root, `${id}-${layer}.state`, enc.encode(JSON.stringify(st)));

    const layers = [['base', sources.base, maxzoom], ['dem', sources.dem, demMaxzoom]];
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

    if (searchUrl) {
      try {
        const r = await fetch(searchUrl);
        if (r.ok) await writeWhole(root, `${id}-search.json`, new Uint8Array(await r.arrayBuffer()));
      } catch (err) { /* Suche bleibt online */ }
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
