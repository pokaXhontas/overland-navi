/* Routenplaner: Start, Zwischenstopps und Ziel frei wählen. Die letzte Planung und die
 * zuletzt geplanten Routen bleiben gespeichert, „Route ändern“ führt hierher zurück. */
'use strict';

const Planner = {
  stops: [],
  active: -1,
  seq: 0,
  timer: null,
  picking: -1,

  label(s) { return !s ? '' : s.gps ? 'Mein Standort' : (s.name || 'Punkt auf der Karte'); },
  clean(s) { return !s ? null : s.gps ? { gps: true } : { name: s.name || '', lat: +(+s.lat).toFixed(6), lon: +(+s.lon).toFixed(6), ...(s.ferry ? { ferry: true } : {}) }; },

  open(stops) {
    if (Nav.pending) { Nav.pending = null; $('#nav-alts').hidden = true; Nav.draw(); }
    closeSearch(); closeSheet();
    if (typeof closeTrackInfo === 'function') closeTrackInfo();
    if (editor.open) closeEditor();
    const last = store.get('plan', null);
    this.stops = (stops || (last && last.stops) || [{ gps: true }, null]).map((s) => this.clean(s));
    if (this.stops.length < 2) this.stops.push(null);
    this.active = -1;
    $('#planner').hidden = false;
    this.render();
    // leeres Feld gleich zum Tippen öffnen
    const empty = this.stops.findIndex((s) => !s);
    if (empty >= 0) this.focus(empty);
  },

  close() {
    $('#planner').hidden = true;
    this.active = -1;
    this.save();
  },

  save() { store.set('plan', { stops: this.stops }); },

  render() {
    const box = $('#pl-stops');
    box.innerHTML = '';
    const n = this.stops.length;
    this.stops.forEach((s, i) => {
      const role = i === 0 ? 'start' : i === n - 1 ? 'end' : 'via';
      const row = document.createElement('div');
      row.className = 'pl-stop';
      row.innerHTML = `<span class="pl-dot ${role}">${role === 'via' ? i : ''}</span><input type="text" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search"><button class="round pl-x" type="button"></button>`;
      const inp = row.querySelector('input');
      inp.value = this.label(s);
      inp.placeholder = role === 'start' ? 'Start' : role === 'end' ? 'Ziel' : 'Zwischenstopp';
      if (s && s.gps) inp.classList.add('gps');
      inp.onfocus = () => this.focus(i, true);
      inp.oninput = () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.search(inp.value), 220); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const first = $('#pl-results .place-item'); if (first) first.click(); } };
      const x = row.querySelector('.pl-x');
      x.setAttribute('aria-label', role === 'via' ? 'Zwischenstopp entfernen' : 'Feld leeren');
      x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      x.onclick = () => {
        if (role === 'via') this.stops.splice(i, 1); else this.stops[i] = null;
        this.active = -1; this.save(); this.render();
        if (role !== 'via') this.focus(i);
      };
      box.appendChild(row);
    });
    document.querySelectorAll('#planner [data-profile]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.profile === Nav.profile));
      b.onclick = () => { Nav.profile = b.dataset.profile; store.set('navProfile2', Nav.profile); this.render(); };
    });
    const ready = this.stops.every(Boolean);
    $('#pl-go').disabled = !ready;
    $('#pl-line').hidden = !(ready && this.stops.length === 2 && this.stops[0].gps);
    $('#pl-add').disabled = this.stops.length >= 10;
    if (this.active < 0) this.showRecent();
  },

  focus(i, fromInput) {
    this.active = i;
    const rows = document.querySelectorAll('#pl-stops .pl-stop');
    rows.forEach((r, k) => r.classList.toggle('on', k === i));
    const inp = rows[i] && rows[i].querySelector('input');
    if (inp && !fromInput) { inp.focus(); }
    if (inp) { inp.select(); this.search(this.stops[i] ? '' : inp.value); }
  },

  /* Ergebnisliste unter den Feldern: Schnellwahl + Suchtreffer */
  async search(q) {
    const seq = ++this.seq;
    const box = $('#pl-results');
    const quick = [];
    if (!q.trim()) {
      quick.push({ name: 'Mein Standort', sub: 'Aktuelle GPS-Position', type: 'quick-gps' });
      quick.push({ name: 'Auf der Karte wählen', sub: 'Karte verschieben und Punkt übernehmen', type: 'quick-map' });
      for (const p of places.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 6)) {
        quick.push({ name: p.name, type: 'own', lat: p.lat, lon: p.lon, place: p, sub: 'Mein Ort · ' + (CAT[p.cat] || CAT.other).label, dist: gps.pos ? distance(gps.pos, p) : null });
      }
      renderResultList(box, quick, '', (r) => this.pick(r));
      return;
    }
    await Search.loadAll();
    if (seq !== this.seq) return;
    const local = Search.query(q);
    renderResultList(box, local, local.length ? '' : (navigator.onLine ? 'Suche online …' : 'Nichts gefunden.'), (r) => this.pick(r));
    const web = await Search.online(q);
    if (seq !== this.seq) return;
    if (web.length) renderResultList(box, [...local, ...web.filter((w) => !local.some((l) => distance(l, w) < 300 && norm(l.name) === norm(w.name)))], '', (r) => this.pick(r));
    else if (!local.length) renderResultList(box, [], 'Nichts gefunden.', () => {});
  },

  async pick(r) {
    const i = this.active;
    if (i < 0) return;
    if (r.type === 'quick-map') { this.pickOnMap(i); return; }
    if (r.type === 'ferry') {
      const st = await Nav.ferryStop(r);
      this.stops[i] = this.clean(st);
      this.active = -1;
      document.activeElement && document.activeElement.blur();
      this.save(); this.render();
      const next = this.stops.findIndex((s) => !s);
      if (next >= 0) this.focus(next);
      return;
    }
    // lieber lesbare Namen: „Bischkek“ statt „Бишкек“, wenn es einen gibt
    const latin = (t) => /^[\p{Script=Latin}\d\s\p{P}\p{S}]+$/u.test(t);
    let name = r.name;
    if (name && !latin(name) && r.alts) { const alt = String(r.alts).split('|').find(latin); if (alt) name = alt; }
    this.stops[i] = r.type === 'quick-gps' ? { gps: true } : this.clean({ name, lat: r.lat, lon: r.lon });
    this.active = -1;
    document.activeElement && document.activeElement.blur();
    this.save();
    this.render();
    const next = this.stops.findIndex((s) => !s);
    if (next >= 0) this.focus(next);
  },

  showRecent() {
    const box = $('#pl-results');
    const rec = store.get('planRecent', []);
    box.innerHTML = '';
    if (!rec.length) { box.innerHTML = '<p class="muted small sr-note">Tippe auf ein Feld, um Start, Ziel oder Zwischenstopps zu wählen.</p>'; return; }
    const h = document.createElement('p');
    h.className = 'region-group';
    h.textContent = 'Zuletzt geplant';
    box.appendChild(h);
    for (const r of rec) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'place-item';
      b.innerHTML = '<span class="pi-icon" style="background:#2F80ED;color:#fff"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 1 0 0-.01M18 5a2 2 0 1 0 0-.01M6 17V9a4 4 0 0 1 4-4h2M18 7v8a4 4 0 0 1-4 4h-2"/></svg></span><span class="pi-txt"><b></b><small></small></span>';
      b.querySelector('b').textContent = this.label(r.stops[0]) + ' → ' + this.label(r.stops[r.stops.length - 1]);
      const vias = r.stops.slice(1, -1).map((s) => this.label(s));
      b.querySelector('small').textContent = (vias.length ? 'über ' + vias.join(', ') + ' · ' : '') + new Date(r.time).toLocaleDateString('de-DE');
      b.onclick = () => { this.stops = r.stops.map((s) => this.clean(s)); this.save(); this.render(); };
      box.appendChild(b);
    }
  },

  remember() {
    const stops = this.stops.map((s) => this.clean(s));
    const key = JSON.stringify(stops);
    const rec = store.get('planRecent', []).filter((r) => JSON.stringify(r.stops) !== key);
    rec.unshift({ stops, time: Date.now() });
    store.set('planRecent', rec.slice(0, 10));
  },

  go(mode) {
    if (!this.stops.every(Boolean)) { toast('Bitte Start und Ziel wählen.'); return; }
    this.save();
    this.remember();
    $('#planner').hidden = true;
    Nav.plan(this.stops.map((s) => this.clean(s)), mode);
  },

  /* Punkt auf der Karte wählen */
  pickOnMap(i) {
    this.picking = i;
    $('#planner').hidden = true;
    $('#crosshair').hidden = false;
    $('#pl-pickbar').hidden = false;
    const s = this.stops[i];
    if (s && !s.gps) map.easeTo({ center: [s.lon, s.lat] });
  },

  async takeMapPoint() {
    const i = this.picking;
    const c = map.getCenter();
    $('#crosshair').hidden = true;
    $('#pl-pickbar').hidden = true;
    this.picking = -1;
    let name = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    if (navigator.onLine) {
      try {
        const r = await originalFetch(`https://photon.komoot.io/reverse?lat=${c.lat.toFixed(6)}&lon=${c.lng.toFixed(6)}&lang=de`);
        const j = await r.json();
        const p = j.features && j.features[0] && j.features[0].properties;
        if (p) name = p.name || [p.street && (p.street + (p.housenumber ? ' ' + p.housenumber : '')), p.city || p.county].filter(Boolean).join(', ') || name;
      } catch (e) { /* Koordinaten als Name */ }
    }
    this.stops[i] = this.clean({ name, lat: c.lat, lon: c.lng });
    this.save();
    $('#planner').hidden = false;
    this.active = -1;
    this.render();
  },

  cancelMapPoint() {
    $('#crosshair').hidden = true;
    $('#pl-pickbar').hidden = true;
    this.picking = -1;
    $('#planner').hidden = false;
    this.render();
  },

  setup() {
    $('#btn-route').onclick = () => ($('#planner').hidden ? this.open() : this.close());
    $('#pl-close').onclick = () => this.close();
    $('#pl-add').onclick = () => {
      this.stops.splice(this.stops.length - 1, 0, null);
      this.render();
      this.focus(this.stops.length - 2);
    };
    $('#pl-swap').onclick = () => { this.stops.reverse(); this.save(); this.render(); };
    $('#pl-go').onclick = () => this.go('route');
    $('#pl-line').onclick = () => this.go('line');
    $('#pl-take').onclick = () => this.takeMapPoint();
    $('#pl-pick-cancel').onclick = () => this.cancelMapPoint();
    $('#nf-edit').onclick = () => {
      const a = Nav.active;
      if (!a) return;
      const st = a.stops || [{ gps: true }, { name: a.target.name, lat: a.target.lat, lon: a.target.lon }];
      Nav.stop(true);
      this.open(st);
    };
  }
};
