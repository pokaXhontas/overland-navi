/* Bildschirmfotos fürs Handbuch: die fertige App im Handy-Format (wie iPhone), Szene für Szene.
 * Aufruf: node manual_shots.js <url> <zielordner>
 * Jede Szene läuft für sich; geht eine schief, fehlt nur ihr Bild. */
'use strict';
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const SITE = process.argv[2];
const OUT = process.argv[3] || 'handbuch';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BKK = { lat: 42.8746, lon: 74.5698 };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--lang=de-DE'] });
  await browser.defaultBrowserContext().overridePermissions(new URL(SITE).origin, ['geolocation']);
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setGeolocation({ latitude: BKK.lat, longitude: BKK.lon, accuracy: 8 });
  page.on('pageerror', (e) => console.log('Seitenfehler:', e.message));
  await page.goto(SITE, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForFunction(() => typeof map !== 'undefined' && map && map.loaded(), { timeout: 90000 });
  await sleep(4000);

  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const shot = async (name, wait = 2500) => {
    await sleep(wait);
    await page.screenshot({ path: `${OUT}/${name}.webp`, type: 'webp', quality: 72 });
    console.log('Bild:', name);
  };
  // nummerierte Markierungen neben Knöpfen (für Übersichtsbilder)
  const marks = (list) => ev((list) => {
    document.querySelectorAll('.mm-badge').forEach((x) => x.remove());
    for (const [sel, n, side] of list) {
      const el = document.querySelector(sel);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      const b = document.createElement('div');
      b.className = 'mm-badge';
      b.textContent = n;
      const x = side === 'right' ? r.right + 4 : side === 'top' ? r.left + r.width / 2 - 13 : side === 'in' ? r.left + 6 : r.left - 30;
      const y = side === 'top' ? r.top - 30 : side === 'in' ? r.top + 6 : r.top + r.height / 2 - 13;
      b.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:26px;height:26px;border-radius:13px;background:#E8590C;color:#fff;font:800 14px/26px system-ui,sans-serif;text-align:center;z-index:99999;box-shadow:0 0 0 2px #fff,0 2px 6px rgba(0,0,0,.35)`;
      document.body.appendChild(b);
    }
  }, list);
  const unmark = () => ev(() => document.querySelectorAll('.mm-badge').forEach((x) => x.remove()));
  const reset = () => ev(() => {
    try { closeSearch(); } catch (e) { /* zu */ }
    try { closeSheet(); } catch (e) { /* zu */ }
    try { if (editor.open) closeEditor(); } catch (e) { /* zu */ }
    try { if (Nav.pending) $('#na-cancel').click(); Nav.stop(true); } catch (e) { /* zu */ }
    try { Planner.close(); } catch (e) { /* zu */ }
    try { Hike.close(); if (Hike.popup) Hike.popup.remove(); } catch (e) { /* zu */ }
    try { Tours.close(); } catch (e) { /* zu */ }
    try { if (Draw.active) Draw.cancel(); } catch (e) { /* zu */ }
    try { Poi.clear(); if (Poi.popup) Poi.popup.remove(); } catch (e) { /* zu */ }
    try { closeTrackInfo(); } catch (e) { /* zu */ }
    document.querySelectorAll('.maplibregl-popup').forEach((p) => p.remove());
    $('#toast').classList.remove('show');
  });
  const scene = async (name, fn) => {
    try { await fn(); } catch (e) { console.log('Szene fehlgeschlagen:', name, e.message); }
    try { await unmark(); await reset(); } catch (e) { /* weiter */ }
    await sleep(500);
  };
  const drive = (lat, lon, heading, speed = 12) => ev((lat, lon, heading, speed) => {
    onPosition({ coords: { latitude: lat, longitude: lon, accuracy: 6, speed, heading, altitude: 780 }, timestamp: Date.now() });
  }, lat, lon, heading, speed);

  // Fahrzeug als Positionssymbol, Topo-Karte
  await ev(() => { settings.vehicle = 'defender110'; settings.vehicleColor = '#4a5f45'; settings.mapType = 'topo'; refreshStyle(); buildMeMarker(); });
  await drive(BKK.lat, BKK.lon, 80);

  await scene('01-start', async () => {
    await ev(() => { gps.follow = false; map.jumpTo({ center: [74.5698, 42.8746], zoom: 13.5, bearing: 0, pitch: 0 }); });
    await sleep(3000);
    await marks([['.hud', 1, 'right'], ['#mapchip', 2, 'top'], ['#btn-search', 3], ['#btn-layers', 4], ['#btn-route', 5], ['#btn-hike', 6], ['#btn-draw', 7],
      ['#btn-compass', 8], ['#btn-locate', 9], ['.zoom', 10], ['#fab', 11, 'top']]);
    await shot('01-start', 2000);
  });

  await scene('02-menue', async () => {
    await ev(() => $('#btn-layers').click());
    await shot('02-menue');
    await ev(() => { const b = $('#sheet .sheet-body'); const h = [...b.querySelectorAll('h2')].find((x) => /Navigation/.test(x.textContent)); b.scrollTop = h.offsetTop - 10; });
    await shot('03-menue-ansagen', 800);
    await ev(() => { const b = $('#sheet .sheet-body'); const h = [...b.querySelectorAll('h2')].find((x) => /Darstellung/.test(x.textContent)); b.scrollTop = h.offsetTop - 10; });
    await shot('04-menue-darstellung', 800);
    await ev(() => { const b = $('#sheet .sheet-body'); const h = [...b.querySelectorAll('h2')].find((x) => /Offline-Karten/.test(x.textContent)); b.scrollTop = h.offsetTop - 10; });
    await shot('05-offline-karten', 1500);
    await ev(() => openAddPage());
    await sleep(1500);
    await ev(() => { $('#add-input').value = 'Deut'; renderCountries(); });
    await shot('06-gebiet-hinzufuegen', 1500);
  });

  await scene('07-suche', async () => {
    await ev(() => { map.jumpTo({ center: [74.59, 42.875], zoom: 13 }); openSearch(); });
    await sleep(600);
    await page.type('#search-input', 'Karakol', { delay: 40 });
    await page.waitForFunction(() => $('#search-results').children.length > 1, { timeout: 20000 }).catch(() => {});
    await shot('07-suche', 2500);
  });

  await scene('08-in-der-naehe', async () => {
    await ev(async () => { map.jumpTo({ center: [74.59, 42.875], zoom: 14.5 }); openSearch(); await Poi.run(POI.atm); });
    await shot('08-in-der-naehe', 3000);
    await ev(() => { closeSearch(); if (Poi.results[0]) Poi.focus(Poi.results[0]); });
    await shot('09-ort-infos', 3000);
  });

  await scene('10-route-planen', async () => {
    await ev(() => { gps.pos = { lat: 42.8746, lon: 74.5698 }; Nav.travel = 'car'; Nav.profile = 'road'; Planner.open([{ gps: true }, { name: 'Tscholpon-Ata', lat: 42.6497, lon: 77.0828 }, { name: 'Karakol', lat: 42.4907, lon: 78.3936 }]); });
    await shot('10-route-planen', 1500);
    await ev(() => $('#pl-go').click());
    await page.waitForFunction(() => Nav.pending, { timeout: 90000 }).catch(() => {});
    await shot('11-routenauswahl', 3500);
    await ev(() => { if (Nav.pending) $('#na-go').click(); });
    await sleep(1500);
    // ein Stück fahren, damit der nächste Hinweis oben steht
    await ev(async () => {
      const c = Nav.active.coords;
      for (let i = 0; i < Math.min(c.length - 1, 90); i += 3) {
        onPosition({ coords: { latitude: c[i][1], longitude: c[i][0], accuracy: 6, speed: 13, heading: null, altitude: 790 }, timestamp: Date.now() + i * 2000 });
        await new Promise((r) => setTimeout(r, 25));
      }
    });
    await marks([['#nb-dist', 1, 'right'], ['#nb-voice', 2], ['#nf-edit', 3, 'top'], ['#nf-overview', 4, 'top'], ['#nf-stop', 5, 'top']]);
    await shot('12-navigation', 3000);
  });

  await scene('13-zu-fuss', async () => {
    await ev(() => { Nav.travel = 'foot'; Nav.plan([{ name: 'Alplager Ala-Artscha', lat: 42.5625, lon: 74.4824 }, { name: 'Ak-Sai-Wasserfall', lat: 42.5465, lon: 74.5173 }], 'route'); });
    await page.waitForFunction(() => Nav.pending, { timeout: 90000 }).catch(() => {});
    await shot('13-zu-fuss', 3500);
    await ev(() => { Nav.travel = 'car'; });
  });

  await scene('14-bus-bahn', async () => {
    await ev(() => { Nav.travel = 'transit'; Nav.plan([{ name: 'Alexanderplatz', lat: 52.5219, lon: 13.4132 }, { name: 'Checkpoint Charlie', lat: 52.5076, lon: 13.3904 }], 'route'); });
    await page.waitForFunction(() => Nav.pending, { timeout: 90000 }).catch(() => {});
    await shot('14-bus-bahn', 3500);
    await ev(() => { Nav.travel = 'car'; });
  });

  await scene('15-offline-route', async () => {
    await ev(async () => {
      await RouteData.loadIndex();
      gps.pos = { lat: 42.8746, lon: 74.5698 };
      const t = { lat: 42.6, lon: 74.4815, name: 'Ala-Artscha' };
      const list = await Nav.offline([{ lat: 42.8746, lon: 74.5698, gps: true }, t], true);
      Nav.pickRoute(t, list.map((r) => Nav.prepare(t, r, 'route', { vias: [], joined: true })));
    });
    await shot('15-offline-route', 3000);
  });

  await scene('16-ort-speichern', async () => {
    await ev(() => { map.jumpTo({ center: [76.95, 42.43], zoom: 13, bearing: 0 }); });
    await sleep(2500);
    await ev(() => newPlaceHere());
    await shot('16-ort-position', 2000);
    await ev(() => $('#pick-ok').click());
    await sleep(800);
    await ev(() => {
      const c = [...document.querySelectorAll('#spot-cats button, #spot-cats .chip')].find((x) => /Wildcamping/.test(x.textContent));
      if (c) c.click();
      $('#spot-name').value = 'Seeufer am Issyk-Kul';
      const s = document.querySelectorAll('#spot-stars button, #spot-stars span');
      if (s[3]) s[3].click();
      for (const f of ['Eben', 'Ruhig']) { const b = [...document.querySelectorAll('#spot-feats button, #spot-feats .chip')].find((x) => x.textContent.includes(f)); if (b) b.click(); }
      $('#spot-note').value = 'Fester Sand, Zufahrt über die Piste vom Dorf. Abends windig.';
    });
    await shot('17-ort-eintragen', 1500);
  });

  await scene('18-wandern', async () => {
    await ev(() => { map.jumpTo({ center: [74.49, 42.57], zoom: 13.2, bearing: 0 }); });
    await sleep(6000);
    await ev(() => { const f = map.queryRenderedFeatures({ layers: ['hike-line'] }).find((x) => x.properties.s >= 2) || map.queryRenderedFeatures({ layers: ['hike-line'] })[0]; if (f) Hike.showInfo(f, map.getCenter()); });
    await shot('18-wanderweg', 2500);
    await ev(() => { if (Hike.popup) Hike.popup.remove(); Hike.open(); });
    await shot('19-wandermenue', 2000);
    await ev(() => Hike.close());
    await ev(async () => {
      for (let i = 0; i < 20 && !Tours.list().length; i++) await new Promise((r) => setTimeout(r, 300));
      if (Tours.list().length) await Tours.open(Tours.list()[0].properties.id);
    });
    await shot('20-tour', 3000);
  });

  await scene('21-route-zeichnen', async () => {
    await ev(() => { map.jumpTo({ center: [74.60, 42.87], zoom: 13, bearing: 0 }); Draw.start(); });
    await sleep(1500);
    for (const [x, y] of [[90, 560], [200, 470], [300, 330]]) { await page.mouse.click(x, y); await sleep(500); }
    await page.waitForFunction(() => Draw.pending === 0, { timeout: 60000 }).catch(() => {});
    await shot('21-route-zeichnen', 2500);
  });

  await scene('22-hybrid', async () => {
    await ev(() => { settings.mapType = 'hybrid'; refreshStyle(); map.jumpTo({ center: [74.6122, 42.8765], zoom: 15.5, bearing: 0 }); });
    await shot('22-hybrid', 7000);
    await ev(() => { settings.mapType = 'topo'; refreshStyle(); });
  });

  await scene('23-bus-bahn-karte', async () => {
    await ev(() => { store.set('oevOn', true); refreshStyle(); map.jumpTo({ center: [13.4050, 52.5200], zoom: 14.5, bearing: 0 }); });
    await shot('23-bus-bahn-karte', 7000);
    await ev(() => { store.set('oevOn', false); refreshStyle(); });
  });

  await scene('24-wasser-toiletten', async () => {
    await ev(() => { store.set('waterOn', true); store.set('serviceOn', true); refreshStyle(); map.jumpTo({ center: [8.5417, 47.3769], zoom: 15.5, bearing: 0 }); });
    await shot('24-wasser-toiletten', 7000);
  });

  await browser.close();
})();
