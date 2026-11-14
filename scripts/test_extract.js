// Prüft den Ausschneider der App gegen ein Referenzarchiv, das mit dem offiziellen pmtiles-Werkzeug erzeugt wurde.
// Aufruf: node scripts/test_extract.js <quell-url> <referenz.pmtiles> <W,S,E,N> <maxzoom>
'use strict';
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', 'app', 'extract.js'));
const E = globalThis.OvlExtract;

async function readAll(file) {
  const buf = fs.readFileSync(file);
  const src = { read: async (o, l) => new Uint8Array(buf.subarray(o, o + l)) };
  const header = E.parseHeader(await src.read(0, 127));
  const map = new Map();
  const walk = async (off, len, leaf) => {
    const raw = await src.read((leaf ? header.leafOffset : header.rootOffset) + off, len);
    const d = E.parseDirectory(await E.decompress(raw, header.internalCompression));
    for (let i = 0; i < d.n; i++) {
      if (d.runs[i] === 0) await walk(d.offs[i], d.lens[i], true);
      else for (let r = 0; r < d.runs[i]; r++) map.set(d.ids[i] + r, [header.dataOffset + d.offs[i], d.lens[i]]);
    }
  };
  await walk(0, header.rootLength, false);
  return { header, map, src };
}

(async () => {
  const [url, refFile, bboxStr, mzStr] = process.argv.slice(2);
  const box = bboxStr.split(',').map(Number);
  const maxZoom = Number(mzStr);
  const src = E.httpSource(url);
  const t0 = Date.now();
  const plan = await E.planExtract(src, [box], maxZoom, () => {});
  const parts = [];
  let size = 0;
  const idx = await E.runExtract(src, plan, async (b, pos) => { parts.push([pos, Buffer.from(b)]); size = Math.max(size, pos + b.length); }, () => {});
  const dat = Buffer.alloc(size);
  for (const [p, b] of parts) b.copy(dat, p);
  const local = new E.LocalArchive(idx.buffer.slice(idx.byteOffset, idx.byteOffset + idx.byteLength), async (o, l) => new Uint8Array(dat.subarray(o, o + l)));
  console.log(`Ausschnitt: ${plan.n} Einträge, ${(plan.bytes / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const ref = await readAll(refFile);
  let same = 0, missing = 0, differ = 0;
  for (const [id, [off, len]] of ref.map) {
    let z = 0, acc = 0;
    while (acc + Math.pow(4, z) <= id) { acc += Math.pow(4, z); z++; }
    if (z > maxZoom) continue;
    const k = local.find(id);
    if (k < 0) { missing++; continue; }
    const mine = Buffer.from(await local.readData(local.offs[k], local.lens[k]));
    const theirs = Buffer.from(await ref.src.read(off, len));
    if (mine.equals(theirs)) same++; else differ++;
  }
  console.log(`Vergleich mit pmtiles-CLI: ${same} gleich, ${differ} verschieden, ${missing} fehlen (von ${ref.map.size})`);
  if (differ > 0 || missing > ref.map.size * 0.02 || same === 0) {
    console.error('FEHLER: Ausschnitt stimmt nicht mit der Referenz überein');
    process.exit(1);
  }
  // Stichprobe über den Leser mit Entpacken
  const z = Math.min(maxZoom, 10);
  const x = Math.floor((box[0] + box[2]) / 2 / 360 * Math.pow(2, z) + Math.pow(2, z) / 2);
  const latR = (box[1] + box[3]) / 2 * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * Math.pow(2, z));
  const t = await local.getZxy(z, x, y);
  console.log(`Kachel ${z}/${x}/${y}: ${t ? t.data.byteLength + ' Bytes' : 'fehlt'}`);
  if (!t) process.exit(1);
  console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
