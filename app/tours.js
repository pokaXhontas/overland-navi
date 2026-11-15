/* Touren: pro Land ladbare Pakete.
 * ★ Empfohlen: von Hand recherchiert, mit ausführlichen Infos (liegen bei der App, Ordner tours/).
 * Bekannte Routen: automatisch aus OpenStreetMap (Wikipedia-Eintrag, Fernwanderweg …), über den Kartenproxy. */
'use strict';

const TOUR_ICON = { start: 'S', end: 'Z', pass: '▲', camp: '⛺', hut: '⌂', lake: '≈', spring: '♨', waterfall: '↓', view: '◉', dot: '•' };
const TOUR_NET = { iwn: 'international', nwn: 'national', rwn: 'regional', lwn: 'lokal' };
const TOUR_MARK = { red: 'rot', blue: 'blau', yellow: 'gelb', green: 'grün', orange: 'orange', purple: 'lila', black: 'schwarz', white: 'weiß', brown: 'braun' };
const TOUR_CACHE = 'ovl-tours';

const Tours = {
  curated: [],     // aus tours/index.json: { file, country, name, n, top }
  packs: {},       // Land → { cur: FeatureCollection|null, osm: FeatureCollection|null }
  info: {},        // Tour-ID → Infos der empfohlenen Touren
  data: { type: 'FeatureCollection', features: [] },
  current: null,
  browsing: false,

  on() { return store.get('toursOn', true); },
  installed() {
    let l = store.get('tourPacks', null);
    if (!l) { l = [{ id: 'kyrgyzstan', date: '' }]; store.set('tourPacks', l); }
    return l;
  },
  isInstalled(id) { return this.installed().some((p) => p.id === id); },

  countryName(id) {
    const c = this.curated.find((p) => p.country === id);
    if (c) return c.name;
    const m = Hike.index[id];
    try { if (m && m.iso && m.iso[0]) return new Intl.DisplayNames(['de'], { type: 'region' }).of(m.iso[0]); } catch (e) { /* weiter */ }
    return (m && m.name) || id;
  },

  osmUrl(id) { const u = Hike.url(id); return u ? u.replace(/\.pmtiles$/, '-touren.json') : null; },

  /* JSON holen: erst gespeicherte Fassung, sonst Netz (und merken) */
  async getJSON(url, refresh) {
    let cache = null;
    try { cache = await caches.open(TOUR_CACHE); } catch (e) { /* ohne Cache */ }
    if (cache && !refresh) {
      const hit = await cache.match(url);
      if (hit) return hit.json();
    }
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (cache) await cache.put(url, r.clone());
      return r.json();
    } catch (e) {
      const hit = cache && await cache.match(url);
      if (hit) return hit.json();
      throw e;
    }
  },

  async loadPack(id, refresh) {
    const pack = { cur: null, osm: null };
    const cur = this.curated.find((p) => p.country === id);
    if (cur) {
      try {
        const [g, i] = await Promise.all([this.getJSON('tours/' + cur.file + '.geojson', refresh), this.getJSON('tours/' + cur.file + '-info.json', refresh)]);
        for (const f of g.features) f.properties.pack = id;
        pack.cur = g;
        for (const [tid, t] of Object.entries(i.tours)) this.info[tid] = { ...t, pack: i };
      } catch (e) { console.warn('Touren', id, e); }
    }
    if (Hike.index[id] && Hike.index[id].tours && this.osmUrl(id)) {
      try {
        const g = await this.getJSON(this.osmUrl(id), refresh);
        // Routen, die schon als empfohlene Tour drin sind, nicht doppelt zeigen
        const curF = pack.cur ? pack.cur.features : [];
        const names = new Set(curF.map((f) => (f.properties.name || '').toLowerCase()));
        const rels = new Set(curF.map((f) => f.properties.osm).filter(Boolean));
        const dup = new Set(g.features.filter((f) => f.properties.kind === 'tour' && (rels.has(f.properties.osm) || names.has((f.properties.name || '').toLowerCase()))).map((f) => f.properties.id));
        g.features = g.features.filter((f) => !dup.has(f.properties.id));
        for (const f of g.features) { f.properties.pack = id; f.properties.auto = true; }
        pack.osm = g;
      } catch (e) { console.warn('Touren OSM', id, e); }
    }
    this.packs[id] = pack;
    return pack;
  },

  rebuild() {
    const feats = [];
    for (const p of this.installed()) {
      const pk = this.packs[p.id];
      if (!pk) continue;
      if (pk.cur) feats.push(...pk.cur.features);
      if (pk.osm) feats.push(...pk.osm.features);
    }
    this.data = { type: 'FeatureCollection', features: feats };
    const src = map && map.getSource('tours');
    if (src) src.setData(this.geojson());
    if (!$('#hike-sheet').hidden) this.renderList();
  },

  async load() {
    try { this.curated = (await this.getJSON('tours/index.json', navigator.onLine)).packs || []; } catch (e) { this.curated = []; }
    const list = this.installed();
    await Promise.all(list.map((p) => {
      const date = (Hike.index[p.id] && Hike.index[p.id].date) || '';
      const refresh = !!(navigator.onLine && date && date !== p.date);
      return this.loadPack(p.id, refresh).then(() => { if (refresh) p.date = date; });
    }));
    store.set('tourPacks', list);
    const had = !!(map && map.getSource('tours'));
    this.rebuild();
    if (!had && this.data.features.length) refreshStyle();
  },

  async install(id) {
    if (!navigator.onLine) { toast('Zum Laden brauchst du Internet.'); return; }
    toast('Touren werden geladen …');
    const pk = await this.loadPack(id, true);
    if (!pk.cur && !pk.osm) { toast('Laden hat nicht geklappt. Später nochmal versuchen.'); return; }
    const l = this.installed().filter((p) => p.id !== id);
    l.push({ id, date: (Hike.index[id] && Hike.index[id].date) || '' });
    store.set('tourPacks', l);
    this.rebuild();
    if (!map.getSource('tours')) refreshStyle();
    const n = this.list().filter((f) => f.properties.pack === id).length;
    toast(`${this.countryName(id)}: ${n} Touren geladen, auch offline verfügbar.`, 3500);
    this.renderBrowser();
  },

  async remove(id) {
    store.set('tourPacks', this.installed().filter((p) => p.id !== id));
    const cur = this.curated.find((p) => p.country === id);
    try {
      const cache = await caches.open(TOUR_CACHE);
      if (this.osmUrl(id)) await cache.delete(this.osmUrl(id));
      if (cur) { await cache.delete('tours/' + cur.file + '.geojson'); await cache.delete('tours/' + cur.file + '-info.json'); }
    } catch (e) { /* egal */ }
    delete this.packs[id];
    this.rebuild();
    this.renderBrowser();
  },

  list() { return this.data.features.filter((f) => f.properties.kind === 'tour'); },
  geojson() { return this.on() ? this.data : { type: 'FeatureCollection', features: [] }; },
  source() { return { type: 'geojson', data: this.geojson() }; },

  layers(dark) {
    const isTour = ['==', ['get', 'kind'], 'tour'];
    const isPt = ['==', ['get', 'kind'], 'point'];
    const auto = ['==', ['get', 'auto'], true];
    const halo = dark ? '#0B0F12' : '#FFFFFF';
    return [
      { id: 'tours-highlight', type: 'line', source: 'tours', filter: ['all', isTour, ['==', ['get', 'id'], '__keine__']],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 10, 14, 20], 'line-opacity': 0.25, 'line-blur': 2 } },
      { id: 'tours-casing', type: 'line', source: 'tours', filter: isTour,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': halo, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, ['case', auto, 2.5, 4], 14, ['case', auto, 6, 9]], 'line-opacity': 0.9 } },
      { id: 'tours-line', type: 'line', source: 'tours', filter: isTour,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 6, ['case', auto, 1.2, 2.2], 14, ['case', auto, 3, 5]],
          'line-opacity': ['case', auto, 0.85, 1] } },
      { id: 'tours-hit', type: 'line', source: 'tours', filter: isTour,
        paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 22 } },
      { id: 'tours-pt', type: 'circle', source: 'tours', filter: isPt, minzoom: 10,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7], 'circle-color': halo, 'circle-stroke-color': '#15191D', 'circle-stroke-width': 2 } },
      { id: 'tours-pt-label', type: 'symbol', source: 'tours', filter: isPt, minzoom: 11,
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 10 },
        paint: { 'text-color': dark ? '#E9EEF1' : '#15191D', 'text-halo-color': halo, 'text-halo-width': 1.6 } },
      { id: 'tours-name', type: 'symbol', source: 'tours', filter: isTour, minzoom: 8,
        layout: { 'symbol-placement': 'line', 'text-field': ['concat', ['case', auto, '', '★ '], ['get', 'name']], 'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-offset': [0, -1.2], 'symbol-spacing': 400 },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': halo, 'text-halo-width': 1.8 } },
      // weit herausgezoomt: ein Punkt je empfohlener Tour, damit man sie findet
      { id: 'tours-overview', type: 'circle', source: 'tours', filter: ['all', isPt, ['==', ['get', 'icon'], 'start'], ['!', ['has', 'auto']]], maxzoom: 9,
        paint: { 'circle-radius': 6, 'circle-color': '#C2255C', 'circle-stroke-color': halo, 'circle-stroke-width': 2 } }
    ];
  },

  feature(id) { return this.list().find((f) => f.properties.id === id); },

  /* Tour als Track-Objekt, damit Höhenprofil, Navigation und Übernehmen wie bei Tracks gehen */
  asTrack(f) {
    const segs = f.geometry.coordinates.filter((l) => l.length > 1).map((l) => l.map((c) => [c[0], c[1]]));
    return { id: 'tour-' + f.properties.id, name: f.properties.name, color: f.properties.color, segments: segs,
      length: segs.reduce((s, g) => s + trackLength(g), 0), source: 'Tour' };
  },

  highlight(id) {
    if (!map.getLayer('tours-highlight')) return;
    map.setFilter('tours-highlight', ['all', ['==', ['get', 'kind'], 'tour'], ['==', ['get', 'id'], id || '__keine__']]);
  },

  /* Infos einer automatisch gewählten Route aus ihren OSM-Angaben */
  osmInfo(p) {
    const facts = [];
    if (p.from) facts.push(['Von', p.from]);
    if (p.to) facts.push(['Nach', p.to]);
    if (p.rt === 'yes') facts.push(['Art', 'Rundweg']);
    if (p.dur) facts.push(['Dauer', p.dur]);
    if (p.dist) facts.push(['Länge laut Angabe', /km/.test(p.dist) ? p.dist : p.dist + ' km']);
    if (p.asc) facts.push(['Aufstieg laut Angabe', p.asc + (/m/.test(p.asc) ? '' : ' m')]);
    if (p.sac && SAC_INFO[p.sac]) facts.push(['Schwierigste Stelle', SAC_INFO[p.sac].t + ' · ' + SAC_INFO[p.sac].name]);
    if (p.mark) facts.push(['Markierung', TOUR_MARK[p.mark] || p.mark]);
    if (p.net) facts.push(['Wegenetz', TOUR_NET[p.net] || p.net]);
    if (p.ref) facts.push(['Nummer', p.ref]);
    if (p.op) facts.push(['Betreuer', p.op]);
    const links = [];
    if (p.wiki) links.push(`- [Wikipedia](${p.wiki})`);
    if (p.web && /^https?:\/\//.test(p.web)) links.push(`- [Website der Route](${p.web})`);
    if (p.osm) links.push(`- [Route bei OpenStreetMap](https://www.openstreetmap.org/relation/${p.osm})`);
    const md = (p.desc ? p.desc + '\n' : '') +
      'Automatisch aus OpenStreetMap ausgewählt, weil die Route bekannt ist (z. B. mit Wikipedia-Artikel oder als Fernwanderweg). Ausführliche Infos zu Anreise, Kosten und Unterkünften gibt es bei den empfohlenen Touren (★).';
    return { facts, md, sources: links.join('\n') + '\n- Wegdaten: © OpenStreetMap-Mitwirkende' };
  },

  async open(id) {
    const f = this.feature(id);
    if (!f) return;
    closeSearch(); closeSheet();
    if (typeof closeTrackInfo === 'function') closeTrackInfo();
    if (editor.open) closeEditor();
    Hike.close();
    if (Hike.popup) Hike.popup.remove();
    const t = this.asTrack(f);
    const pr = f.properties;
    const country = this.countryName(pr.pack);
    let facts, md, general = '', sources, note = '';
    if (pr.auto) {
      ({ facts, md, sources } = this.osmInfo(pr));
    } else {
      const info = this.info[id] || {};
      const text = info.info ? this.info[info.info] || {} : info;
      const pack = info.pack || {};
      facts = (info.facts || []).filter((x) => x[0] !== 'Länge');
      md = text.md || '';
      general = pack.general || '';
      const src = (info.sources || text.sources || []).map((i) => (pack.sources || [])[i]).filter(Boolean);
      sources = src.map((s) => '- ' + s).join('\n') + '\n- Wegdaten: © OpenStreetMap-Mitwirkende';
      note = pack.note || '';
      const lenFact = (info.facts || []).find((x) => x[0] === 'Länge');
      if (lenFact) facts.unshift(['Länge laut Beschreibung', lenFact[1]]);
    }
    this.current = { id, t };
    this.highlight(id);

    $('#to-name').textContent = pr.name;
    $('#to-region').textContent = country + ' · ' + (pr.auto ? 'Bekannte Route' : '★ Empfohlene Tour');
    $('#to-len').textContent = fmtDist(t.length);
    for (const s of ['#to-up', '#to-down', '#to-max']) $(s).textContent = '…';
    const box = $('#to-facts');
    box.innerHTML = '';
    box.hidden = !facts.length;
    for (const [k, v] of facts) {
      const row = document.createElement('div');
      row.innerHTML = '<span class="lbl"></span><b></b>';
      row.firstChild.textContent = k;
      row.lastChild.textContent = v;
      box.appendChild(row);
    }
    $('#to-lennote').textContent = 'Linie auf der Karte: ' + fmtDist(t.length) + '. Wegverlauf aus OpenStreetMap, vor Ort immer mit den Markierungen abgleichen.';

    const pts = this.data.features.filter((x) => x.properties.kind === 'point' && x.properties.id === id);
    const wp = $('#to-points');
    wp.innerHTML = '';
    for (const p of pts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'to-pt';
      b.innerHTML = '<span class="to-ico"></span><span></span>';
      b.firstChild.textContent = TOUR_ICON[p.properties.icon] || '•';
      b.firstChild.style.background = pr.color;
      b.lastChild.textContent = p.properties.label;
      b.onclick = () => map.flyTo({ center: p.geometry.coordinates, zoom: 14.5, duration: 800 });
      wp.appendChild(b);
    }

    $('#to-md').innerHTML = this.md(md);
    $('#to-general').innerHTML = general ? this.md(general) : '';
    $('#to-general-h').hidden = !general;
    $('#to-sources').innerHTML = this.md(sources) + (note ? `<p class="muted small">${this.esc(note)}</p>` : '');

    const sheet = $('#tour-sheet');
    sheet.hidden = false;
    sheet.querySelector('.sheet-body').scrollTop = 0;
    $('#to-profile').innerHTML = '<p class="muted small">Höhenprofil wird berechnet …</p>';
    requestAnimationFrame(() => {
      gps.follow = false; $('#btn-locate').classList.remove('active');
      const pad = setSheetPadding(sheet);
      map.fitBounds(trackBounds(t), { padding: { top: 70, left: 60, right: pad.right + 60, bottom: pad.bottom + 60 }, maxZoom: 15, duration: 700 });
    });

    const prof = await trackProfile(t);
    if (!this.current || this.current.t !== t) return;
    const m = (v) => (v === undefined || v === null || !isFinite(v)) ? '–' : Math.round(v).toLocaleString('de-DE') + ' m';
    $('#to-up').textContent = prof.points.length ? '+' + m(prof.up) : '–';
    $('#to-down').textContent = prof.points.length ? '−' + m(prof.down) : '–';
    $('#to-max').textContent = m(prof.max);
    drawProfile(prof, null, $('#to-profile'), pr.color);
  },

  close() {
    if ($('#tour-sheet').hidden) return;
    $('#tour-sheet').hidden = true;
    this.current = null;
    this.highlight(null);
  },

  async adopt() {
    const c = this.current;
    if (!c) return;
    if (tracks.some((x) => x.tourId === c.id)) { toast('Diese Tour ist schon in deinen Tracks.'); return; }
    const f = this.feature(c.id);
    const info = this.info[c.id] || {};
    const facts = f && f.properties.auto ? this.osmInfo(f.properties).facts : (info.facts || []);
    const track = {
      id: 'trk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      name: c.t.name, color: c.t.color, segments: c.t.segments, visible: true, created: Date.now(),
      source: 'Tour', tourId: c.id, length: c.t.length,
      note: facts.map(([k, v]) => k + ': ' + v).join('\n')
    };
    await saveTrack(track);
    tracks.push(track);
    updateTracksSource();
    toast('In deine Tracks übernommen. Dort kannst du sie ändern, färben und als GPX teilen.', 3500);
  },

  esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },

  inline(s) {
    return this.esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  },

  /* kleiner Markdown-Leser: Absätze, Listen (auch eingerückt), Tabellen, fett, Links */
  md(src) {
    const out = [];
    const lines = String(src || '').split('\n');
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      if (l.startsWith('|')) {
        const rows = [];
        while (i < lines.length && lines[i].startsWith('|')) { rows.push(lines[i]); i++; }
        const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        const head = cells(rows[0]);
        const body = rows.slice(1).filter((r) => !/^\|\s*-/.test(r)).map(cells);
        out.push('<div class="md-table">' + body.map((r) => '<div class="md-row">' + r.map((c, k) =>
          c ? `<div><span class="lbl">${this.inline(head[k] || '')}</span><span>${this.inline(c)}</span></div>` : '').join('') + '</div>').join('') + '</div>');
        continue;
      }
      if (/^\s*(- |\d+\. )/.test(l)) {
        const items = [];
        while (i < lines.length && /^\s*(- |\d+\. )/.test(lines[i])) {
          const m = lines[i].match(/^(\s*)(- |\d+\. )(.*)$/);
          items.push({ depth: m[1].length >> 1, text: m[3] });
          i++;
        }
        let html = '', depth = -1;
        for (const it of items) {
          while (depth < it.depth) { html += '<ul>'; depth++; }
          while (depth > it.depth) { html += '</ul>'; depth--; }
          html += `<li>${this.inline(it.text)}</li>`;
        }
        while (depth >= 0) { html += '</ul>'; depth--; }
        out.push(html);
        continue;
      }
      out.push(`<p>${this.inline(l)}</p>`);
      i++;
    }
    return out.join('');
  },

  /* Wandermenü: geladene Länder, aufklappbar */
  renderList() {
    const box = $('#hk-tour-list');
    if (!box) return;
    $('#hk-tours').checked = this.on();
    box.innerHTML = '';
    const inst = this.installed();
    $('#hk-tour-count').textContent = inst.length ? `${inst.length} ${inst.length === 1 ? 'Land' : 'Länder'} geladen` : 'Noch keine Touren geladen';
    for (const p of inst) {
      const tours = this.list().filter((f) => f.properties.pack === p.id);
      tours.sort((a, b) => (!!a.properties.auto - !!b.properties.auto) || (b.properties.score || 0) - (a.properties.score || 0));
      const cur = tours.filter((f) => !f.properties.auto).length;
      const det = document.createElement('details');
      det.className = 'to-pack';
      det.open = store.get('tourOpen', {})[p.id] || false;
      det.ontoggle = () => { const o = store.get('tourOpen', {}); o[p.id] = det.open; store.set('tourOpen', o); };
      const sum = document.createElement('summary');
      sum.innerHTML = '<span class="pi-txt"><b></b><small></small></span>';
      sum.querySelector('b').textContent = this.countryName(p.id);
      sum.querySelector('small').textContent = [cur ? `${cur} ★ empfohlen` : '', tours.length - cur ? `${tours.length - cur} bekannte Routen` : ''].filter(Boolean).join(' · ') || 'lädt …';
      det.appendChild(sum);
      for (const f of tours) {
        const pr = f.properties;
        const info = this.info[pr.id] || {};
        const dur = (info.facts || []).find((x) => x[0] === 'Dauer');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'track-item to-item';
        b.innerHTML = '<span class="ti-color"></span><span class="pi-txt"><b></b><small></small></span>';
        b.querySelector('.ti-color').style.background = pr.color;
        b.querySelector('b').textContent = (pr.auto ? '' : '★ ') + pr.name;
        b.querySelector('small').textContent = fmtDist(pr.km * 1000) + (dur ? ' · ' + dur[1] : pr.dur ? ' · ' + pr.dur : '') + (pr.sac && SAC_INFO[pr.sac] ? ' · bis ' + SAC_INFO[pr.sac].t : '');
        b.onclick = () => this.open(pr.id);
        det.appendChild(b);
      }
      box.appendChild(det);
    }
  },

  /* Seite „Touren laden“: alle Länder mit Paketen */
  openBrowser() {
    this.browsing = true;
    $('#hk-main').hidden = true;
    $('#hk-packs').hidden = false;
    $('#hk-title').textContent = 'Touren laden';
    $('#hk-back').hidden = false;
    $('#hk-search').value = '';
    this.renderBrowser();
    $('#hike-sheet .sheet-body').scrollTop = 0;
  },
  closeBrowser() {
    this.browsing = false;
    $('#hk-main').hidden = false;
    $('#hk-packs').hidden = true;
    $('#hk-title').textContent = 'Wandern';
    $('#hk-back').hidden = true;
    this.renderList();
  },

  renderBrowser() {
    if (!this.browsing) return;
    const box = $('#hk-pack-list');
    const q = $('#hk-search').value.trim().toLowerCase();
    const ids = new Set([...this.curated.map((p) => p.country), ...Hike.keys().filter((k) => Hike.index[k].tours && Hike.index[k].tours.n)]);
    let rows = [...ids].map((id) => {
      const cur = this.curated.find((p) => p.country === id);
      const osm = Hike.index[id] && Hike.index[id].tours;
      return { id, name: this.countryName(id), cur, osm, inst: this.isInstalled(id) };
    });
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.includes(q));
    rows.sort((a, b) => (b.inst - a.inst) || (!!b.cur - !!a.cur) || a.name.localeCompare(b.name, 'de'));
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = `<p class="muted small">${ids.size ? 'Kein Land gefunden.' : 'Die Länderliste lädt, sobald du online bist.'}</p>`; return; }
    for (const r of rows.slice(0, 80)) {
      const row = document.createElement('div');
      row.className = 'to-packrow';
      const what = [r.cur ? `★ ${r.cur.n} empfohlene Touren mit Infos` : '', r.osm ? `${r.osm.n} bekannte Routen` : ''].filter(Boolean).join(' · ');
      const top = [...(r.cur ? r.cur.top : []), ...(r.osm ? r.osm.top || [] : [])].slice(0, 3).join(', ');
      row.innerHTML = '<span class="pi-txt"><b></b><small></small><small class="to-top"></small></span><button type="button" class="btn small-btn"></button>';
      row.querySelector('b').textContent = r.name;
      row.querySelector('small').textContent = what;
      row.querySelector('.to-top').textContent = top ? 'z. B. ' + top : '';
      const btn = row.querySelector('button');
      btn.textContent = r.inst ? 'Entfernen' : 'Laden';
      btn.classList.toggle('primary', !r.inst);
      btn.onclick = () => (r.inst ? this.remove(r.id) : this.install(r.id));
      box.appendChild(row);
    }
  },

  setup() {
    $('#to-close').onclick = () => this.close();
    $('#to-follow').onclick = () => { const c = this.current; if (c) { this.close(); Nav.followTrack(c.t); } };
    $('#to-route').onclick = () => {
      const c = this.current;
      if (!c) return;
      const s = c.t.segments[0][0];
      this.close();
      Nav.choose({ lon: s[0], lat: s[1], name: 'Start: ' + c.t.name });
    };
    $('#to-adopt').onclick = () => this.adopt();
    $('#hk-tours').onchange = () => {
      store.set('toursOn', $('#hk-tours').checked);
      const src = map.getSource('tours');
      if (src) src.setData(this.geojson());
    };
    $('#hk-more').onclick = () => this.openBrowser();
    $('#hk-back').onclick = () => this.closeBrowser();
    $('#hk-search').oninput = () => this.renderBrowser();
    const tap = (e) => {
      if ((typeof Draw !== 'undefined' && Draw.active) || editor.open || editor.moving) return;
      if (this._lastTap === e.originalEvent) return;
      if (map.queryRenderedFeatures(e.point, { layers: ['places-icon', 'tracks-hit', 'hike-pts', 'poi-icon'].filter((l) => map.getLayer(l)) }).length) return;
      this._lastTap = e.originalEvent;
      const f = e.features && e.features[0];
      if (f) this.open(f.properties.id);
    };
    for (const l of ['tours-hit', 'tours-pt', 'tours-overview']) {
      map.on('click', l, tap);
      map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
    }
    this.load();
  }
};
