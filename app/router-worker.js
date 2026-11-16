/* Offline-Routing: rechnet Routen direkt auf dem Gerät aus dem Straßennetz (Kacheln von build_routing.py).
 * Läuft als Web Worker; die Kacheln kommen aus den offline gespeicherten Gebieten oder, mit Internet, aus den Länderdateien.
 * Ergebnis im gleichen Aufbau wie Nav.parseTrip (Linie, Abbiegehinweise, Fähren, Maut). */
'use strict';
if (typeof importScripts === 'function' && typeof OvlExtract === 'undefined') importScripts('extract.js');

const OvlRouter = (() => {
  const X = typeof OvlExtract !== 'undefined' ? OvlExtract : require('./extract.js') && globalThis.OvlExtract;
  const ZF = 10, ZM = 7, SC = 1e5;
  const NEAR = [20000, 60000, Infinity];   // Umkreis um Start und Ziel mit allen Wegen; dazwischen nur große Straßen
  const MAX_SETTLED = 1500000;
  const FERRY = 11;

  /* ---------- PMTiles lesen (lokal oder über HTTP) ---------- */
  class PmReader {
    constructor(read) { this.read = read; this.leaves = new Map(); }
    async init() {
      if (this.header) return;
      const head = await this.read(0, 16384);
      this.header = X.parseHeader(head);
      const h = this.header;
      const rb = h.rootOffset + h.rootLength <= head.length ? head.subarray(h.rootOffset, h.rootOffset + h.rootLength) : await this.read(h.rootOffset, h.rootLength);
      this.root = X.parseDirectory(await X.decompress(rb, h.internalCompression));
      this.bbox = [h.minLon, h.minLat, h.maxLon, h.maxLat];
    }
    find(d, id) {
      let lo = 0, hi = d.n - 1, k = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (d.ids[m] <= id) { k = m; lo = m + 1; } else hi = m - 1; }
      return k;
    }
    async getZxy(z, x, y) {
      await this.init();
      const id = X.tileIdOf(z, x, y);
      let d = this.root;
      for (let depth = 0; depth < 4; depth++) {
        const k = this.find(d, id);
        if (k < 0) return null;
        if (d.runs[k] === 0) {
          const key = d.offs[k];
          let leaf = this.leaves.get(key);
          if (!leaf) {
            leaf = X.parseDirectory(await X.decompress(await this.read(this.header.leafOffset + d.offs[k], d.lens[k]), this.header.internalCompression));
            this.leaves.set(key, leaf);
          }
          d = leaf;
          continue;
        }
        if (id >= d.ids[k] + d.runs[k]) return null;
        const raw = await this.read(this.header.dataOffset + d.offs[k], d.lens[k]);
        return X.decompress(raw, this.header.tileCompression);
      }
      return null;
    }
  }
  function httpReader(url) {
    return new PmReader(async (o, l) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await fetch(url, { headers: { Range: `bytes=${o}-${o + l - 1}` } });
          if (r.status !== 206 && r.status !== 200) throw new Error('HTTP ' + r.status);
          const b = new Uint8Array(await r.arrayBuffer());
          return r.status === 200 ? b.subarray(o, o + l) : b;
        } catch (e) {
          if (attempt >= 3) throw e;
          await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
        }
      }
    });
  }
  /* aus dem Gebiets-Download (OVL1-Index + Daten im App-Speicher) */
  function localReader(idxBuf, readData) {
    const a = new X.LocalArchive(idxBuf, readData);
    return { bbox: null, async init() {}, async getZxy(z, x, y) { const t = await a.getZxy(z, x, y); return t && t.data ? new Uint8Array(t.data) : null; } };
  }

  /* ---------- Kacheln entschlüsseln ---------- */
  function decodeTile(buf, z, tx, ty) {
    let p = 0;
    const rv = () => { let v = 0, m = 1, b; do { b = buf[p++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return v; };
    const rz = () => { const v = rv(); return v % 2 ? -(v + 1) / 2 : v / 2; };
    if (rv() !== 1) throw new Error('Unbekanntes Routenformat');
    const ox = rz(), oy = rz();
    const ns = rv(), names = [''];
    const dec = new TextDecoder();
    for (let i = 0; i < ns; i++) { const l = rv(); names.push(dec.decode(buf.subarray(p, p + l))); p += l; }
    const n = rv();
    const t = {
      z, x: tx, y: ty, n, names, buf,
      a: new Float64Array(n), b: new Float64Array(n),
      hA: new Uint8Array(n), hB: new Uint8Array(n),           // Endpunkt hat hier seine Heimat
      tax: new Int32Array(n), tay: new Int32Array(n), tbx: new Int32Array(n), tby: new Int32Array(n),
      cls: new Uint8Array(n), fl: new Uint16Array(n), grade: new Uint8Array(n), sac: new Uint8Array(n), ms: new Uint8Array(n),
      len: new Float32Array(n), name: new Uint32Array(n), ref: new Uint32Array(n), dest: new Uint32Array(n),
      xa: new Int32Array(n), ya: new Int32Array(n), xb: new Int32Array(n), yb: new Int32Array(n), g: new Uint32Array(n)
    };
    let last = 0;
    for (let i = 0; i < n; i++) {
      last += rz(); t.a[i] = last; t.b[i] = last + rz();
      const dxa = rz(), dya = rz(), dxb = rz(), dyb = rz();
      t.tax[i] = tx + dxa; t.tay[i] = ty + dya; t.tbx[i] = tx + dxb; t.tby[i] = ty + dyb;
      t.hA[i] = dxa === 0 && dya === 0 ? 1 : 0; t.hB[i] = dxb === 0 && dyb === 0 ? 1 : 0;
      const cf = rv(); t.cls[i] = cf % 16; t.fl[i] = Math.floor(cf / 16);
      const ex = rv(); t.grade[i] = ex % 8; t.sac[i] = Math.floor(ex / 8) % 8; t.ms[i] = Math.floor(ex / 64);
      t.len[i] = rv() / 10;
      t.name[i] = rv(); t.ref[i] = rv(); t.dest[i] = rv();
      const gl = rv(), end = p + gl;
      t.g[i] = p;
      t.xa[i] = ox + rz(); t.ya[i] = oy + rz(); t.xb[i] = t.xa[i] + rz(); t.yb[i] = t.ya[i] + rz();
      p = end;
    }
    return t;
  }
  /* ganze Linie einer Kante (A → B) als [[lon, lat], …] */
  function geom(t, i) {
    const buf = t.buf;
    let p = t.g[i];
    const rv = () => { let v = 0, m = 1, b; do { b = buf[p++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return v; };
    const rz = () => { const v = rv(); return v % 2 ? -(v + 1) / 2 : v / 2; };
    rz(); rz(); rz(); rz();
    const nm = rv();
    let x = t.xa[i], y = t.ya[i];
    const out = [[x / SC, y / SC]];
    for (let k = 0; k < nm; k++) { x += rz(); y += rz(); out.push([x / SC, y / SC]); }
    out.push([t.xb[i] / SC, t.yb[i] / SC]);
    return out;
  }

  /* ---------- Hilfen ---------- */
  function tileOf(lon, lat, z) {
    const n = Math.pow(2, z);
    const la = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
    return [Math.min(n - 1, Math.max(0, Math.floor((lon + 180) / 360 * n))), Math.min(n - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(la)) / Math.PI) / 2 * n)))];
  }
  function tileBox(z, x, y) {
    const n = Math.pow(2, z);
    const lat = (v) => Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))) * 180 / Math.PI;
    return [x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)];
  }
  function dist(lon1, lat1, lon2, lat2) {
    const r = Math.PI / 180, dla = (lat2 - lat1) * r, dlo = (lon2 - lon1) * r;
    const a = Math.sin(dla / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dlo / 2) ** 2;
    return 12742017.6 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bearing(a, b) {
    const r = Math.PI / 180;
    const y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
    const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }
  /* Richtung am Anfang einer Linie (etwa 20 m weit geschaut, damit kleine Knicke nicht zählen) */
  function headBearing(c) {
    let d = 0, k = 1;
    for (; k < c.length - 1; k++) { d += dist(c[k - 1][0], c[k - 1][1], c[k][0], c[k][1]); if (d > 20) break; }
    return bearing(c[0], c[Math.min(k, c.length - 1)]);
  }
  function tailBearing(c) { return (headBearing(c.slice().reverse()) + 180) % 360; }
  function turnAngle(inB, outB) { let a = outB - inB; while (a > 180) a -= 360; while (a <= -180) a += 360; return a; }

  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v;
      let i = k.length; k.push(key); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
      if (k.length) {
        let i = 0;
        const n = k.length;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
  }

  /* ---------- Profile ---------- */
  const CAR_V = [120, 90, 75, 65, 55, 45, 30, 10, 18, 15, 0, 20, 0, 0];
  const TRACK_V = [15, 25, 18, 13, 10, 7];
  function profileFor(o) {
    if (o.travel === 'foot') {
      const max = o.sac || 3;
      const F = [0, 2, 1.6, 1.35, 1.15, 1.05, 1, 1, 1, 1, 1, 1, 1, 1.25];
      return {
        foot: true, hv: 1.25 * 1.15, w: 1.1,
        ok: (t, i, dir) => (t.fl[i] & 4) !== 0 && t.sac[i] <= max,
        time(t, i) {
          const c = t.cls[i];
          if (c === FERRY) return t.len[i] / ((t.ms[i] || 20) / 3.6) + 1200;
          let v = 1.25;
          if (c === 13) v = 0.6;
          if (t.sac[i] >= 3) v *= 0.7; else if (t.sac[i] === 2) v *= 0.85;
          return t.len[i] / v;
        },
        cost(t, i, s) { return t.cls[i] === FERRY ? s : s * F[t.cls[i]]; }
      };
    }
    const prof = o.profile || 'road';
    return {
      foot: false, w: 1.1, hv: prof === 'short' ? 0 : 36,
      ok: (t, i, dir) => (t.fl[i] & (dir ? 1 : 2)) !== 0,
      time(t, i) {
        const c = t.cls[i], f = t.fl[i], ms = t.ms[i];
        if (c === FERRY) return t.len[i] / ((ms || 20) / 3.6) + 1800;
        let v;
        if (c === 9) v = TRACK_V[t.grade[i]] || 15;
        else {
          v = CAR_V[c] || 20;
          if (ms) v = Math.min(ms * (ms > 90 ? 0.9 : 0.8), v * 1.4, 130);
          if (f & 8) v *= 0.75;
          if (f & 32) v = Math.min(v, 40);
        }
        return t.len[i] / (v / 3.6);
      },
      cost(t, i, s) {
        const c = t.cls[i], f = t.fl[i];
        if (prof === 'short') return t.len[i] * (c === 9 ? 1.6 : 1) + (c === FERRY ? 3000 : 0);
        let k = 1;
        if (c === 9) k = prof === 'tracks' ? 1.1 : 5;
        else if (f & 32) k = prof === 'tracks' ? 1 : 1.6;
        if (c === 8 || c === 7) k *= 1.4;
        if (f & 128) k *= 3;
        return s * k;
      }
    };
  }

  /* ---------- Netz ---------- */
  class Net {
    constructor(sources) {
      this.sources = sources;            // [{ reader, bbox }]
      this.tiles = new Map();            // "z/x/y" → Promise<[decoded …]>
      this.adj = [new Map(), new Map()]; // 0: alle Wege (z10), 1: große Straßen (z7)
      this.loaded = 0;
    }
    level(z) { return z === ZF ? 0 : 1; }
    has(z, x, y) { const t = this.tiles.get(z + '/' + x + '/' + y); return t && t.done; }
    async tile(z, x, y) {
      const key = z + '/' + x + '/' + y;
      let e = this.tiles.get(key);
      if (!e) {
        e = { done: false, list: [] };
        this.tiles.set(key, e);
        e.p = this.load(z, x, y, e);
      }
      if (!e.done) await e.p;
      return e.list;
    }
    async load(z, x, y, e) {
      const box = tileBox(z, x, y);
      const seen = new Set();
      for (const s of this.sources) {
        if (s.bbox && (s.bbox[0] > box[2] || s.bbox[2] < box[0] || s.bbox[1] > box[3] || s.bbox[3] < box[1])) continue;
        let raw = null;
        try { raw = await s.reader.getZxy(z, x, y); } catch (err) { raw = null; }
        if (!raw || !raw.length) continue;
        const t = decodeTile(raw, z, x, y);
        // Grenzgebiete stehen in beiden Länderdateien: doppelte Kanten nur einmal
        const dup = e.list.length ? new Uint8Array(t.n) : null;
        for (let i = 0; i < t.n; i++) {
          const k = t.a[i] + '_' + t.b[i] + '_' + t.len[i];
          if (dup && seen.has(k)) { dup[i] = 1; continue; }
          seen.add(k);
        }
        t.dup = dup;
        const adj = this.adj[this.level(z)];
        for (let i = 0; i < t.n; i++) {
          if (dup && dup[i]) continue;
          if (t.hA[i]) { let l = adj.get(t.a[i]); if (!l) adj.set(t.a[i], l = []); l.push(t, i, 1); }
          if (t.hB[i]) { let l = adj.get(t.b[i]); if (!l) adj.set(t.b[i], l = []); l.push(t, i, 0); }
        }
        e.list.push(t);
        this.loaded++;
      }
      e.done = true;
    }

    /* nächstgelegene passende Kante zu einem Punkt */
    async snap(pt, prof, strict) {
      const [cx, cy] = tileOf(pt.lon, pt.lat, ZF);
      const kx = 111320 * Math.cos(pt.lat * Math.PI / 180), ky = 110574;
      const cand = [];            // beste Stelle je Kante, aufsteigend nach Abstand
      const K = 8;
      const worst = () => cand.length < K ? Infinity : cand[cand.length - 1].d + cand[cand.length - 1].pen;
      for (let ring = 0; ring <= 1; ring++) {
        for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const t of await this.tile(ZF, cx + dx, cy + dy)) {
            for (let i = 0; i < t.n; i++) {
              if (t.dup && t.dup[i]) continue;
              if (!prof.ok(t, i, 1) && !prof.ok(t, i, 0)) continue;
              if (t.cls[i] === FERRY || (strict && t.cls[i] > 7)) continue;
              // grob vorsortieren über die Endpunkte
              const lx = Math.min(t.xa[i], t.xb[i]) / SC, hx = Math.max(t.xa[i], t.xb[i]) / SC, ly = Math.min(t.ya[i], t.yb[i]) / SC, hy = Math.max(t.ya[i], t.yb[i]) / SC;
              const ex = Math.max(0, lx - pt.lon, pt.lon - hx) * kx, ey = Math.max(0, ly - pt.lat, pt.lat - hy) * ky;
              if (Math.hypot(ex, ey) - t.len[i] > worst()) continue;
              const c = geom(t, i);
              // Hauptstraßen beim Einrasten leicht bevorzugen, Feld- und Zufahrtswege für Autos meiden
              const pen = prof.foot ? 0 : (t.cls[i] === 9 ? 25 : t.cls[i] === 8 ? 8 : 0);
              let along = 0, bd = Infinity, bAlong = 0, proj = null;
              for (let k = 1; k < c.length; k++) {
                const ax = (c[k - 1][0] - pt.lon) * kx, ay = (c[k - 1][1] - pt.lat) * ky, bx = (c[k][0] - pt.lon) * kx, by = (c[k][1] - pt.lat) * ky;
                const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
                const u = L2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2)) : 0;
                const d = Math.hypot(ax + u * vx, ay + u * vy);
                const segLen = Math.sqrt(L2);
                if (d < bd) { bd = d; bAlong = along + u * segLen; proj = [c[k - 1][0] + u * (c[k][0] - c[k - 1][0]), c[k - 1][1] + u * (c[k][1] - c[k - 1][1])]; }
                along += segLen;
              }
              if (bd + pen >= worst()) continue;
              cand.push({ t, i, d: bd, pen, proj, frac: along > 0 ? Math.min(1, bAlong / along) : 0 });
              cand.sort((x, y) => (x.d + x.pen) - (y.d + y.pen));
              if (cand.length > K) cand.pop();
            }
          }
        }
        if (cand.length && cand[0].d < 500) break;
      }
      const max = prof.foot ? 3000 : 5000;
      const ok = cand.filter((c) => c.d <= max);
      if (!ok.length) return null;
      // abgeschnittene Inselchen (Privatgelände, Parkplatz ohne Zufahrt) überspringen
      for (const c of ok.slice(0, 5)) if (await this.connected(c, prof)) return c;
      return ok[0];
    }

    /* hängt die Kante an einem größeren Netz? (kurze Breitensuche ohne Richtung) */
    async connected(c, prof) {
      const seen = new Set(), queue = [];
      const add = (id, x, y, h) => { if (!seen.has(id)) { seen.add(id); queue.push([id, x, y, h]); } };
      add(c.t.a[c.i], c.t.xa[c.i], c.t.ya[c.i], [c.t.tax[c.i], c.t.tay[c.i]]);
      add(c.t.b[c.i], c.t.xb[c.i], c.t.yb[c.i], [c.t.tbx[c.i], c.t.tby[c.i]]);
      for (let q = 0; q < queue.length; q++) {
        if (seen.size > 400) return true;
        const [id, , , h] = queue[q];
        await this.tile(ZF, h[0], h[1]);
        const l = this.adj[0].get(id) || [];
        for (let k = 0; k < l.length; k += 3) {
          const t = l[k], i = l[k + 1];
          if (!prof.ok(t, i, 1) && !prof.ok(t, i, 0)) continue;
          if (!prof.foot && t.cls[i] <= 4) return true;
          add(t.a[i], t.xa[i], t.ya[i], [t.tax[i], t.tay[i]]);
          add(t.b[i], t.xb[i], t.yb[i], [t.tbx[i], t.tby[i]]);
        }
      }
      return false;
    }
  }

  /* ---------- Suche ---------- */
  async function search(net, prof, s, e, near) {
    const W = prof.w, hv = prof.hv;
    const H = (lon, lat) => hv ? dist(lon, lat, e.proj[0], e.proj[1]) / hv : dist(lon, lat, e.proj[0], e.proj[1]);
    const labels = new Map();   // Knoten → { g, x, y, h10, h7, par, t, i, dir }
    const heap = new Heap();
    let best = null, settled = 0;
    const costOf = (t, i) => prof.cost(t, i, prof.time(t, i));
    // gleicher Weg für Start und Ziel
    if (s.t.a[s.i] === e.t.a[e.i] && s.t.b[s.i] === e.t.b[e.i]) {
      const fwd = e.frac >= s.frac;
      if (prof.ok(s.t, s.i, fwd ? 1 : 0)) {
        const c = costOf(s.t, s.i) * Math.abs(e.frac - s.frac);
        best = { g: c, direct: true, fwd };
      }
    }
    const relax = (id, g, x, y, h10, h7, par, t, i, dir) => {
      const old = labels.get(id);
      if (old && old.g <= g) return;
      labels.set(id, { g, x, y, h10, h7, par, t, i, dir, done: false });
      heap.push(g + W * H(x / SC, y / SC), id);
    };
    // vom Startpunkt zu beiden Enden der Startkante
    const sc = costOf(s.t, s.i);
    if (prof.ok(s.t, s.i, 1)) relax(s.t.b[s.i], sc * (1 - s.frac), s.t.xb[s.i], s.t.yb[s.i], [s.t.tbx[s.i], s.t.tby[s.i]], null, null, s.t, s.i, 1);
    if (prof.ok(s.t, s.i, 0)) relax(s.t.a[s.i], sc * s.frac, s.t.xa[s.i], s.t.ya[s.i], [s.t.tax[s.i], s.t.tay[s.i]], null, null, s.t, s.i, 0);
    const eA = e.t.a[e.i], eB = e.t.b[e.i], ec = costOf(e.t, e.i);
    const sLon = s.proj[0], sLat = s.proj[1], eLon = e.proj[0], eLat = e.proj[1];
    while (heap.size) {
      if (best && heap.k[0] >= best.g) break;
      const id = heap.pop();
      const L = labels.get(id);
      if (!L || L.done) continue;
      L.done = true;
      if (++settled > MAX_SETTLED) throw new Error('Strecke zu lang für die Offline-Berechnung');
      // Ziel über die Zielkante erreichen
      if (id === eA && prof.ok(e.t, e.i, 1)) { const g = L.g + ec * e.frac; if (!best || g < best.g) best = { g, last: id, dir: 1 }; }
      if (id === eB && prof.ok(e.t, e.i, 0)) { const g = L.g + ec * (1 - e.frac); if (!best || g < best.g) best = { g, last: id, dir: 0 }; }
      const lon = L.x / SC, lat = L.y / SC;
      const isNear = dist(lon, lat, sLon, sLat) < near || dist(lon, lat, eLon, eLat) < near;
      let z, home;
      if (isNear || prof.foot) { z = ZF; home = L.h10 || tileOf(lon, lat, ZF); }
      else { z = ZM; home = L.h7 || tileOf(lon, lat, ZM); }
      if (!net.has(z, home[0], home[1])) await net.tile(z, home[0], home[1]);
      const list = net.adj[net.level(z)].get(id);
      if (!list) continue;
      for (let k = 0; k < list.length; k += 3) {
        const t = list[k], i = list[k + 1], dir = list[k + 2];
        if (!prof.ok(t, i, dir)) continue;
        if (L.t === t && L.i === i) continue;
        const g = L.g + costOf(t, i);
        if (dir) relax(t.b[i], g, t.xb[i], t.yb[i], z === ZF ? [t.tbx[i], t.tby[i]] : null, z === ZM ? [t.tbx[i], t.tby[i]] : null, id, t, i, 1);
        else relax(t.a[i], g, t.xa[i], t.ya[i], z === ZF ? [t.tax[i], t.tay[i]] : null, z === ZM ? [t.tax[i], t.tay[i]] : null, id, t, i, 0);
      }
    }
    if (!best) return null;
    // Weg zurückverfolgen
    const steps = [];
    if (!best.direct) {
      let id = best.last;
      for (;;) {
        const L = labels.get(id);
        steps.push({ t: L.t, i: L.i, dir: L.dir });
        if (L.par === null) break;
        id = L.par;
      }
      steps.reverse();
    }
    return { best, steps, settled };
  }

  /* ---------- Ergebnis zusammensetzen ---------- */
  function sliceFrac(c, f0, f1) {
    // Teil einer Linie von Anteil f0 bis f1 (beide 0…1, f0 < f1)
    const cum = [0];
    for (let k = 1; k < c.length; k++) cum.push(cum[k - 1] + dist(c[k - 1][0], c[k - 1][1], c[k][0], c[k][1]));
    const L = cum[cum.length - 1] || 1;
    const at = (f) => {
      const d = f * L;
      for (let k = 1; k < c.length; k++) if (cum[k] >= d) { const u = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1); return [k, [c[k - 1][0] + u * (c[k][0] - c[k - 1][0]), c[k - 1][1] + u * (c[k][1] - c[k - 1][1])]]; }
      return [c.length - 1, c[c.length - 1]];
    };
    const [k0, p0] = at(f0), [k1, p1] = at(f1);
    return [p0, ...c.slice(k0, k1), p1];
  }

  function streetOf(t, i) { return (t.names[t.name[i]] || t.names[t.ref[i]] || '').replace(/;\s*/g, ' / '); }
  function compass(b) { return ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten'][Math.round(b / 45) % 8]; }

  /* Winkel der anderen Abzweige an einem Knoten (ohne den Weg, auf dem man kommt, und den, den man nimmt) */
  function adjAt(net, nid) {
    const l0 = net.adj[0].get(nid);
    return l0 && l0.length ? l0 : (net.adj[1].get(nid) || []);
  }
  function altAngles(net, prof, nid, inB, a, b) {
    const out = [];
    const list = adjAt(net, nid);
    const same = (t, i, p) => t.a[i] === p.t.a[p.i] && t.b[i] === p.t.b[p.i] && t.len[i] === p.t.len[p.i];
    for (let k = 0; k < list.length; k += 3) {
      const t = list[k], i = list[k + 1], dir = list[k + 2];
      if (same(t, i, a) || same(t, i, b) || !prof.ok(t, i, dir) || t.cls[i] === FERRY) continue;
      let c = geom(t, i);
      if (!dir) c = c.reverse();
      out.push({ ang: turnAngle(inB, headBearing(c)), minor: !prof.foot && (t.cls[i] >= 8), name: streetOf(t, i), link: (t.fl[i] & 8) !== 0 });
    }
    return out;
  }
  /* gibt es an diesem Knoten im Kreisverkehr eine Ausfahrt? */
  function hasExit(net, prof, nid) {
    const list = adjAt(net, nid);
    for (let k = 0; k < list.length; k += 3) {
      const t = list[k], i = list[k + 1], dir = list[k + 2];
      if (!(t.fl[i] & 16) && prof.ok(t, i, dir) && t.cls[i] !== FERRY) return true;
    }
    return false;
  }

  function turnMan(ang, on) {
    const abs = Math.abs(ang), side = ang >= 0 ? 'rechts' : 'links';
    if (abs >= 165) return [ang > 0 ? 12 : 13, 'Wenden' + on];
    if (abs >= 125) return [ang > 0 ? 11 : 14, `Scharf ${side} abbiegen${on}`];
    if (abs >= 50) return [ang > 0 ? 10 : 15, `${ang >= 0 ? 'Rechts' : 'Links'} abbiegen${on}`];
    if (abs >= 18) return [ang > 0 ? 9 : 16, `Leicht ${side} abbiegen${on}`];
    return null;
  }

  function build(net, prof, legs, travel) {
    const coords = [], man = [], ferries = [], tolls = [];
    let time = 0;
    const walkWord = prof.foot ? 'Gehe' : 'Fahre';
    for (let li = 0; li < legs.length; li++) {
      const { s, e, res } = legs[li];
      const parts = [];   // { c: Linie in Fahrtrichtung, t, i, f: Anteil, from, to: Knoten }
      if (res.best.direct) {
        const f0 = Math.min(s.frac, e.frac), f1 = Math.max(s.frac, e.frac);
        let c = sliceFrac(geom(s.t, s.i), f0, f1);
        if (!res.best.fwd) c = c.reverse();
        parts.push({ c, t: s.t, i: s.i, f: f1 - f0, from: null, to: null });
      } else {
        const st = res.steps;
        for (let k = 0; k < st.length; k++) {
          const { t, i, dir } = st[k];
          let c = geom(t, i), f = 1;
          if (k === 0) { c = dir ? sliceFrac(c, s.frac, 1) : sliceFrac(c, 0, s.frac).reverse(); f = dir ? 1 - s.frac : s.frac; }
          else if (!dir) c = c.reverse();
          parts.push({ c, t, i, f, from: k === 0 ? null : (dir ? t.a[i] : t.b[i]), to: dir ? t.b[i] : t.a[i] });
        }
        const c = geom(e.t, e.i);
        const fw = res.best.dir;
        parts.push({ c: fw ? sliceFrac(c, 0, e.frac) : sliceFrac(c, e.frac, 1).reverse(), t: e.t, i: e.i, f: fw ? e.frac : 1 - e.frac,
          from: fw ? e.t.a[e.i] : e.t.b[e.i], to: null });
      }
      const pIdx = [];
      for (const p of parts) {
        pIdx.push(coords.length ? coords.length - 1 : 0);
        coords.push(...(coords.length ? p.c.slice(1) : p.c));
        time += prof.time(p.t, p.i) * p.f;
      }
      if (li === 0) {
        const first = parts.find((p) => p.c.length > 1) || parts[0];
        const street = streetOf(first.t, first.i);
        const text = `${walkWord} Richtung ${compass(headBearing(first.c))}${street ? ' auf ' + street : ''}`;
        man.push({ idx: 0, type: 1, text, alert: text, verbal: text, street });
      }
      for (let k = 1; k < parts.length; k++) {
        const a = parts[k - 1], b = parts[k];
        const idx = pIdx[k];
        if (a.c.length < 2 || b.c.length < 2) continue;
        const at = a.t, ai = a.i, bt = b.t, bi = b.i;
        const aF = at.cls[ai] === FERRY, bF = bt.cls[bi] === FERRY;
        const street = streetOf(bt, bi), on = street ? ' auf ' + street : '';
        const push = (type, text, extra) => man.push({ idx, type, text, alert: text, verbal: text, street, ...(extra || {}) });
        if (!aF && bF) { push(28, 'Fähre nehmen' + (street ? ': ' + street : '')); continue; }
        if (aF && !bF) { push(29, 'Fähre verlassen' + on); continue; }
        const aR = (at.fl[ai] & 16) !== 0, bR = (bt.fl[bi] & 16) !== 0;
        if (bR && !aR) {
          let exits = 0, j = k;
          while (j < parts.length && (parts[j].t.fl[parts[j].i] & 16)) {
            if (parts[j].to !== null && hasExit(net, prof, parts[j].to)) exits++;
            j++;
          }
          const out = parts[j] ? streetOf(parts[j].t, parts[j].i) : '';
          const text = `Im Kreisverkehr die ${exits || 1}. Ausfahrt nehmen${out ? ' auf ' + out : ''}`;
          man.push({ idx, type: 26, text, alert: text, verbal: text, street: out, exit: exits || 1 });
          continue;
        }
        if (aR && !bR) { push(27, 'Kreisverkehr verlassen' + on); continue; }
        if (aR && bR) continue;
        const inB = tailBearing(a.c), outB = headBearing(b.c);
        const ang = turnAngle(inB, outB), abs = Math.abs(ang);
        const alts = b.from === null ? [] : altAngles(net, prof, b.from, inB, a, b);
        if (!alts.length) continue;            // keine Wahl an dieser Stelle: kein Hinweis
        const aLink = (at.fl[ai] & 8) !== 0, bLink = (bt.fl[bi] & 8) !== 0;
        const side = ang >= 0 ? 'rechts' : 'links';
        if (!prof.foot && bLink && !aLink) {
          const dest = bt.names[bt.dest[bi]] || bt.names[bt.ref[bi]];
          if (at.cls[ai] <= 1) push(ang >= 0 ? 20 : 21, `Ausfahrt ${side} nehmen${dest ? ' Richtung ' + dest : ''}`);
          else push(abs < 15 ? 17 : ang > 0 ? 18 : 19, (abs < 15 ? 'Auffahrt nehmen' : `Auffahrt ${side} nehmen`) + (dest ? ' Richtung ' + dest : ''));
          continue;
        }
        if (!prof.foot && aLink && !bLink && bt.cls[bi] <= 1) { push(25, 'Auffahren' + on); continue; }
        // die Straße geht einfach weiter (gleicher Name, keine andere Straße mit dem Namen): kein Hinweis bei leichten Knicken
        const aName = streetOf(at, ai);
        if (abs < 50 && street && street === aName && !alts.some((x) => !x.link && x.name === street && Math.abs(x.ang) < 60)) continue;
        // auf der Autobahn/Schnellstraße bleiben, rechts geht nur eine Ausfahrt ab: kein Hinweis
        if (!prof.foot && !bLink && abs < 35 && alts.every((x) => x.link || x.minor || Math.abs(x.ang) >= 35)) continue;
        const straightest = alts.every((x) => Math.abs(x.ang) > abs);
        const fork = alts.filter((x) => !x.minor && Math.abs(x.ang) < 45);
        if (abs < 35 && straightest) {
          if (fork.length) {
            const right = fork.every((x) => x.ang < ang), left = fork.every((x) => x.ang > ang);
            push(right ? 23 : left ? 24 : 22, (right ? 'Rechts halten' : left ? 'Links halten' : 'Geradeaus weiter') + on, { _in: inB, _out: outB });
          }
          continue;
        }
        const tm = turnMan(ang, on);
        if (tm) push(tm[0], tm[1], { _in: inB, _out: outB });
      }
      const lastLeg = li === legs.length - 1;
      man.push({ idx: coords.length - 1, type: 4, text: lastLeg ? 'Ziel erreicht' : 'Zwischenziel erreicht',
        alert: lastLeg ? 'erreichst du dein Ziel' : 'erreichst du dein Zwischenziel', verbal: lastLeg ? 'Du hast dein Ziel erreicht.' : 'Zwischenziel erreicht.', street: '' });
      const wait = prof.foot ? 1200 : 1800;
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        const km = p.t.len[p.i] * p.f / 1000;
        if (p.t.cls[p.i] === FERRY) {
          const f = ferries[ferries.length - 1], tm = Math.max(0, prof.time(p.t, p.i) - wait) * p.f;
          if (f && f.endIdx === pIdx[k]) { f.km += km; f.time += tm; f.endIdx = pIdx[k] + p.c.length - 1; if (!f.name) f.name = streetOf(p.t, p.i); }
          else ferries.push({ idx: pIdx[k], endIdx: pIdx[k] + p.c.length - 1, name: streetOf(p.t, p.i), km, time: tm });
        }
        if (p.t.fl[p.i] & 64) tolls.push({ idx: pIdx[k], name: streetOf(p.t, p.i), km });
      }
    }
    const cum = [0];
    for (let k = 1; k < coords.length; k++) cum.push(cum[k - 1] + dist(coords[k - 1][0], coords[k - 1][1], coords[k][0], coords[k][1]));
    const total = cum[cum.length - 1] || 0;
    // zwei Abbiegungen direkt hintereinander (Kreuzung mit getrennten Fahrbahnen) zu einer zusammenfassen
    const close = prof.foot ? 12 : 35;
    for (let k = 0; k + 1 < man.length; k++) {
      const m = man[k], n = man[k + 1];
      if (m._in === undefined || n._in === undefined || cum[n.idx] - cum[m.idx] > close) continue;
      const tm = turnMan(turnAngle(m._in, n._out), n.street ? ' auf ' + n.street : '');
      if (tm) { man.splice(k, 2, { ...n, idx: m.idx, type: tm[0], text: tm[1], alert: tm[1], verbal: tm[1], _in: m._in }); }
      else { man.splice(k, 2); }
      k--;
      if (k < -1) k = -1;
    }
    for (const m of man) { delete m._in; delete m._out; }
    for (let k = 0; k < man.length; k++) {
      const next = man[k + 1];
      const d = (next ? cum[next.idx] : total) - cum[man[k].idx];
      man[k].km = Math.max(0, d / 1000);
      man[k].sec = total ? time * d / total : 0;
    }
    return { coords, maneuvers: man, time, source: 'Offline', ferries, tolls, len: total, travel };
  }

  /* ---------- Route über alle Stopps ---------- */
  async function route(net, o) {
    const prof = profileFor(o);
    const legs = [];
    const snaps = [];
    for (const p of o.pts) {
      const sn = await net.snap(p, prof);
      if (!sn) throw new Error(`Keine ${prof.foot ? 'Wege' : 'Straße'} in der Nähe von ${p.name || 'einem Punkt'} in den Offline-Daten`);
      snaps.push(sn);
    }
    for (let k = 1; k < snaps.length; k++) {
      let s = snaps[k - 1], e = snaps[k];
      const run = async () => {
        const d = dist(s.proj[0], s.proj[1], e.proj[0], e.proj[1]);
        for (const near of NEAR) {
          const r = await search(net, prof, s, e, prof.foot ? Infinity : near);
          if (r || near >= d || prof.foot) return r;
        }
        return null;
      };
      let res = await run();
      if (!res && !prof.foot) {
        // eingerastet auf einem Feld- oder Privatweg ohne Anschluss: an der nächsten richtigen Straße versuchen
        const s2 = s.t.cls[s.i] > 7 ? await net.snap(o.pts[k - 1], prof, true) : null;
        const e2 = e.t.cls[e.i] > 7 ? await net.snap(o.pts[k], prof, true) : null;
        if (s2 || e2) { s = s2 || s; e = e2 || e; snaps[k] = e; res = await run(); }
      }
      if (!res) throw new Error('Keine Verbindung im Offline-Straßennetz gefunden');
      legs.push({ s, e, res });
    }
    return build(net, prof, legs, o.travel === 'foot' ? 'foot' : 'car');
  }

  return { PmReader, httpReader, localReader, decodeTile, geom, profileFor, Net, search, build, route, tileOf, dist, NEAR, ZF, ZM };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OvlRouter;

