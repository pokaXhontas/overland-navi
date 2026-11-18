/* Overland-Navi: Kartengebiete direkt aus großen PMTiles-Archiven ausschneiden und lokal lesen.
 * Läuft im Download-Worker, in der App (Leser) und in Node (Test im GitHub-Workflow).
 *
 * Lokales Format (zwei Dateien pro Ebene):
 *   <name>.dat  Kacheldaten, wie im Quellarchiv gespeichert (MVT meist gzip, Höhen als WebP)
 *   <name>.idx  "OVL1" | uint32 JSON-Länge | JSON | Füllbytes bis 8 | f64 ids[n] | f64 offsets[n] | u32 lengths[n] | u32 runs[n]
 */
(function (root) {
  'use strict';

  /* In Web Workern: Geräteschlüssel an Anfragen zum eigenen Worker hängen (kommt per Nachricht als access) */
  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope && !root.__ovlFetch) {
    const raw = root.fetch.bind(root);
    root.__ovlFetch = true;
    root.fetch = (input, init) => {
      const a = root.OVL_ACCESS;
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (a && a.key && url.startsWith(a.origin)) {
        const h = new Headers((init && init.headers) || undefined);
        h.set('X-Key', a.key);
        init = { ...(init || {}), headers: h };
      }
      return raw(input, init);
    };
  }

  /* ---------- Kachel-IDs (Hilbert-Kurve, wie PMTiles) ---------- */
  function tileIdOf(z, x, y) {
    let acc = 0;
    for (let t = 0; t < z; t++) acc += Math.pow(4, t);
    const n = Math.pow(2, z);
    let d = 0, tx = x, ty = y;
    for (let s = n / 2; s >= 1; s /= 2) {
      const rx = (tx & s) > 0 ? 1 : 0;
      const ry = (ty & s) > 0 ? 1 : 0;
      d += s * s * ((3 * rx) ^ ry);
      if (ry === 0) {
        if (rx === 1) { tx = n - 1 - tx; ty = n - 1 - ty; }
        const t = tx; tx = ty; ty = t;
      }
    }
    return acc + d;
  }

  function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
  function lat2y(lat, z) {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
  }

  /* Alle Kachel-IDs, die eine Liste von Rechtecken [W,S,E,N] abdecken, aufsteigend sortiert und eindeutig */
  function wantedTileIds(boxes, minZoom, maxZoom) {
    const ranges = [];
    let total = 0;
    for (let z = minZoom; z <= maxZoom; z++) {
      const n = Math.pow(2, z);
      for (const [w, s, e, nn] of boxes) {
        const x0 = Math.max(0, lon2x(w, z)), x1 = Math.min(n - 1, lon2x(e, z));
        const y0 = Math.max(0, lat2y(nn, z)), y1 = Math.min(n - 1, lat2y(s, z));
        if (x1 < x0 || y1 < y0) continue;
        ranges.push([z, x0, x1, y0, y1]);
        total += (x1 - x0 + 1) * (y1 - y0 + 1);
      }
    }
    const ids = new Float64Array(total);
    let i = 0;
    for (const [z, x0, x1, y0, y1] of ranges) {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) ids[i++] = tileIdOf(z, x, y);
    }
    ids.sort();
    let u = 0;
    for (let k = 0; k < ids.length; k++) if (k === 0 || ids[k] !== ids[u - 1]) ids[u++] = ids[k];
    return ids.subarray(0, u);
  }

  function lowerBound(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
    return lo;
  }

  /* ---------- PMTiles lesen ---------- */
  function u64(dv, o) { return dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296; }

  function parseHeader(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const magic = String.fromCharCode(...buf.subarray(0, 7));
    if (magic !== 'PMTiles' || buf[7] !== 3) throw new Error('Kein PMTiles-v3-Archiv');
    return {
      rootOffset: u64(dv, 8), rootLength: u64(dv, 16),
      leafOffset: u64(dv, 40), leafLength: u64(dv, 48),
      dataOffset: u64(dv, 56), dataLength: u64(dv, 64),
      clustered: buf[96] === 1, internalCompression: buf[97], tileCompression: buf[98], tileType: buf[99],
      minZoom: buf[100], maxZoom: buf[101],
      minLon: dv.getInt32(102, true) / 1e7, minLat: dv.getInt32(106, true) / 1e7,
      maxLon: dv.getInt32(110, true) / 1e7, maxLat: dv.getInt32(114, true) / 1e7
    };
  }

  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function decompress(bytes, comp) {
    if (comp === 2) return gunzip(bytes);
    if (comp === 0 || comp === 1) return bytes;
    throw new Error('Nicht unterstützte Kompression ' + comp);
  }

  function parseDirectory(buf) {
    const p = { i: 0 };
    const rv = () => {
      let val = 0, mul = 1, b;
      do { b = buf[p.i++]; val += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
      return val;
    };
    const n = rv();
    const ids = new Float64Array(n), runs = new Float64Array(n), lens = new Float64Array(n), offs = new Float64Array(n);
    let last = 0;
    for (let i = 0; i < n; i++) { last += rv(); ids[i] = last; }
    for (let i = 0; i < n; i++) runs[i] = rv();
    for (let i = 0; i < n; i++) lens[i] = rv();
    for (let i = 0; i < n; i++) {
      const v = rv();
      offs[i] = (v === 0 && i > 0) ? offs[i - 1] + lens[i - 1] : v - 1;
    }
    return { n, ids, runs, lens, offs };
  }

  /* Quelle über HTTP-Bereichsanfragen */
  function httpSource(url, fetchFn) {
    const f = fetchFn || fetch;
    return {
      async read(offset, length) {
        for (let attempt = 0; ; attempt++) {
          try {
            const r = await f(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
            // Server kurz überlastet: nochmal versuchen
            if (r.status >= 500 || r.status === 429 || r.status === 408) throw new Error('Server gerade nicht erreichbar (' + r.status + ')');
            if (r.status !== 206) throw new Error('Server unterstützt keine Bereichsanfragen (' + r.status + ')');
            const buf = new Uint8Array(await r.arrayBuffer());
            if (buf.byteLength !== length) throw new Error('Unvollständige Antwort');
            return buf;
          } catch (e) {
            if (attempt >= 7 || /Bereichsanfragen/.test(e.message)) throw e;
            await new Promise((res) => setTimeout(res, Math.min(20000, 1500 * Math.pow(1.7, attempt))));
          }
        }
      }
    };
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  /* Plant den Ausschnitt: welche Kacheln es gibt und wo sie liegen (mit Typed Arrays, damit auch große Länder in den Speicher passen) */
  async function planExtract(src, boxes, maxZoom, onStatus) {
    const head = await src.read(0, 16384);
    const header = parseHeader(head);
    const mz = Math.min(maxZoom, header.maxZoom);
    const wanted = wantedTileIds(boxes, header.minZoom, mz);
    const rootBytes = header.rootOffset + header.rootLength <= 16384
      ? head.subarray(header.rootOffset, header.rootOffset + header.rootLength)
      : await src.read(header.rootOffset, header.rootLength);
    let dirs = [parseDirectory(await decompress(rootBytes, header.internalCompression))];
    const cap = wanted.length;
    const tIds = new Float64Array(cap), tOffs = new Float64Array(cap), tRuns = new Uint32Array(cap), tLens = new Uint32Array(cap);
    let m = 0, leafCount = 0;
    while (dirs.length) {
      const leaves = [];
      for (const d of dirs) {
        for (let i = 0; i < d.n; i++) {
          const id = d.ids[i];
          if (d.runs[i] === 0) {
            const end = i + 1 < d.n ? d.ids[i + 1] : Infinity;
            const k = lowerBound(wanted, id);
            if (k < wanted.length && wanted[k] < end) leaves.push([d.offs[i], d.lens[i]]);
          } else {
            const end = id + d.runs[i];
            let k = lowerBound(wanted, id);
            while (k < wanted.length && wanted[k] < end) {
              let run = 1;
              while (k + run < wanted.length && wanted[k + run] === wanted[k] + run && wanted[k + run] < end) run++;
              tIds[m] = wanted[k]; tRuns[m] = run; tOffs[m] = d.offs[i]; tLens[m] = d.lens[i]; m++;
              k += run;
            }
          }
        }
      }
      leafCount += leaves.length;
      if (onStatus) onStatus({ phase: 'scan', leaves: leafCount, tiles: m });
      dirs = await mapLimit(leaves, 6, async ([o, l]) => parseDirectory(await decompress(await src.read(header.leafOffset + o, l), header.internalCompression)));
    }
    // nach Kachel-ID sortieren
    const order = new Uint32Array(m);
    for (let i = 0; i < m; i++) order[i] = i;
    order.sort((a, b) => tIds[a] - tIds[b]);
    const plan = { header, maxZoom: mz, n: m, ids: new Float64Array(m), runs: new Uint32Array(m), srcOffs: new Float64Array(m), lens: new Uint32Array(m) };
    for (let i = 0; i < m; i++) { const j = order[i]; plan.ids[i] = tIds[j]; plan.runs[i] = tRuns[j]; plan.srcOffs[i] = tOffs[j]; plan.lens[i] = tLens[j]; }
    // eindeutige Datenblöcke in Dateireihenfolge
    const byOff = order;
    for (let i = 0; i < m; i++) byOff[i] = i;
    byOff.sort((a, b) => plan.srcOffs[a] - plan.srcOffs[b]);
    plan.tileUniq = new Uint32Array(m);
    const uOff = new Float64Array(m), uLen = new Uint32Array(m);
    let u = 0, bytes = 0;
    for (let i = 0; i < m; i++) {
      const t = byOff[i];
      if (u === 0 || plan.srcOffs[t] !== uOff[u - 1]) { uOff[u] = plan.srcOffs[t]; uLen[u] = plan.lens[t]; bytes += plan.lens[t]; u++; }
      plan.tileUniq[t] = u - 1;
    }
    plan.uniqOff = uOff.subarray(0, u);
    plan.uniqLen = uLen.subarray(0, u);
    plan.bytes = bytes;
    // Gruppen für gebündelte Bereichsanfragen
    const GAP = 128 * 1024, MAX = 12 * 1024 * 1024;
    plan.groups = [];
    let g = null;
    for (let k = 0; k < u; k++) {
      const off = plan.uniqOff[k], len = plan.uniqLen[k];
      if (g && off - (g.start + g.length) <= GAP && off + len - g.start <= MAX) {
        g.length = Math.max(g.length, off + len - g.start);
        g.to = k + 1;
      } else {
        g = { start: off, length: len, from: k, to: k + 1 };
        plan.groups.push(g);
      }
    }
    return plan;
  }

  /* Lädt die Kacheldaten gebündelt und schreibt sie fortlaufend; liefert die Index-Datei.
     resume = { groupsDone, pos } setzt einen abgebrochenen Download fort. */
  async function runExtract(src, plan, write, onStatus, resume, onCheckpoint) {
    const { header, groups } = plan;
    const uDst = new Float64Array(plan.uniqOff.length);
    let pos = 0, done = 0, gi = 0;
    if (resume && resume.groupsDone > 0) {
      for (; gi < Math.min(resume.groupsDone, groups.length); gi++) {
        for (let k = groups[gi].from; k < groups[gi].to; k++) { uDst[k] = pos; pos += plan.uniqLen[k]; }
      }
      if (pos !== resume.pos) { gi = 0; pos = 0; }
      done = pos;
    }
    const WINDOW = 3;
    while (gi < groups.length) {
      const batch = groups.slice(gi, gi + WINDOW);
      const bufs = await Promise.all(batch.map((gr) => src.read(header.dataOffset + gr.start, gr.length)));
      for (let b = 0; b < batch.length; b++) {
        const gr = batch[b], buf = bufs[b];
        for (let k = gr.from; k < gr.to; k++) {
          const rel = plan.uniqOff[k] - gr.start;
          await write(buf.subarray(rel, rel + plan.uniqLen[k]), pos);
          uDst[k] = pos;
          pos += plan.uniqLen[k];
          done += plan.uniqLen[k];
        }
      }
      gi += batch.length;
      if (onCheckpoint) await onCheckpoint({ groupsDone: gi, pos });
      if (onStatus) onStatus({ phase: 'download', loaded: done, total: plan.bytes });
    }
    const offsets = new Float64Array(plan.n);
    for (let i = 0; i < plan.n; i++) offsets[i] = uDst[plan.tileUniq[i]];
    return buildIndex({
      tileType: header.tileType, tileCompression: header.tileCompression,
      minZoom: header.minZoom, maxZoom: plan.maxZoom, count: plan.n, dataBytes: pos
    }, plan.ids, offsets, plan.lens, plan.runs);
  }

  function buildIndex(meta, ids, offsets, lens, runs) {
    const json = new TextEncoder().encode(JSON.stringify(meta));
    const head = 8 + json.length;
    const pad = (8 - (head % 8)) % 8;
    const n = ids.length;
    const out = new Uint8Array(head + pad + n * 24);
    const dv = new DataView(out.buffer);
    out.set([79, 86, 76, 49], 0);
    dv.setUint32(4, json.length, true);
    out.set(json, 8);
    let o = head + pad;
    new Float64Array(out.buffer, o, n).set(ids); o += n * 8;
    new Float64Array(out.buffer, o, n).set(offsets); o += n * 8;
    new Uint32Array(out.buffer, o, n).set(lens); o += n * 4;
    new Uint32Array(out.buffer, o, n).set(runs);
    return out;
  }

  /* ---------- Lokales Archiv lesen ---------- */
  class LocalArchive {
    constructor(indexBuf, readData) {
      const u8 = new Uint8Array(indexBuf);
      if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'OVL1') throw new Error('Unbekanntes Indexformat');
      const dv = new DataView(indexBuf);
      const jl = dv.getUint32(4, true);
      this.meta = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + jl)));
      const head = 8 + jl, pad = (8 - (head % 8)) % 8, n = this.meta.count;
      let o = head + pad;
      this.ids = new Float64Array(indexBuf, o, n); o += n * 8;
      this.offs = new Float64Array(indexBuf, o, n); o += n * 8;
      this.lens = new Uint32Array(indexBuf, o, n); o += n * 4;
      this.runs = new Uint32Array(indexBuf, o, n);
      this.readData = readData;
    }
    find(id) {
      let lo = 0, hi = this.ids.length - 1, k = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (this.ids[m] <= id) { k = m; lo = m + 1; } else hi = m - 1; }
      if (k < 0 || id >= this.ids[k] + this.runs[k]) return -1;
      return k;
    }
    async getZxy(z, x, y) {
      if (z > this.meta.maxZoom || z < this.meta.minZoom) return undefined;
      const k = this.find(tileIdOf(z, x, y));
      if (k < 0) return undefined;
      let data = await this.readData(this.offs[k], this.lens[k]);
      if (this.meta.tileCompression === 2) data = await gunzip(data);
      return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    }
  }

  root.OvlExtract = { tileIdOf, wantedTileIds, parseHeader, parseDirectory, httpSource, planExtract, runExtract, LocalArchive, decompress };
})(typeof self !== 'undefined' ? self : globalThis);
