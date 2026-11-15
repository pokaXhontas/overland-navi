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
  await page.evaluate(() => Nav.start({ lat: 42.4901, lon: 78.3936, name: 'Karakol' }, 'route'));
  await page.waitForFunction(() => Nav.active, { timeout: 60000 });
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

  // Luftbild und Hybrid
  for (const t of ['sat', 'hybrid']) {
    await page.evaluate((t) => { settings.mapType = t; refreshStyle(); map.jumpTo({ center: [74.6122, 42.8765], zoom: 16, bearing: 0 }); }, t);
    await page.waitForFunction(() => map.loaded(), { timeout: 60000 }).catch(() => {});
    await shot('5-' + t);
  }
  await page.evaluate(() => { settings.mapType = 'topo'; refreshStyle(); });

  // Menü: Fahrzeugauswahl und Länderliste
  await page.evaluate(() => $('#btn-layers').click());
  await page.evaluate(() => $('#veh-grid').scrollIntoView());
  await shot('6-menue-fahrzeuge');
  await page.evaluate(() => openAddPage());
  await sleep(2000);
  const n = await page.evaluate(() => document.querySelectorAll('#country-list .country').length);
  console.log('Länder in der Liste:', n);
  await shot('7-gebiet-hinzufuegen');

  // iPhone-Größe mit Navigation
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluate(() => { closeSheet(); return Nav.start({ lat: 42.4901, lon: 78.3936, name: 'Karakol' }, 'route'); });
  await sleep(5000);
  await page.evaluate(() => { const c = Nav.active.coords; onPosition({ coords: { latitude: c[30][1], longitude: c[30][0], accuracy: 6, speed: 14, heading: null, altitude: 800 }, timestamp: Date.now() }); map.jumpTo({ zoom: 15 }); });
  await shot('8-iphone-navigation');

  await browser.close();
  const real = errors.filter((e) => !/Failed to load resource|ERR_|404|tiles\/dem/.test(e));
  console.log(real.length ? 'Fehler:\n' + real.join('\n') : 'Keine Fehler im Browser');
  process.exit(real.length || !veh || info.mode !== 'route' ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
