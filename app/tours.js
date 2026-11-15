/* Empfohlene Touren: fest eingebaute Wanderungen mit Wegverlauf aus OpenStreetMap und Reiseinfos */
'use strict';

const TOUR_ICON = { start: 'S', end: 'Z', pass: '▲', camp: '⛺', hut: '⌂', lake: '≈', spring: '♨', waterfall: '↓', view: '◉', dot: '•' };

const Tours = {
  files: ['kirgistan'],
  data: { type: 'FeatureCollection', features: [] },
  info: {},       // Tour-ID → { facts, md, sources, … , pack }
  current: null,

  on() { return store.get('toursOn', true); },

  async load() {
    const feats = [];
    for (const f of this.files) {
      try {
        const [g, i] = await Promise.all([
          fetch('tours/' + f + '.geojson').then((r) => (r.ok ? r.json() : null)),
          fetch('tours/' + f + '-info.json').then((r) => (r.ok ? r.json() : null))
        ]);
        if (i) for (const [id, t] of Object.entries(i.tours)) this.info[id] = { ...t, pack: i };
        if (g) feats.push(...g.features);
      } catch (e) { console.warn('Touren:', e); }
    }
    this.data = { type: 'FeatureCollection', features: feats };
    const src = map && map.getSource('tours');
    if (src) src.setData(this.geojson()); else if (feats.length) refreshStyle();
    if (!$('#hike-sheet').hidden) this.renderList();
  },

  list() { return this.data.features.filter((f) => f.properties.kind === 'tour'); },

  geojson() { return this.on() ? this.data : { type: 'FeatureCollection', features: [] }; },

  source() { return { type: 'geojson', data: this.geojson() }; },

  layers(dark) {
    const isTour = ['==', ['get', 'kind'], 'tour'];
    const isPt = ['==', ['get', 'kind'], 'point'];
    const halo = dark ? '#0B0F12' : '#FFFFFF';
    return [
      { id: 'tours-highlight', type: 'line', source: 'tours', filter: ['all', isTour, ['==', ['get', 'id'], '__keine__']],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 10, 14, 20], 'line-opacity': 0.25, 'line-blur': 2 } },
      { id: 'tours-casing', type: 'line', source: 'tours', filter: isTour,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': halo, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4, 14, 9], 'line-opacity': 0.9 } },
      { id: 'tours-line', type: 'line', source: 'tours', filter: isTour,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2.2, 14, 5] } },
      { id: 'tours-hit', type: 'line', source: 'tours', filter: isTour,
        paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 22 } },
      { id: 'tours-pt', type: 'circle', source: 'tours', filter: isPt, minzoom: 9,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4, 14, 7], 'circle-color': halo, 'circle-stroke-color': '#15191D', 'circle-stroke-width': 2 } },
      { id: 'tours-pt-label', type: 'symbol', source: 'tours', filter: isPt, minzoom: 11,
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': dark ? '#E9EEF1' : '#15191D', 'text-halo-color': halo, 'text-halo-width': 1.6 } },
      { id: 'tours-name', type: 'symbol', source: 'tours', filter: isTour, minzoom: 8,
        layout: { 'symbol-placement': 'line', 'text-field': ['concat', '★ ', ['get', 'name']], 'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-offset': [0, -1.2], 'symbol-spacing': 400 },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': halo, 'text-halo-width': 1.8 } },
      // weit herausgezoomt: ein Punkt pro Tour, damit man sie findet
      { id: 'tours-overview', type: 'circle', source: 'tours', filter: ['all', isPt, ['==', ['get', 'icon'], 'start']], maxzoom: 9,
        paint: { 'circle-radius': 6, 'circle-color': '#C2255C', 'circle-stroke-color': halo, 'circle-stroke-width': 2 } }
    ];
  },

  feature(id) { return this.list().find((f) => f.properties.id === id); },

  /* Tour als Track-Objekt, damit Höhenprofil, Navigation und Übernehmen wie bei Tracks gehen */
  asTrack(f) {
    const segs = f.geometry.coordinates.filter((l) => l.length > 1).map((l) => l.map((c) => [c[0], c[1]]));
    return { id: 'tour-' + f.properties.id, name: f.properties.name, color: f.properties.color, segments: segs,
      length: segs.reduce((s, g) => s + trackLength(g), 0), source: 'Empfohlene Tour' };
  },

  highlight(id) {
    if (!map.getLayer('tours-highlight')) return;
    map.setFilter('tours-highlight', ['all', ['==', ['get', 'kind'], 'tour'], ['==', ['get', 'id'], id || '__keine__']]);
  },

  async open(id) {
    const f = this.feature(id);
    if (!f) return;
    closeSearch(); closeSheet();
    if (typeof closeTrackInfo === 'function') closeTrackInfo();
    if (editor.open) closeEditor();
    Hike.close();
    const t = this.asTrack(f);
    const info = this.info[id] || {};
    const text = info.info ? this.info[info.info] || {} : info;
    const pack = info.pack || {};
    this.current = { id, t };
    this.highlight(id);

    $('#to-name').textContent = f.properties.name;
    $('#to-region').textContent = (pack.region ? pack.region + ' · ' : '') + 'Empfohlene Tour';
    $('#to-len').textContent = fmtDist(t.length);
    for (const s of ['#to-up', '#to-down', '#to-max']) $(s).textContent = '…';
    const facts = $('#to-facts');
    facts.innerHTML = '';
    for (const [k, v] of info.facts || []) {
      if (k === 'Länge') continue;
      const row = document.createElement('div');
      row.innerHTML = '<span class="lbl"></span><b></b>';
      row.firstChild.textContent = k;
      row.lastChild.textContent = v;
      facts.appendChild(row);
    }
    const lenFact = (info.facts || []).find((x) => x[0] === 'Länge');
    $('#to-lennote').textContent = 'Linie auf der Karte: ' + fmtDist(t.length) + (lenFact ? '. Laut Tourenbeschreibung: ' + lenFact[1] + '.' : '.') + ' Wegverlauf aus OpenStreetMap, vor Ort immer mit den Markierungen abgleichen.';

    // Wegpunkte der Tour
    const pts = this.data.features.filter((x) => x.properties.kind === 'point' && x.properties.id === id);
    const wp = $('#to-points');
    wp.innerHTML = '';
    for (const p of pts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'to-pt';
      b.innerHTML = '<span class="to-ico"></span><span></span>';
      b.firstChild.textContent = TOUR_ICON[p.properties.icon] || '•';
      b.firstChild.style.background = f.properties.color;
      b.lastChild.textContent = p.properties.label;
      b.onclick = () => map.flyTo({ center: p.geometry.coordinates, zoom: 14.5, duration: 800 });
      wp.appendChild(b);
    }

    $('#to-md').innerHTML = this.md(text.md || '');
    $('#to-general').innerHTML = pack.general ? this.md(pack.general) : '';
    const src = (info.sources || text.sources || []).map((i) => (pack.sources || [])[i]).filter(Boolean);
    $('#to-sources').innerHTML = this.md(src.map((s) => '- ' + s).join('\n') + '\n- Wegdaten: © OpenStreetMap-Mitwirkende') + (pack.note ? `<p class="muted small">${this.esc(pack.note)}</p>` : '');

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
    drawProfile(prof, null, $('#to-profile'), f.properties.color);
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
    const info = this.info[c.id] || {};
    const text = info.info ? this.info[info.info] || {} : info;
    const note = (info.facts || []).map(([k, v]) => k + ': ' + v).join('\n');
    const track = {
      id: 'trk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      name: c.t.name, color: c.t.color, segments: c.t.segments, visible: true, created: Date.now(),
      source: 'Empfohlene Tour', tourId: c.id, length: c.t.length,
      note: note + (text.md ? '\n\nInfos: in der Karte auf die Tour tippen (Wandern → Empfohlene Touren).' : '')
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
    const lines = src.split('\n');
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
        // auf dem Handy als Karten statt breiter Tabelle
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

  renderList() {
    const box = $('#hk-tour-list');
    if (!box) return;
    $('#hk-tours').checked = this.on();
    box.innerHTML = '';
    const list = this.list();
    if (!list.length) { box.innerHTML = '<p class="muted small">Touren werden geladen …</p>'; return; }
    for (const f of list) {
      const info = this.info[f.properties.id] || {};
      const dur = (info.facts || []).find((x) => x[0] === 'Dauer');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'track-item to-item';
      b.innerHTML = '<span class="ti-color"></span><span class="pi-txt"><b></b><small></small></span>';
      b.querySelector('.ti-color').style.background = f.properties.color;
      b.querySelector('b').textContent = f.properties.name;
      b.querySelector('small').textContent = fmtDist(f.properties.km * 1000) + (dur ? ' · ' + dur[1] : '');
      b.onclick = () => this.open(f.properties.id);
      box.appendChild(b);
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
    const tap = (e) => {
      if ((typeof Draw !== 'undefined' && Draw.active) || editor.open || editor.moving) return;
      if (map.queryRenderedFeatures(e.point, { layers: ['places-icon', 'tracks-hit'].filter((l) => map.getLayer(l)) }).length) return;
      if (this._lastTap === e.originalEvent) return;
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
