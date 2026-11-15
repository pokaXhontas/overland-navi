/* Eigene Routen einzeichnen: Punkte auf die Karte tippen, die App verbindet sie entlang von Wegen
 * (online) oder als gerade Linie (auch offline). Fertige Routen werden als Track gespeichert und
 * können später wieder bearbeitet werden. */
'use strict';

const Draw = {
  active: false,
  editId: null,
  pts: [],       // Wegpunkte [lon, lat]
  legs: [],      // Verbindung zwischen pts[i] und pts[i+1]: { mode, coords }
  history: [],
  mode: store.get('drawMode', 'road'),
  color: null,
  pending: 0,
  drag: null,
  confirmCancel: false,

  snapshot() { return JSON.stringify({ pts: this.pts, legs: this.legs }); },
  push() { this.history.push(this.snapshot()); if (this.history.length > 60) this.history.shift(); },
  persist() { store.set('drawDraft', this.active ? { pts: this.pts, legs: this.legs, editId: this.editId, color: this.color } : null); },

  start(track) {
    if (typeof closeTrackInfo === 'function') closeTrackInfo();
    if (editor.open) closeEditor();
    closeSearch(); closeSheet();
    if (Nav.active) Nav.stop(true);
    const draft = store.get('drawDraft', null);
    if (track && track.draw) {
      this.pts = JSON.parse(JSON.stringify(track.draw.pts));
      this.legs = JSON.parse(JSON.stringify(track.draw.legs));
      this.editId = track.id; this.color = track.color;
    } else if (!track && draft && draft.pts && draft.pts.length && !draft.editId) {
      this.pts = draft.pts; this.legs = draft.legs; this.editId = null; this.color = draft.color;
      toast('Deine angefangene Route ist wieder da.', 3000);
    } else {
      this.pts = []; this.legs = []; this.editId = null; this.color = null;
    }
    this.history = [];
    this.active = true;
    this.confirmCancel = false;
    gps.follow = false;
    $('#btn-locate').classList.remove('active');
    document.body.classList.add('drawing');
    $('#draw-bar').hidden = false;
    $('#draw-bar').classList.remove('mini');
    this.renderBar();
    this.redraw();
    if (track) map.fitBounds(trackBounds(track), { padding: 80, maxZoom: 15 });
    else if (!this.pts.length) toast('Tippe auf die Karte, um den ersten Punkt zu setzen.', 3500);
  },

  exit() {
    this.active = false;
    this.pts = []; this.legs = []; this.editId = null;
    this.persist();
    document.body.classList.remove('drawing');
    $('#draw-bar').hidden = true;
    this.redraw();
  },

  /* ---------- Verbindungen ---------- */
  straight(a, b) {
    // lange gerade Stücke unterteilen, damit Höhenprofil und Länge stimmen
    const d = distance({ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] });
    const n = Math.max(1, Math.min(200, Math.ceil(d / 250)));
    const out = [];
    for (let i = 0; i <= n; i++) out.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
    return out;
  },

  async routed(a, b) {
    const q = {
      locations: [{ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] }],
      costing: 'auto',
      costing_options: { auto: { shortest: true, use_tracks: 1, use_highways: 0.5, exclude_unpaved: false } },
      directions_type: 'none'
    };
    const r = await fetch(VALHALLA + '?json=' + encodeURIComponent(JSON.stringify(q)));
    const j = await r.json();
    if (!r.ok || !j.trip) throw new Error(j.error || 'kein Weg');
    const coords = [];
    for (const leg of j.trip.legs) coords.push(...Nav.decode6(leg.shape));
    // Anfang und Ende genau an die gesetzten Punkte hängen
    return [a, ...coords, b];
  },

  async makeLeg(i) {
    const leg = { mode: this.mode, coords: this.straight(this.pts[i], this.pts[i + 1]), busy: this.mode === 'road' };
    this.legs[i] = leg;
    if (this.mode !== 'road') return;
    if (!navigator.onLine) {
      leg.mode = 'line'; leg.busy = false;
      toast('Ohne Internet als gerade Linie verbunden.', 2500);
      return;
    }
    this.pending++;
    this.renderBar();
    const a = this.pts[i], b = this.pts[i + 1];
    try {
      const c = await this.routed(a, b);
      if (this.legs.includes(leg)) leg.coords = c;
    } catch (e) {
      if (this.legs.includes(leg)) { leg.mode = 'line'; toast('Hier kein Weg gefunden, gerade Linie gesetzt.', 2500); }
    } finally {
      leg.busy = false;
      this.pending--;
      this.redraw(); this.renderBar(); this.persist();
    }
  },

  /* ---------- Bearbeiten ---------- */
  add(ll, at) {
    this.push();
    const p = [+ll.lng.toFixed(6), +ll.lat.toFixed(6)];
    if (at === undefined || at >= this.pts.length) {
      this.pts.push(p);
      if (this.pts.length > 1) this.makeLeg(this.pts.length - 2);
    } else {
      // Zwischenpunkt: Verbindung at-1 → at wird zu zwei Verbindungen
      this.pts.splice(at, 0, p);
      this.legs.splice(at - 1, 1, null, null);
      this.makeLeg(at - 1); this.makeLeg(at);
    }
    this.afterChange();
  },

  remove(i) {
    this.push();
    this.pts.splice(i, 1);
    if (!this.pts.length) this.legs = [];
    else if (i === 0) this.legs.splice(0, 1);
    else if (i >= this.pts.length) this.legs.splice(i - 1, 1);
    else { this.legs.splice(i - 1, 2, null); this.makeLeg(i - 1); }
    toast('Punkt entfernt', 1500);
    this.afterChange();
  },

  move(i, ll) {
    this.pts[i] = [+ll.lng.toFixed(6), +ll.lat.toFixed(6)];
    if (i > 0) this.makeLeg(i - 1);
    if (i < this.pts.length - 1) this.makeLeg(i);
    this.afterChange();
  },

  undo() {
    const s = this.history.pop();
    if (!s) { toast('Nichts zum Rückgängigmachen'); return; }
    const o = JSON.parse(s);
    this.pts = o.pts; this.legs = o.legs.map((l) => l && { ...l, busy: false });
    // halb fertige Verbindungen neu holen
    this.legs.forEach((l, i) => { if (!l) this.makeLeg(i); });
    this.afterChange();
  },

  reverse() {
    if (this.pts.length < 2) return;
    this.push();
    this.pts.reverse();
    this.legs = this.legs.reverse().map((l) => l && { ...l, coords: [...l.coords].reverse() });
    this.afterChange();
  },

  afterChange() {
    this.confirmCancel = false;
    this.redraw(); this.renderBar(); this.persist();
  },

  length() {
    let d = 0;
    for (const l of this.legs) if (l) d += trackLength(l.coords);
    return d;
  },

  coords() {
    const out = [];
    for (const l of this.legs) {
      if (!l) continue;
      for (const c of l.coords) {
        const last = out[out.length - 1];
        if (!last || last[0] !== c[0] || last[1] !== c[1]) out.push(c);
      }
    }
    return out;
  },

  async finish() {
    if (this.pending) { toast('Einen Moment, die Wege werden noch berechnet …'); return; }
    if (this.pts.length < 2) { toast('Setze mindestens zwei Punkte.'); return; }
    const segs = [this.coords()];
    const draw = { pts: this.pts, legs: this.legs.map((l) => ({ mode: l.mode, coords: l.coords })) };
    let t = this.editId ? tracks.find((x) => x.id === this.editId) : null;
    if (t) {
      t.segments = segs; t.draw = draw; t.updated = Date.now();
    } else {
      const n = tracks.filter((x) => x.source === 'Gezeichnet').length + 1;
      t = { id: 'trk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), name: 'Eigene Route ' + n,
        color: TRACK_COLORS[tracks.length % TRACK_COLORS.length], segments: segs, visible: true,
        created: Date.now(), source: 'Gezeichnet', note: '', draw };
      tracks.push(t);
    }
    t.length = trackLength(segs[0]);
    await saveTrack(t);
    this.exit();
    updateTracksSource();
    toast('Route gespeichert. Gib ihr einen Namen, eine Farbe und Infos.', 3500);
    openTrackInfo(t);
  },

  cancel() {
    if (this.pts.length && !this.confirmCancel) {
      this.confirmCancel = true;
      $('#db-cancel').textContent = 'Wirklich?';
      setTimeout(() => { if (this.active) { this.confirmCancel = false; this.renderBar(); } }, 3000);
      return;
    }
    this.exit();
    toast(this.editId ? 'Änderungen verworfen' : 'Zeichnen beendet');
  },

  /* ---------- Anzeige ---------- */
  geojson() {
    const fc = { type: 'FeatureCollection', features: [] };
    if (!this.active) return fc;
    this.legs.forEach((l, i) => {
      if (l) fc.features.push({ type: 'Feature', properties: { kind: 'leg', i, mode: l.mode, busy: !!l.busy }, geometry: { type: 'LineString', coordinates: l.coords } });
    });
    this.pts.forEach((p, i) => {
      const role = i === 0 ? 'start' : i === this.pts.length - 1 ? 'end' : 'mid';
      fc.features.push({ type: 'Feature', properties: { kind: 'pt', i, role }, geometry: { type: 'Point', coordinates: p } });
    });
    return fc;
  },

  redraw() {
    const src = map && map.getSource('draw');
    if (src) src.setData(this.geojson());
  },

  renderBar() {
    if (!this.active) return;
    $('#db-len').textContent = this.pts.length > 1 ? fmtDist(this.length()) : '0 km';
    $('#db-info').textContent = this.pending ? 'Wege werden berechnet …'
      : this.pts.length === 0 ? 'Tippe auf die Karte für den Startpunkt'
      : this.pts.length === 1 ? 'Jetzt den nächsten Punkt setzen'
      : `${this.pts.length} Punkte · Punkt ziehen verschiebt, antippen löscht`;
    $('#db-title').textContent = this.editId ? 'Route bearbeiten' : 'Route zeichnen';
    $('#db-cancel').textContent = 'Verwerfen';
    document.querySelectorAll('[data-dmode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.dmode === this.mode)));
  },

  /* ---------- Bedienung auf der Karte ---------- */
  hit(point, layer, r) {
    if (!map.getLayer(layer)) return null;
    const f = map.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers: [layer] });
    return f.length ? f[0] : null;
  },

  onClick(e) {
    if (!this.active) return false;
    if (this.justDragged) { this.justDragged = false; return true; }
    const pt = this.hit(e.point, 'draw-points', 14);
    if (pt) { this.remove(pt.properties.i); return true; }
    const leg = this.hit(e.point, 'draw-line', 10);
    if (leg && this.pts.length > 1) { this.add(e.lngLat, leg.properties.i + 1); return true; }
    this.add(e.lngLat);
    return true;
  },

  setup() {
    $('#btn-draw').onclick = () => (this.active ? toast('Du zeichnest gerade. „Fertig“ speichert die Route.') : this.start());
    $('#db-undo').onclick = () => this.undo();
    $('#db-reverse').onclick = () => this.reverse();
    $('#db-cancel').onclick = () => this.cancel();
    $('#db-done').onclick = () => this.finish();
    document.querySelectorAll('[data-dmode]').forEach((b) => {
      b.onclick = () => { this.mode = b.dataset.dmode; store.set('drawMode', this.mode); this.renderBar(); };
    });
    map.on('click', (e) => { if (this.active) this.onClick(e); });

    // Punkte verschieben
    const down = (e) => {
      if (!this.active) return;
      const f = this.hit(e.point, 'draw-points', 16);
      if (!f) return;
      e.preventDefault();
      this.drag = { i: f.properties.i, moved: false, start: e.point };
      map.getCanvas().style.cursor = 'grabbing';
    };
    const moveTo = (e) => {
      const d = this.drag;
      if (!d) return;
      if (!d.moved && Math.hypot(e.point.x - d.start.x, e.point.y - d.start.y) < 6) return;
      if (!d.moved) { d.moved = true; this.push(); }
      this.pts[d.i] = [e.lngLat.lng, e.lngLat.lat];
      if (d.i > 0) this.legs[d.i - 1] = { mode: 'line', coords: [this.pts[d.i - 1], this.pts[d.i]], busy: true };
      if (d.i < this.pts.length - 1) this.legs[d.i] = { mode: 'line', coords: [this.pts[d.i], this.pts[d.i + 1]], busy: true };
      this.redraw();
    };
    const up = (e) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      map.getCanvas().style.cursor = '';
      if (d.moved) { this.justDragged = true; setTimeout(() => { this.justDragged = false; }, 400); this.move(d.i, { lng: this.pts[d.i][0], lat: this.pts[d.i][1] }); }
    };
    map.on('mousedown', down); map.on('touchstart', (e) => { if (e.originalEvent.touches.length === 1) down(e); });
    map.on('mousemove', moveTo); map.on('touchmove', moveTo);
    map.on('mouseup', up); map.on('touchend', up);

    const draft = store.get('drawDraft', null);
    if (draft && draft.pts && draft.pts.length) {
      if (draft.editId) { const t = tracks.find((x) => x.id === draft.editId); if (t) { this.start(t); this.pts = draft.pts; this.legs = draft.legs; this.afterChange(); } }
      else this.start();
    }
  }
};
