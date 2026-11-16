// Probelauf für das Offline-Routing: rechnet Strecken aus einer gebauten Datei und vergleicht mit Valhalla (online).
// Aufruf: node scripts/check_routing.js <datei-route.pmtiles> '<[[lon,lat,lon,lat,"car"|"foot"], …]>'
require('../app/extract.js');
const R = require('../app/router-worker.js');
const fs = require('fs');
(async () => {
  const fd = fs.openSync(process.argv[2], 'r'), size = fs.fstatSync(fd).size;
  const reader = new R.PmReader(async (o, l) => { const n = Math.max(0, Math.min(l, size - o)); const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, o); return new Uint8Array(b); });
  const net = new R.Net([{ reader, bbox: null }]);
  let bad = 0;
  for (const [lon1, lat1, lon2, lat2, travel, label] of JSON.parse(process.argv[3])) {
    const pts = [{ lon: lon1, lat: lat1, name: 'Start' }, { lon: lon2, lat: lat2, name: 'Ziel' }];
    const t0 = Date.now();
    let own = null;
    try { own = await R.route(net, { pts, travel, profile: 'road', sac: 3 }); } catch (e) { console.log(`✗ ${label}: ${e.message}`); bad++; continue; }
    const ms = Date.now() - t0;
    let ref = '';
    try {
      const q = { locations: pts.map((p) => ({ lat: p.lat, lon: p.lon })), costing: travel === 'foot' ? 'pedestrian' : 'auto', directions_options: { units: 'kilometers' } };
      const j = await (await fetch('https://valhalla1.openstreetmap.de/route?json=' + encodeURIComponent(JSON.stringify(q)))).json();
      if (j.trip) ref = ` · Valhalla ${j.trip.summary.length.toFixed(1)} km, ${Math.round(j.trip.summary.time / 60)} min`;
    } catch (e) { /* ohne Vergleich */ }
    console.log(`✓ ${label} (${travel}): ${(own.len / 1000).toFixed(1)} km, ${Math.round(own.time / 60)} min, ${own.maneuvers.length} Hinweise, ${ms} ms, ${net.loaded} Kacheln${ref}`);
    for (const m of own.maneuvers.slice(0, 14)) console.log(`    ${m.type} ${m.text} (${m.km.toFixed(1)} km)`);
    if (own.ferries.length) console.log('    Fähren:', own.ferries.map((f) => f.name + ' ' + f.km.toFixed(0) + ' km').join(', '));
  }
  console.log(`Größe ${(size / 1e6).toFixed(1)} MB`);
  process.exit(bad ? 1 : 0);
})();