/* ---------- als Web Worker ---------- */
if (typeof importScripts === 'function') {
  let net = null, netKey = '';
  async function openSources(list) {
    const out = [];
    let root = null;
    for (const s of list) {
      try {
        if (s.local) {
          root = root || await navigator.storage.getDirectory();
          const idx = await (await (await root.getFileHandle(s.local + '.idx')).getFile()).arrayBuffer();
          const data = await (await root.getFileHandle(s.local + '.dat')).getFile();
          out.push({ reader: OvlRouter.localReader(idx, async (o, l) => new Uint8Array(await data.slice(o, o + l).arrayBuffer())), bbox: s.bbox || null });
        } else if (s.url) out.push({ reader: OvlRouter.httpReader(s.url), bbox: s.bbox || null });
      } catch (e) { /* Datei fehlt: weglassen */ }
    }
    return out;
  }
  self.onmessage = async (ev) => {
    const m = ev.data;
    try {
      const key = JSON.stringify(m.sources);
      // Kachelspeicher behalten, solange dieselben Dateien gelten (schnellere Neuberechnung unterwegs)
      if (!net || key !== netKey || net.loaded > 1500) { net = new OvlRouter.Net(await openSources(m.sources)); netKey = key; }
      if (!net.sources.length) throw new Error('Keine Offline-Straßendaten für dieses Gebiet');
      const t0 = Date.now();
      const r = await OvlRouter.route(net, m);
      self.postMessage({ id: m.id, ok: true, route: r, ms: Date.now() - t0 });
    } catch (e) { self.postMessage({ id: m.id, ok: false, error: e && e.message ? e.message : String(e) }); }
  };
}
