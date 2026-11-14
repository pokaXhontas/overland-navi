/* Overland-Navi: Kartengebiete direkt aus großen PMTiles-Archiven ausschneiden und lokal lesen.
 * Läuft im Download-Worker, in der App (Leser) und in Node (Test im GitHub-Workflow).
 *
 * Lokales Format (zwei Dateien pro Ebene):
 *   <name>.dat  Kacheldaten, wie im Quellarchiv gespeichert (MVT meist gzip, Höhen als WebP)
 *   <name>.idx  "OVL1" | uint32 JSON-Länge | JSON | Füllbytes bis 8 | f64 ids[n] | f64 offsets[n] | u32 lengths[n] | u32 runs[n]
 */
(function (root) {
  'use strict';

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

  /* Alle Kachel-IDs, die eine Liste von Rechtecken [W,S,E,N] abdecken, aufsteigend sortiert */
  function wantedTileIds(boxes, minZoom, maxZoom) {
    const levels = [];
    let cur = new Set();
    const n = Math.pow(2, maxZoom);
    for (const [w, s, e, nn] of boxes) {
      const x0 = Math.max(0, lon2x(w, maxZoom)), x1 = Math.min(n - 1, lon2x(e, maxZoom));
      const y0 = Math.max(0, lat2y(nn, maxZoom)), y1 = Math.min(n - 1, lat2y(s, maxZoom));
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cur.add(x * n + y);
    }
    levels[maxZoom] = cur;
    for (let z = maxZoom - 1; z >= minZoom; z--) {
      const nz = Math.pow(2, z + 1), next = new Set(), np = Math.pow(2, z);
      for (const k of levels[z + 1]) {
        const x = Math.floor(k / nz), y = k % nz;
        next.add((x >> 1) * np + (y >> 1));
      }
      levels[z] = next;
    }
    let total = 0;
    for (let z = minZoom; z <= maxZoom; z++) total += levels[z].size;
    const ids = new Float64Array(total);
    let i = 0;
    for (let z = minZoom; z <= maxZoom; z++) {
      const nz = Math.pow(2, z);
      for (const k of levels[z]) ids[i++] = tileIdOf(z, Math.floor(k / nz), k % nz);
    }
    ids.sort();
    return ids;
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
            if (r.status !== 206) throw new Error('Server unterstützt keine Bereichsanfragen (' + r.status + ')');
            const buf = new Uint8Array(await r.arrayBuffer());
            if (buf.byteLength !== length) throw new Error('Unvollständige Antwort');
            return buf;
          } catch (e) {
            if (attempt >= 4) throw e;
            await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
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

  /* Plant den Ausschnitt: welche Kacheln es gibt und wo sie liegen */
  async function planExtract(src, boxes, maxZoom, onStatus) {
    const head = await src.read(0, 16384);
    const header = parseHeader(head);
    const mz = Math.min(maxZoom, header.maxZoom);
    const wanted = wantedTileIds(boxes, header.minZoom, mz);
    const rootBytes = header.rootOffset + header.rootLength <= 16384
      ? head.subarray(header.rootOffset, header.rootOffset + header.rootLength)
      : await src.read(header.rootOffset, header.rootLength);
    let dirs = [parseDirectory(await decompress(rootBytes, header.internalCompression))];
    const tIds = [], tRuns = [], tOffs = [], tLens = [];
    let leafCount = 0;
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
              tIds.push(wanted[k]); tRuns.push(run); tOffs.push(d.offs[i]); tLens.push(d.lens[i]);
              k += run;
            }
          }
        }
      }
      leafCount += leaves.length;
      if (onStatus) onStatus({ phase: 'scan', leaves: leafCount, tiles: tIds.length });
      dirs = await mapLimit(leaves, 6, async ([o, l]) => parseDirectory(await decompress(await src.read(header.leafOffset + o, l), header.internalCompression)));
    }
    const order = Array.from(tIds.keys()).sort((a, b) => tIds[a] - tIds[b]);
    const n = order.length;
    const plan = { header, maxZoom: mz, n, ids: new Float64Array(n), runs: new Uint32Array(n), srcOffs: new Float64Array(n), lens: new Uint32Array(n) };
    order.forEach((j, i) => { plan.ids[i] = tIds[j]; plan.runs[i] = tRuns[j]; plan.srcOffs[i] = tOffs[j]; plan.lens[i] = tLens[j]; });
    const uniq = new Map();
    for (let i = 0; i < n; i++) uniq.set(plan.srcOffs[i], plan.lens[i]);
    plan.chunks = [...uniq.entries()].sort((a, b) => a[0] - b[0]);
    plan.bytes = plan.chunks.reduce((s, c) => s + c[1], 0);
    return plan;
  }

  /* Lädt die Kacheldaten gebündelt und schreibt sie fortlaufend; liefert die Index-Datei */
  async function runExtract(src, plan, write, onStatus) {
    const { header, chunks } = plan;
    const dst = new Map();
    const GAP = 128 * 1024, MAX = 12 * 1024 * 1024;
    const groups = [];
    let g = null;
    for (const [off, len] of chunks) {
      if (g && off - (g.start + g.length) <= GAP && off + len - g.start <= MAX) {
        g.length = Math.max(g.length, off + len - g.start);
        g.items.push([off, len]);
      } else {
        g = { start: off, length: len, items: [[off, len]] };
        groups.push(g);
      }
    }
    let pos = 0, done = 0;
    const window = 3;
    for (let i = 0; i < groups.length; i += window) {
      const batch = groups.slice(i, i + window);
      const bufs = await Promise.all(batch.map((gr) => src.read(header.dataOffset + gr.start, gr.length)));
      for (let b = 0; b < batch.length; b++) {
        const gr = batch[b], buf = bufs[b];
        for (const [off, len] of gr.items) {
          if (dst.has(off)) continue;
          await write(buf.subarray(off - gr.start, off - gr.start + len), pos);
          dst.set(off, pos);
          pos += len;
          done += len;
        }
      }
      if (onStatus) onStatus({ phase: 'download', loaded: done, total: plan.bytes });
    }
    const offsets = new Float64Array(plan.n);
    for (let i = 0; i < plan.n; i++) offsets[i] = dst.get(plan.srcOffs[i]);
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
