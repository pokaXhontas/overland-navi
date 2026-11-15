/* Probelauf der fertigen Seite in einem echten Browser (Chrome ohne Fenster):
 * Start, Fahrzeugsymbol, Route mit simulierter Fahrt, Luftbild/Hybrid, Länderliste.
 * Bildschirmfotos landen in shots/. Aufruf: node smoke_test.js <url> */
'use strict';
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const SITE = process.argv[2];
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1366, height: 1024 } });
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(new URL(SITE).origin, ['geolocation']);
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('Seitenfehler: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('Konsole: ' + m.text().slice(0, 200)); });
  await page.setGeolocation({ latitude: 42.8746, longitude: 74.5698, accuracy: 10 });
  await page.goto(SITE, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction(() => typeof map !== 'undefined' && map && map.loaded(), { timeout: 60000 });
  await sleep(4000);
  const shot = async (name) => { await sleep(2500); await page.screenshot({ path: `shots/${name}.png` }); console.log('Foto:', name); };

  // Stimmen
  console.log('Stimmen:', await page.evaluate(async () => { await Pack.load(); const v = Nav.packVoice(); let ok = 'nicht gespielt'; try { await Pack.play(v, ['d300', 'right'], 1); ok = 'abgespielt'; } catch (e) { ok = 'Fehler ' + e.message; } return Pack.index.voices.map((x) => x.name).join(', ') + ' | Standard: ' + v + ' | Probe: ' + ok + ' | Auswahl: ' + document.querySelectorAll('#voice-select option').length + ' Einträge'; }));

  // Fahrzeug als Positionssymbol
  await page.evaluate(() => {
    settings.vehicle = 'defender110'; settings.vehicleColor = '#4a5f45';
    gps.heading = 250; gps.speed = 10;
    onPosition({ coords: { latitude: 42.8746, longitude: 74.5698, accuracy: 8, speed: 10, heading: 250, altitude: 800 }, timestamp: Date.now() });
    buildMeMarker();
    map.jumpTo({ center: [74.5698, 42.8746], zoom: 15, bearing: 0 });
  });
  const veh = await page.evaluate(() => !!document.querySelector('.me.veh .me-car svg'));
  console.log('Fahrzeugsymbol sichtbar:', veh);
  await shot('1-fahrzeug');

  // Route berechnen und Fahrt simulieren
  // Berlin: Vorschläge zur Auswahl
  await page.evaluate(() => { gps.pos = { lat: 52.5219, lon: 13.4132 }; return Nav.start({ lat: 52.3906, lon: 13.0645, name: 'Potsdam' }, 'route'); });
  await page.waitForFunction(() => Nav.active || Nav.pending, { timeout: 60000 });
  console.log('Vorschläge Berlin–Potsdam:', await page.evaluate(() => Nav.pending ? Nav.pending.list.map((r) => Math.round(r.time / 60) + ' min/' + Math.round(r.total / 1000) + ' km').join(', ') : 'nur eine Route'));
  await shot('2a-vorschlaege');
  // Navi-Kamera und Spurhinweise auf der schnellsten Route
  await page.evaluate(() => { if (Nav.pending) $('#na-go').click(); });
  await sleep(4800);
  const laneInfo = await page.evaluate(async () => {
    const a = Nav.active;
    const ms = a.maneuvers.filter((x) => x.lanes && x.lanes.some((l) => !l.ok));
    const m = ms[Math.min(2, ms.length - 1)];
    if (!m) return 'keine Spurdaten (' + a.source + ')';
    let i = 0;
    while (i < a.cum.length - 1 && a.cum[i] < m.at - 220) i++;
    for (let k = Math.max(0, i - 8); k <= i; k++) {
      onPosition({ coords: { latitude: a.coords[k][1], longitude: a.coords[k][0], accuracy: 5, speed: 13, heading: null, altitude: 40 }, timestamp: Date.now() + k * 1000 });
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 1600));
    return ms.length + ' Abzweigungen mit Spurdaten (' + a.source + ') · ' + m.text + ' · ' + m.lanes.map((l) => (l.ok ? '[' : '(') + l.ind.join('/') + (l.ok ? ']' : ')')).join(' ') + ' · Zoom ' + map.getZoom().toFixed(1) + ', Neigung ' + Math.round(map.getPitch()) + '° · Spuren sichtbar: ' + !$('#nb-lanes').hidden;
  });
  console.log('Navi-Kamera:', laneInfo);
  await shot('2b-navi-kamera');
  await page.evaluate(() => Nav.stop(true));
  for (const prof of ['road', 'short']) {
    await page.evaluate((p) => { if (Nav.pending) $('#na-cancel').click(); Nav.stop(true); Nav.profile = p; gps.pos = { lat: 52.4766, lon: 13.4295 }; return Nav.start({ lat: 52.4876, lon: 13.4106, name: 'Test' }, 'route'); }, prof);
    await page.waitForFunction(() => Nav.active || Nav.pending, { timeout: 60000 });
    console.log('Neukölln→Kreuzberg ' + prof + ':', await page.evaluate(() => (Nav.pending ? Nav.pending.list : [Nav.active]).map((r) => Math.round(r.time / 60) + ' min/' + (r.total / 1000).toFixed(1) + ' km/' + r.source).join(', ')));
  }
  await page.evaluate(() => { Nav.profile = 'road'; });
  await page.evaluate(() => { if (Nav.pending) $('#na-cancel').click(); Nav.stop(true); gps.pos = { lat: 42.8746, lon: 74.5698 }; });
  await page.evaluate(() => Nav.start({ lat: 42.4901, lon: 78.3936, name: 'Karakol' }, 'route'));
  await page.waitForFunction(() => Nav.active || Nav.pending, { timeout: 60000 });
  await page.evaluate(() => { if (Nav.pending) $('#na-go').click(); });
  const info = await page.evaluate(() => ({ mode: Nav.active.mode, pts: Nav.active.coords.length, man: Nav.active.maneuvers.length, km: Math.round(Nav.active.total / 1000), src: Nav.active.source, first: (Nav.active.maneuvers[1] || {}).text }));
  console.log('Route:', JSON.stringify(info));
  await shot('2-route-uebersicht');
  await page.evaluate(async () => {
    const c = Nav.active.coords;
    for (let i = 0; i < Math.min(c.length - 1, 120); i += 3) {
      onPosition({ coords: { latitude: c[i][1], longitude: c[i][0], accuracy: 6, speed: 14, heading: null, altitude: 800 }, timestamp: Date.now() + i * 2000 });
      await new Promise((r) => setTimeout(r, 20));
    }
    map.jumpTo({ zoom: 16 });
  });
  console.log('Hinweis oben:', await page.evaluate(() => $('#nb-dist').textContent + ' · ' + $('#nb-text').textContent + ' | ' + $('#nf-rem').textContent + ' · ' + $('#nf-eta').textContent));
  await shot('3-unterwegs');

  // Luftlinie
  await page.evaluate(() => { Nav.stop(true); return Nav.start({ lat: 42.0, lon: 75.5, name: 'Song-Kul' }, 'line'); });
  console.log('Luftlinie:', await page.evaluate(() => $('#nb-dist').textContent + ' · ' + $('#nb-text').textContent));
  await shot('4-luftlinie');
  await page.evaluate(() => Nav.stop(true));

  // Wanderwege (Kirgistan, Ala-Artscha)
  await page.evaluate(() => { map.jumpTo({ center: [74.49, 42.57], zoom: 13.2, bearing: 0, pitch: 0 }); });
  await sleep(6000);
  console.log('Wanderwege:', await page.evaluate(() => {
    const regs = Hike.regions().map((r) => r.id).join(',');
    const f = map.getLayer('hike-line') ? map.queryRenderedFeatures({ layers: ['hike-line'] }) : [];
    const sac = {};
    for (const x of f) sac['T' + x.properties.s] = (sac['T' + x.properties.s] || 0) + 1;
    sac.Feldwege = map.getLayer('hike-track') ? map.queryRenderedFeatures({ layers: ['hike-track'] }).length : 0;
    return 'Länder: ' + regs + ' · sichtbare Wegstücke: ' + f.length + ' ' + JSON.stringify(sac);
  }));
  await page.evaluate(() => { const f = map.queryRenderedFeatures({ layers: ['hike-line'] }).find((x) => x.properties.s >= 2) || map.queryRenderedFeatures({ layers: ['hike-line'] })[0]; if (f) Hike.showInfo(f, map.getCenter()); });
  await shot('4b-wanderwege');
  await page.evaluate(() => { if (Hike.popup) Hike.popup.remove(); Hike.open(); });
  await shot('4c-wandermenue');
  await page.evaluate(() => Hike.close());

  // Luftbild und Hybrid
  for (const t of ['sat', 'hybrid']) {
    await page.evaluate((t) => { settings.mapType = t; refreshStyle(); map.jumpTo({ center: [74.6122, 42.8765], zoom: 16, bearing: 0 }); }, t);
    await page.waitForFunction(() => map.loaded(), { timeout: 60000 }).catch(() => {});
    await shot('5-' + t);
  }
  await page.evaluate(() => { settings.mapType = 'topo'; refreshStyle(); });

  // Routenplaner: Start, Zwischenstopp, Ziel über die Eingabefelder
  await page.evaluate(() => { Nav.stop(true); Planner.open([null, null]); });
  await sleep(500);
  const typePick = async (i, text) => {
    await page.evaluate((i) => { document.querySelectorAll('#pl-stops input')[i].focus(); }, i);
    await page.keyboard.type(text, { delay: 30 });
    await page.waitForFunction(() => document.querySelectorAll('#pl-results .place-item').length > 0, { timeout: 30000 });
    await sleep(1500);
    await page.evaluate(() => document.querySelector('#pl-results .place-item').click());
    await sleep(300);
  };
  await typePick(0, 'Bischkek');
  await typePick(1, 'Karakol');
  await page.evaluate(() => $('#pl-add').click());
  await typePick(1, 'Tscholpon-Ata');
  console.log('Planer:', await page.evaluate(() => Planner.stops.map((s) => Planner.label(s)).join(' → ')));
  await shot('11-planer');
  await page.evaluate(() => $('#pl-go').click());
  await page.waitForFunction(() => Nav.pending, { timeout: 60000 });
  console.log('Geplante Route:', await page.evaluate(() => Nav.pending.list.map((r) => Math.round(r.time / 60) + ' min/' + Math.round(r.total / 1000) + ' km/' + r.vias.length + ' Stopp').join(', ') + ' · ' + $('#na-sub').textContent));
  await shot('12-geplante-route');
  // Wischgesten: Routenauswahl nach unten klein, wieder hoch; Tacho zur Seite
  const drag = async (sel, dx, dy) => {
    const r = await page.evaluate((sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + Math.min(30, b.height / 2) }; }, sel);
    await page.mouse.move(r.x, r.y); await page.mouse.down();
    for (let k = 1; k <= 12; k++) { await page.mouse.move(r.x + dx * k / 12, r.y + dy * k / 12); await sleep(16); }
    await page.mouse.up(); await sleep(500);
  };
  await drag('#nav-alts', 0, 260);
  console.log('Routenauswahl nach Wischen:', await page.evaluate(() => $('#nav-alts').className));
  await shot('12b-auswahl-klein');
  await drag('#nav-alts', 0, -200);
  console.log('Nach Hochwischen:', await page.evaluate(() => $('#nav-alts').className));
  await drag('.hud', -260, 0);
  console.log('Tacho:', await page.evaluate(() => document.querySelector('.hud').className));
  await page.evaluate(() => document.querySelector('.hud').click());
  console.log('Tacho nach Antippen:', await page.evaluate(() => document.querySelector('.hud').className));
  await page.evaluate(() => $('#na-edit').click());
  await sleep(500);
  console.log('Nach „Route ändern“:', await page.evaluate(() => !$('#planner').hidden && Planner.stops.map((s) => Planner.label(s)).join(' → ')));
  await page.evaluate(() => Planner.close());
  console.log('Zuletzt geplant:', await page.evaluate(() => store.get('planRecent', []).length));

  // Route zeichnen: echte Taps auf die Karte
  await page.evaluate(() => { map.jumpTo({ center: [74.60, 42.87], zoom: 13, bearing: 0 }); Draw.start(); });
  await sleep(1500);
  for (const [x, y] of [[560, 640], [760, 520], [900, 380]]) { await page.mouse.click(x, y); await sleep(400); }
  await page.waitForFunction(() => Draw.pending === 0, { timeout: 60000 });
  console.log('Gezeichnet:', await page.evaluate(() => Draw.pts.length + ' Punkte, ' + $('#db-len').textContent + ', Verbindungen: ' + Draw.legs.map((l) => l.mode + '/' + l.coords.length).join(' ')));
  await page.mouse.click(760, 520); await sleep(500);
  console.log('Nach Antippen eines Punkts:', await page.evaluate(() => Draw.pts.length + ' Punkte'));
  await page.evaluate(() => Draw.undo());
  await page.waitForFunction(() => Draw.pending === 0, { timeout: 60000 });
  await shot('9-zeichnen');
  await page.evaluate(() => Draw.finish());
  await sleep(1500);
  console.log('Gespeichert:', await page.evaluate(() => { const t = tracks[tracks.length - 1]; return t && t.source + ' · ' + t.name + ' · ' + Math.round(t.length) + ' m'; }));
  await shot('10-track-infos');
  await page.evaluate(() => { $('#ti-follow').click(); });
  await sleep(1000);
  console.log('Track folgen:', await page.evaluate(() => Nav.active && Nav.active.track ? 'aktiv, ' + $('#nf-rem').textContent : 'nicht aktiv'));
  await page.evaluate(() => Nav.stop(true));

  // Menü: Fahrzeugauswahl und Länderliste
  await page.evaluate(() => $('#btn-layers').click());
  await page.evaluate(() => $('#voice-test').scrollIntoView());
  await sleep(300);
  await page.click('#voice-test');
  await sleep(1500);
  console.log('Probe hören (Web-Audio):', await page.evaluate(() => Pack.how + ' · ' + (Pack.ctx && Pack.ctx.state)));
  await page.evaluate(() => { Pack._r = Pack.running; Pack.running = async () => false; Pack.how = ''; });
  await page.click('#voice-test');
  await sleep(1500);
  console.log('Probe hören (Ersatzweg Audio-Player):', await page.evaluate(() => Pack.how + ' · läuft: ' + (Pack.el && !Pack.el.paused) + ' · Dauer ' + (Pack.el && Pack.el.duration ? Pack.el.duration.toFixed(2) : '?') + ' s'));
  await page.evaluate(() => { Pack.running = Pack._r; });
  await page.evaluate(() => $('#veh-grid').scrollIntoView());
  await shot('6-menue-fahrzeuge');
  await drag('#sheet', 300, 0);
  console.log('Menü nach Wischen nach rechts:', await page.evaluate(() => $('#sheet').hidden ? 'zu' : 'offen'));
  await page.evaluate(() => $('#btn-layers').click());
  await sleep(500);
  await page.evaluate(() => openAddPage());
  await sleep(2000);
  const n = await page.evaluate(() => document.querySelectorAll('#country-list .country').length);
  console.log('Länder in der Liste:', n);
  await shot('7-gebiet-hinzufuegen');

  // iPhone-Größe mit Navigation
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluate(() => { closeSheet(); return Nav.start({ lat: 42.4901, lon: 78.3936, name: 'Karakol' }, 'route'); });
  await page.evaluate(() => { if (Nav.pending) $('#na-go').click(); });
  await sleep(5000);
  await page.evaluate(() => { const c = Nav.active.coords; onPosition({ coords: { latitude: c[30][1], longitude: c[30][0], accuracy: 6, speed: 14, heading: null, altitude: 800 }, timestamp: Date.now() }); map.jumpTo({ zoom: 15 }); });
  await shot('8-iphone-navigation');

  await browser.close();
  const real = errors.filter((e) => !/Failed to load resource|ERR_|404|tiles\/dem/.test(e));
  console.log(real.length ? 'Fehler:\n' + real.join('\n') : 'Keine Fehler im Browser');
  process.exit(real.length || !veh || info.mode !== 'route' ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
