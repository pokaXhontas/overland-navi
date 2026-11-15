/* Navigation: Route zu einem Ziel berechnen (online) oder Luftlinie (überall), mit Abbiegehinweisen und Sprachansagen.
 * Eine berechnete Route bleibt gespeichert und funktioniert danach auch ohne Netz. */
'use strict';

const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const OSRM = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';

/* Mitgelieferte Stimmen: kurze Bausteine („In 300 Metern“ + „rechts abbiegen“), offline nutzbar */
const Pack = {
  index: null, ctx: null, buf: new Map(), playing: [],
  async load() {
    if (this.index) return this.index;
    try { const r = await fetch('voices/index.json'); this.index = r.ok ? await r.json() : null; } catch (e) { this.index = null; }
    if (!this.index || !this.index.voices) this.index = { voices: [], keys: [] };
    return this.index;
  },
  ac() {
    if (!this.ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      this.ctx = new C();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },
  get(voice, key) {
    const k = voice + '/' + key;
    if (this.buf.has(k)) return this.buf.get(k);
    const p = fetch(`voices/${voice}/${key}.mp3`)
      .then((r) => { if (!r.ok) throw new Error('fehlt'); return r.arrayBuffer(); })
      .then((ab) => new Promise((res, rej) => this.ac().decodeAudioData(ab, res, rej)));
    this.buf.set(k, p);
    p.catch(() => this.buf.delete(k));
    return p;
  },
  stop() { for (const s of this.playing) { try { s.stop(); } catch (e) { /* schon fertig */ } } this.playing = []; },
  async play(voice, keys, rate) {
    const ctx = this.ac();
    if (!ctx) throw new Error('kein Audio');
    // Navigationsansagen: andere Musik kurz leiser, auch bei Stummschalter hörbar
    try { if (navigator.audioSession) navigator.audioSession.type = 'transient'; } catch (e) { /* älteres iOS */ }
    const bufs = await Promise.all(keys.map((k) => this.get(voice, k)));
    this.stop();
    let t = ctx.currentTime + 0.05;
    for (const b of bufs) {
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.playbackRate.value = rate;
      s.connect(ctx.destination);
      s.start(t);
      t += b.duration / rate + 0.05;
      this.playing.push(s);
    }
  },
  preload(voice) { for (const k of (this.index && this.index.keys) || []) this.get(voice, k).catch(() => {}); }
};
document.addEventListener('pointerdown', () => { if (Pack.ctx || Pack.index) Pack.ac(); }, { passive: true });

const Nav = {
  active: null,
  profile: store.get('navProfile2', 'road'),
  pending: null,
  voice: store.get('navVoice', true),
  busy: false,

  /* ---------- Route holen ---------- */
  decode6(str) {
    const out = [];
    let i = 0, lat = 0, lon = 0;
    while (i < str.length) {
      for (const k of [0, 1]) {
        let b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = (res & 1) ? ~(res >> 1) : (res >> 1);
        if (k === 0) lat += d; else lon += d;
      }
      out.push([lon / 1e6, lat / 1e6]);
    }
    return out;
  },

  async valhalla(pts) {
    // Spielstraßen und „Anlieger frei“ nicht künstlich meiden, sonst entstehen in Wohngebieten große Umwege
    const town = { use_living_streets: 0.6, destination_only_penalty: 120, service_penalty: 10 };
    const opts = {
      tracks: { use_tracks: 0.8, use_highways: 0.6, exclude_unpaved: false, use_ferry: 0.5, ...town },
      short: { shortest: true, use_tracks: 0, use_ferry: 0.5, ...town, use_living_streets: 1 },
      road: { use_tracks: 0, use_highways: 1, use_ferry: 0.5, ...town }
    }[this.profile] || {};
    const locs = pts.map((p) => ({ lat: p.lat, lon: p.lon, type: 'break' }));
    if (pts[0].gps && gps.heading !== null && gps.speed > 2) { locs[0].heading = Math.round(gps.heading); locs[0].heading_tolerance = 60; }
    const q = {
      locations: locs,
      costing: 'auto', costing_options: { auto: opts },
      directions_options: { units: 'kilometers', language: 'de-DE' }
    };
    if (pts.length === 2) q.alternates = 2;
    const r = await fetch(VALHALLA + '?json=' + encodeURIComponent(JSON.stringify(q)));
    const j = await r.json();
    if (!r.ok || !j.trip) throw new Error((j && (j.error || j.status_message)) || 'Keine Route gefunden');
    return [j.trip, ...(j.alternates || []).map((a) => a.trip)].filter(Boolean).map((t) => this.parseTrip(t));
  },

  parseTrip(trip) {
    const coords = [], man = [];
    for (const leg of trip.legs) {
      const off = coords.length ? coords.length - 1 : 0;
      const pts = this.decode6(leg.shape);
      coords.push(...(coords.length ? pts.slice(1) : pts));
      for (const m of leg.maneuvers) {
        man.push({ idx: off + m.begin_shape_index, type: m.type, text: m.instruction,
          alert: m.verbal_transition_alert_instruction || m.verbal_pre_transition_instruction || m.instruction, exit: m.roundabout_exit_count || 0,
          verbal: m.verbal_pre_transition_instruction || m.instruction, street: (m.street_names || [])[0] || '' });
      }
    }
    return { coords, maneuvers: man, time: trip.summary.time, source: 'Valhalla' };
  },

  osrmText(s) {
    const mod = { left: 'links', right: 'rechts', 'slight left': 'halb links', 'slight right': 'halb rechts', 'sharp left': 'scharf links', 'sharp right': 'scharf rechts', straight: 'geradeaus', uturn: 'wenden' }[s.maneuver.modifier] || '';
    const on = s.name ? ' auf ' + s.name : '';
    switch (s.maneuver.type) {
      case 'depart': return 'Losfahren' + on;
      case 'arrive': return 'Ziel erreicht';
      case 'roundabout': case 'rotary': return `Im Kreisverkehr die ${s.maneuver.exit || ''}. Ausfahrt nehmen${on}`;
      case 'continue': case 'new name': return (mod && mod !== 'geradeaus' ? mod.charAt(0).toUpperCase() + mod.slice(1) + ' halten' : 'Weiter') + on;
      default: return mod === 'wenden' ? 'Wenden' : (mod ? mod.charAt(0).toUpperCase() + mod.slice(1) + ' abbiegen' : 'Weiter') + on;
    }
  },

  async osrm(pts) {
    const r = await fetch(`${OSRM}${pts.map((p) => p.lon + ',' + p.lat).join(';')}?overview=full&geometries=geojson&steps=true&alternatives=${pts.length === 2}`);
    const j = await r.json();
    if (!r.ok || !j.routes || !j.routes.length) throw new Error('Keine Route gefunden');
    return j.routes.slice(0, 3).map((route) => this.parseOsrm(route));
  },

  parseOsrm(route) {
    const coords = route.geometry.coordinates, man = [];
    let idx = 0;
    const typeOf = (s) => {
      const t = s.maneuver.type, m = s.maneuver.modifier || '';
      if (t === 'arrive') return 4;
      if (t === 'roundabout' || t === 'rotary') return 26;
      return { left: 15, right: 10, 'slight left': 16, 'slight right': 9, 'sharp left': 14, 'sharp right': 11, uturn: 13 }[m] || 8;
    };
    for (const leg of route.legs) {
      for (const s of leg.steps) {
        const [lon, lat] = s.maneuver.location;
        let best = idx, bd = Infinity;
        for (let i = idx; i < Math.min(coords.length, idx + 4000); i++) {
          const d = Math.abs(coords[i][0] - lon) + Math.abs(coords[i][1] - lat);
          if (d < bd) { bd = d; best = i; }
          if (d < 1e-7) break;
        }
        idx = best;
        const text = this.osrmText(s);
        man.push({ idx, type: typeOf(s), text, alert: text, verbal: text, street: s.name || '', exit: s.maneuver.exit || 0 });
      }
    }
    return { coords, maneuvers: man, time: route.duration, source: 'OSRM' };
  },

  prepare(target, res, mode, extra = {}) {
    const coords = res ? res.coords : [];
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distance({ lon: coords[i - 1][0], lat: coords[i - 1][1] }, { lon: coords[i][0], lat: coords[i][1] }));
    const maneuvers = res ? res.maneuvers.map((m) => ({ ...m, at: cum[Math.min(m.idx, cum.length - 1)] })) : [];
    // Zwischenstopps auf der Linie wiederfinden (der Reihe nach)
    let from = 0;
    const vias = (extra.vias || []).map((v) => {
      let best = from, bd = Infinity;
      for (let i = from; i < coords.length; i++) {
        const d = Math.abs(coords[i][0] - v.lon) + Math.abs(coords[i][1] - v.lat);
        if (d < bd) { bd = d; best = i; }
      }
      from = best;
      return { ...v, idx: best, at: cum[best] || 0 };
    });
    return { target, mode, coords, cum, total: cum[cum.length - 1] || 0, maneuvers, time: res ? res.time : 0, source: res ? res.source : '',
      vias, stops: extra.stops || null, joined: extra.joined !== false, startPt: extra.startPt || null,
      along: 0, seg: 0, off: 0, offCount: 0, lastReroute: Date.now(), spoken: {}, created: Date.now() };
  },

  /* Zwei unabhängige Routenrechner fragen und die Vorschläge zusammenlegen.
     Für Straßen kommen so mehr echte Alternativen zusammen; auf Pisten zählt nur Valhalla. */
  async calc(pts) {
    const jobs = [this.valhalla(pts)];
    if (this.profile !== 'tracks') jobs.push(this.osrm(pts));
    const results = await Promise.allSettled(jobs);
    let list = [];
    for (const r of results) if (r.status === 'fulfilled') list.push(...r.value);
    if (!list.length && this.profile === 'tracks') { try { list = await this.osrm(pts); } catch (e) { /* nichts */ } }
    if (!list.length) {
      const err = results.find((r) => r.status === 'rejected');
      throw (err && err.reason) || new Error('Keine Route gefunden');
    }
    const lenOf = (r) => trackLength(r.coords);
    const uniq = [];
    for (const r of list) {
      r.len = lenOf(r);
      if (!uniq.some((u) => Math.abs(u.len - r.len) < Math.max(80, u.len * 0.02) && Math.abs(u.time - r.time) < 90)) uniq.push(r);
    }
    uniq.sort(this.profile === 'short' ? (a, b) => a.len - b.len : (a, b) => a.time - b.time);
    return uniq.slice(0, 4);
  },

  async position() {
    if (gps.pos) return gps.pos;
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }), () => resolve(null), { enableHighAccuracy: true, timeout: 12000 });
    });
  },

  start(target, mode) { return this.plan([{ gps: true }, target], mode); },

  /* stops: [Start, Zwischenstopps …, Ziel]; ein Stopp ist { gps: true } (mein Standort) oder { name, lat, lon } */
  async plan(stops, mode) {
    if (this.busy) return;
    this.busy = true;
    try {
      const pts = [];
      let from = null;
      for (const s of stops) {
        if (s.gps) {
          from = from || await this.position();
          if (!from) { toast('Kein GPS-Standort. Bitte Ortung erlauben und kurz warten.', 4000); return; }
          pts.push({ lat: from.lat, lon: from.lon, name: 'Mein Standort', gps: true });
        } else pts.push(s);
      }
      if (!from) from = gps.pos;
      const target = pts[pts.length - 1];
      const extra = { stops, vias: pts.slice(1, -1), joined: !!pts[0].gps, startPt: pts[0] };
      if (mode === 'line') {
        this.active = this.prepare(target, null, 'line', extra);
      } else {
        if (!navigator.onLine) {
          toast('Ohne Internet keine Routenberechnung. Ich zeige dir die Luftlinie.', 4500);
          this.active = this.prepare(target, null, 'line', extra);
        } else {
          toast('Route wird berechnet …', 8000);
          try {
            const list = (await this.calc(pts)).map((r) => this.prepare(target, r, 'route', extra));
            $('#toast').classList.remove('show');
            this.pickRoute(target, list);
            return;
            this.active = list[0];
            toast(`Route: ${fmtDist(this.active.total)} · ${this.fmtTime(this.active.time)}`, 3000);
          } catch (e) {
            toast('Keine Route gefunden (' + e.message + '). Ich zeige dir die Luftlinie.', 5000);
            this.active = this.prepare(target, null, 'line', extra);
          }
        }
      }
      this.go(from);
    } finally { this.busy = false; }
  },

  /* mehrere Vorschläge: auf der Karte zeigen und auswählen lassen */
  pickRoute(target, list) {
    this.pending = { target, list, sel: 0 };
    const box = $('#nav-alts'), rows = $('#na-list');
    const fastest = Math.min(...list.map((r) => r.time));
    const shortest = Math.min(...list.map((r) => r.total));
    const render = () => {
      rows.innerHTML = '';
      list.forEach((r, i) => {
        const b = document.createElement('button');
        b.className = 'na-row';
        b.setAttribute('aria-checked', String(i === this.pending.sel));
        const tags = [];
        if (r.time <= fastest + 30) tags.push('schnellste');
        else tags.push('+' + Math.round((r.time - fastest) / 60) + ' min');
        if (r.total <= shortest + 50) tags.push('kürzeste');
        const extra = ' · ' + tags.join(' · ');
        b.innerHTML = `<b>${this.fmtTime(r.time)}</b><span>${fmtDist(r.total)}${extra}</span>`;
        b.onclick = () => { this.pending.sel = i; render(); this.draw(); };
        rows.appendChild(b);
      });
      const cur = list[this.pending.sel];
      $('#na-peek-time').textContent = `${this.fmtTime(cur.time)} · ${fmtDist(cur.total)}`;
    };
    render();
    box.classList.remove('peek');
    $('#na-peek-go').onclick = (e) => { e.stopPropagation(); $('#na-go').click(); };
    $('#na-go').onclick = () => {
      const p = this.pending;
      this.pending = null;
      box.hidden = true;
      this.active = p.list[p.sel];
      this.go(gps.pos);
    };
    $('#na-cancel').onclick = () => { this.pending = null; box.hidden = true; this.draw(); };
    $('#na-edit').onclick = () => { const st = list[0].stops; this.pending = null; box.hidden = true; this.draw(); Planner.open(st); };
    $('#na-save').onclick = () => this.saveAsTrack(this.pending.list[this.pending.sel]);
    $('#na-go').textContent = list[0].joined ? 'Losfahren' : 'Navigation starten';
    $('#na-title').textContent = list.length > 1 ? 'Route auswählen' : 'Deine Route';
    $('#na-sub').textContent = list.length > 1 ? 'Antippen zeigt sie auf der Karte' : ((list[0].vias.length ? list[0].vias.length + (list[0].vias.length === 1 ? ' Zwischenstopp' : ' Zwischenstopps') : 'Direkt') + ' · ' + (list[0].startPt && !list[0].startPt.gps ? 'ab ' + list[0].startPt.name : 'ab deinem Standort'));
    box.hidden = false;
    this.draw();
    const b = new maplibregl.LngLatBounds(list[0].coords[0], list[0].coords[0]);
    for (const r of list) for (const p of r.coords) b.extend(p);
    gps.follow = false;
    $('#btn-locate').classList.remove('active');
    map.fitBounds(b, { padding: { top: 120, bottom: 300, left: 60, right: 90 }, maxZoom: 15, bearing: 0, duration: 800 });
  },

  go(from) {
    {
      this.save();
      this.showUI(true);
      gps.follow = true;
      $('#btn-locate').classList.add('active');
      this.update(from);
      if (this.active.mode === 'route') {
        this.overview();
        const a = this.active;
        clearTimeout(this.followTimer);
        this.followTimer = setTimeout(() => { if (this.active === a) this.follow(); }, 4000);
      }
      this.say(this.active.mode === 'route' ? 'Route gestartet.' : 'Luftlinie zum Ziel.', false, [this.active.mode === 'route' ? 'start' : 'line']);
    }
  },

  /* einem gespeicherten Track folgen (auch offline) */
  followTrack(t) {
    let coords = [];
    for (const seg of t.segments) coords.push(...seg.map((c) => [c[0], c[1]]));
    if (coords.length < 2) return;
    const s = coords[0], e = coords[coords.length - 1];
    if (gps.pos && distance(gps.pos, { lon: e[0], lat: e[1] }) < distance(gps.pos, { lon: s[0], lat: s[1] })) {
      coords = coords.reverse();
      toast('Du bist näher am Ende: Track wird rückwärts gefahren.', 3500);
    }
    const last = coords[coords.length - 1];
    const len = trackLength(coords);
    this.active = this.prepare({ lon: last[0], lat: last[1], name: t.name }, { coords, maneuvers: [], time: len / (35 / 3.6), source: 'Track' }, 'route');
    this.active.track = true;
    this.go(gps.pos);
  },

  async reroute(pos) {
    const a = this.active;
    if (!a || a.mode !== 'route' || a.track || this.busy || !navigator.onLine) return;
    this.busy = true;
    a.lastReroute = Date.now();
    try {
      const rest = a.vias.filter((v) => v.at > a.along + 30);
      const res = await this.calc([{ ...pos, gps: true }, ...rest, a.target]);
      if (this.active !== a) return;
      this.active = this.prepare(a.target, res[0], 'route', { stops: a.stops, vias: rest, joined: true, startPt: a.startPt });
      this.save();
      this.say('Route neu berechnet.', false, ['reroute']);
      this.update(pos);
    } catch (e) { /* weiter mit alter Route */ } finally { this.busy = false; }
  },

  stop(silent) {
    this.active = null;
    store.set('nav', null);
    this.showUI(false);
    this.draw();
    if (!silent) toast('Navigation beendet');
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  },

  save() {
    const a = this.active;
    if (!a) return;
    const { spoken, ...rest } = a;
    store.set('nav', { ...rest, spoken: {} });
  },

  restore() {
    const a = store.get('nav', null);
    if (a && a.target && Date.now() - (a.created || 0) < 3 * 24 * 3600e3) {
      this.active = a;
      this.showUI(true);
      this.draw();
    }
  },

  /* ---------- Unterwegs ---------- */
  project(pos) {
    const a = this.active, c = a.coords;
    const kx = 111320 * Math.cos(pos.lat * Math.PI / 180), ky = 110540;
    let best = { d: Infinity, i: 0, t: 0 };
    const scan = (from, to) => {
      for (let i = Math.max(0, from); i < Math.min(c.length - 1, to); i++) {
        const ax = (c[i][0] - pos.lon) * kx, ay = (c[i][1] - pos.lat) * ky;
        const bx = (c[i + 1][0] - pos.lon) * kx, by = (c[i + 1][1] - pos.lat) * ky;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
        if (d < best.d) best = { d, i, t };
      }
    };
    scan(a.seg - 30, a.seg + 600);
    if (best.d > 80) scan(0, c.length);
    return best;
  },

  update(pos) {
    const a = this.active;
    if (!a || !pos) return;
    if (a.mode === 'line') {
      const d = distance(pos, a.target);
      a.along = 0;
      a.remaining = d;
      if (d < 30) { this.arrive(); return; }
    } else {
      const p = this.project(pos);
      a.seg = p.i;
      a.off = p.d;
      const segLen = a.cum[p.i + 1] - a.cum[p.i];
      a.along = a.cum[p.i] + p.t * segLen;
      a.remaining = a.total - a.along;
      a.proj = [a.coords[p.i][0] + p.t * (a.coords[p.i + 1][0] - a.coords[p.i][0]), a.coords[p.i][1] + p.t * (a.coords[p.i + 1][1] - a.coords[p.i][1])];
      if (!a.joined) {
        // noch auf dem Weg zum geplanten Start: nichts abhaken, nicht neu berechnen
        if (p.d < 60) a.joined = true;
        else { a.seg = 0; a.along = 0; a.remaining = a.total; a.proj = null; a.off = p.d; this.draw(pos); this.render(pos); return; }
      }
      if (p.d > 60) a.offCount++; else a.offCount = 0;
      if (a.remaining < 25 || (p.i >= a.coords.length - 2 && distance(pos, a.target) < 40)) { this.arrive(); return; }
      if (a.offCount >= 3 && Date.now() - a.lastReroute > 15000) this.reroute(pos);
      this.announce();
    }
    this.draw(pos);
    this.render(pos);
  },

  next() {
    const a = this.active;
    return a.maneuvers.find((m) => m.at > a.along + 5 && m.type !== 1 && m.type !== 2 && m.type !== 3) || null;
  },

  distKey(d) {
    const steps = [50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 800, 900, 1000, 1500, 2000, 3000, 5000];
    let best = steps[0];
    for (const s of steps) if (Math.abs(s - d) < Math.abs(best - d)) best = s;
    return 'd' + best;
  },
  actKey(m) {
    const t = m.type;
    if ([4, 5, 6].includes(t)) return this.active && m.at < this.active.total - 50 ? 'via' : 'dest';
    if (t === 26) return m.exit >= 1 && m.exit <= 6 ? 'rb' + m.exit : 'rb';
    return { 9: 'slight_right', 10: 'right', 11: 'sharp_right', 12: 'uturn', 13: 'uturn', 14: 'sharp_left', 15: 'left', 16: 'slight_left',
      17: 'ramp', 18: 'ramp', 19: 'ramp', 20: 'exit_right', 21: 'exit_left', 22: 'straight', 23: 'keep_right', 24: 'keep_left',
      25: 'merge', 28: 'ferry' }[t] || 'straight';
  },

  announce() {
    const a = this.active, m = this.next();
    if (!m || m.type === 27) return;
    const d = m.at - a.along;
    const key = m.idx + ':' + m.at;
    const fast = (gps.speed || 0) > 18;
    const far = fast ? 1500 : 500;
    const st = a.spoken[key] || 0;
    const act = this.actKey(m);
    if (st < 1 && d <= far && d > 150) { a.spoken[key] = 1; this.say('In ' + this.speakDist(d) + ' ' + m.alert, false, [this.distKey(d), act]); }
    else if (st < 2 && d <= (fast ? 120 : 60)) {
      a.spoken[key] = 2;
      if (act === 'dest') return;
      this.say(m.verbal, false, act === 'via' ? ['via_reached'] : ['now', act]);
    }
  },

  arrive() {
    this.say('Du hast dein Ziel erreicht.', false, ['arrived']);
    toast('Ziel erreicht: ' + (this.active.target.name || ''), 4000);
    this.stop(true);
  },

  /* ---------- Anzeige ---------- */
  fmtTime(s) {
    if (!s) return '';
    const m = Math.round(s / 60);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ' h';
  },
  speakDist(d) {
    if (d >= 1000) { const km = Math.round(d / 100) / 10; return (km % 1 ? km.toLocaleString('de-DE') : km) + ' Kilometern'; }
    return (Math.round(d / 50) * 50 || 50) + ' Metern';
  },

  icon(type, exit) {
    const arrow = (deg) => `<svg viewBox="0 0 24 24" style="transform:rotate(${deg}deg)"><path d="M12 21V8M6 13l6-6 6 6"/></svg>`;
    const turn = (flip) => `<svg viewBox="0 0 24 24" style="${flip ? 'transform:scaleX(-1)' : ''}"><path d="M7 21v-7a5 5 0 0 1 5-5h7M15 5l4 4-4 4"/></svg>`;
    const uturn = '<svg viewBox="0 0 24 24"><path d="M8 21V9a5 5 0 0 1 10 0v4M14 10l4 4 4-4" transform="translate(-3 0)"/></svg>';
    const round = `<svg viewBox="0 0 24 24"><path d="M17.3 6.7A7.5 7.5 0 1 0 19.5 12"/><path d="M13.6 6.4l3.7.3.3-3.7"/>${exit ? `<text x="12" y="16.3" text-anchor="middle" font-size="11" font-weight="800" fill="#fff" stroke="none">${exit}</text>` : ''}</svg>`;
    const flag = '<svg viewBox="0 0 24 24"><path d="M6 21V4M6 4h11l-2.5 4L17 12H6"/></svg>';
    if ([4, 5, 6].includes(type)) return flag;
    if ([26, 27].includes(type)) return round;
    if ([10, 18, 20].includes(type)) return turn(false);
    if ([15, 19, 21].includes(type)) return turn(true);
    if ([9, 23].includes(type)) return arrow(40);
    if ([16, 24].includes(type)) return arrow(-40);
    if (type === 11) return arrow(120);
    if (type === 14) return arrow(-120);
    if ([12, 13].includes(type)) return uturn;
    return arrow(0);
  },

  render(pos) {
    const a = this.active;
    if (!a) return;
    const icon = $('#nb-icon'), dist = $('#nb-dist'), text = $('#nb-text');
    if (a.mode === 'line') {
      const brg = bearingDeg(pos, a.target);
      const rel = brg - (gps.heading !== null && (gps.speed || 0) > 1 ? gps.heading : map.getBearing());
      icon.innerHTML = `<svg viewBox="0 0 24 24" style="transform:rotate(${rel}deg)"><path d="M12 21V4M6 10l6-6 6 6"/></svg>`;
      dist.textContent = fmtDist(a.remaining);
      text.textContent = `Luftlinie Richtung ${compassText(brg)}` + (a.target.name ? ' · ' + a.target.name : '');
      $('#nf-rem').textContent = fmtDist(a.remaining);
      $('#nf-eta').textContent = 'Luftlinie, kein Straßenverlauf';
      return;
    }
    if (!a.joined) {
      const s = { lon: a.coords[0][0], lat: a.coords[0][1] };
      icon.innerHTML = `<svg viewBox="0 0 24 24" style="transform:rotate(${bearingDeg(pos, s) - map.getBearing()}deg)"><path d="M12 21V4M6 10l6-6 6 6"/></svg>`;
      dist.textContent = fmtDist(distance(pos, s));
      text.textContent = 'Zum Start der Route' + (a.startPt && a.startPt.name ? ': ' + a.startPt.name : '');
    } else if (a.off > 60) {
      const back = distance(pos, { lon: a.proj[0], lat: a.proj[1] });
      icon.innerHTML = `<svg viewBox="0 0 24 24" style="transform:rotate(${bearingDeg(pos, { lon: a.proj[0], lat: a.proj[1] }) - map.getBearing()}deg)"><path d="M12 21V4M6 10l6-6 6 6"/></svg>`;
      dist.textContent = fmtDist(back);
      text.textContent = a.track ? 'Abseits des Tracks · zurück zur Linie' : navigator.onLine ? 'Abseits der Route · wird neu berechnet …' : 'Abseits der Route · zurück zur Linie';
    } else {
      const m = this.next();
      icon.innerHTML = this.icon(m ? m.type : 4, m && m.exit);
      dist.textContent = fmtDist(m ? m.at - a.along : a.remaining);
      text.textContent = m ? m.text : 'Ziel: ' + (a.target.name || '');
    }
    const left = a.total ? a.time * (a.remaining / a.total) : 0;
    const eta = new Date(Date.now() + left * 1000);
    $('#nf-rem').textContent = fmtDist(a.remaining);
    $('#nf-eta').textContent = `${this.fmtTime(left)} · Ankunft ${eta.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  },

  geojson(pos) {
    const a = this.active;
    const fc = { type: 'FeatureCollection', features: [] };
    const pd = this.pending;
    if (pd) {
      pd.list.forEach((r, i) => { if (i !== pd.sel) fc.features.push({ type: 'Feature', properties: { kind: 'alt' }, geometry: { type: 'LineString', coordinates: r.coords } }); });
      fc.features.push({ type: 'Feature', properties: { kind: 'route' }, geometry: { type: 'LineString', coordinates: pd.list[pd.sel].coords } });
      fc.features.push({ type: 'Feature', properties: { kind: 'target' }, geometry: { type: 'Point', coordinates: [pd.target.lon, pd.target.lat] } });
      const r0 = pd.list[pd.sel];
      for (const v of r0.vias || []) fc.features.push({ type: 'Feature', properties: { kind: 'via' }, geometry: { type: 'Point', coordinates: [v.lon, v.lat] } });
      if (r0.startPt && !r0.startPt.gps) fc.features.push({ type: 'Feature', properties: { kind: 'start' }, geometry: { type: 'Point', coordinates: [r0.startPt.lon, r0.startPt.lat] } });
      return fc;
    }
    if (!a) return fc;
    if (a.mode === 'line') {
      const p = pos || gps.pos;
      if (p) fc.features.push({ type: 'Feature', properties: { kind: 'line' }, geometry: { type: 'LineString', coordinates: [[p.lon, p.lat], [a.target.lon, a.target.lat]] } });
    } else {
      fc.features.push({ type: 'Feature', properties: { kind: 'route' }, geometry: { type: 'LineString', coordinates: a.coords } });
      if (a.seg > 0 || a.proj) fc.features.push({ type: 'Feature', properties: { kind: 'done' }, geometry: { type: 'LineString', coordinates: [...a.coords.slice(0, a.seg + 1), a.proj || a.coords[a.seg]] } });
    }
    fc.features.push({ type: 'Feature', properties: { kind: 'target' }, geometry: { type: 'Point', coordinates: [a.target.lon, a.target.lat] } });
    for (const v of a.vias || []) fc.features.push({ type: 'Feature', properties: { kind: 'via' }, geometry: { type: 'Point', coordinates: [v.lon, v.lat] } });
    if (a.startPt && !a.startPt.gps) fc.features.push({ type: 'Feature', properties: { kind: 'start' }, geometry: { type: 'Point', coordinates: [a.startPt.lon, a.startPt.lat] } });
    return fc;
  },

  draw(pos) {
    const src = map && map.getSource && map.getSource('route');
    if (src) src.setData(this.geojson(pos));
  },

  follow() {
    const p = gps.pos;
    gps.follow = true;
    $('#btn-locate').classList.add('active');
    if (p) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 900, essential: true });
  },

  overview() {
    const a = this.active;
    if (!a) return;
    const pts = a.mode === 'route' ? a.coords : [[a.target.lon, a.target.lat], ...(gps.pos ? [[gps.pos.lon, gps.pos.lat]] : [])];
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const p of pts) b.extend(p);
    gps.follow = false;
    $('#btn-locate').classList.remove('active');
    map.fitBounds(b, { padding: { top: 140, bottom: 140, left: 60, right: 90 }, maxZoom: 15, bearing: 0, duration: 800 });
  },

  showUI(on) {
    $('#nav-banner').hidden = !on;
    $('#nav-foot').hidden = !on;
    $('#nav-banner').classList.remove('mini');
    $('#nav-foot').classList.remove('mini');
    document.body.classList.toggle('navigating', on);
    $('#nb-voice').classList.toggle('off', !this.voice);
  },

  /* Stimmen: Spaß- und Roboterstimmen von iOS aussortieren, beste deutsche Stimme zuerst */
  NOVELTY: /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Eddy|Flo|Grandma|Grandpa|Oma|Opa|Reed|Rocko|Sandy|Shelley|Fred|Junior|Kathy|Ralph)\b/i,
  voiceScore(v) {
    const n = v.name + ' ' + v.voiceURI;
    let s = 0;
    if (/premium/i.test(n)) s += 50;
    if (/enhanced|erweitert|natural|neural/i.test(n)) s += 30;
    if (/^de-DE/i.test(v.lang.replace('_', '-'))) s += 10;
    if (/^(Anna|Helena|Petra|Markus|Yannick|Viktor|Martin|Katja|Conrad|Amala)/i.test(v.name)) s += 8;
    if (v.localService) s += 2;
    return s;
  },
  voices() {
    if (!('speechSynthesis' in window)) return [];
    return speechSynthesis.getVoices()
      .filter((v) => /^de/i.test(v.lang) && !this.NOVELTY.test(v.name))
      .sort((a, b) => this.voiceScore(b) - this.voiceScore(a) || a.name.localeCompare(b.name));
  },
  pickVoice() {
    const list = this.voices();
    const want = store.get('navVoiceURI', '');
    return list.find((v) => v.voiceURI === want) || list[0] || null;
  },

  packVoice() {
    const sel = store.get('navVoiceURI', '');
    const vs = (Pack.index && Pack.index.voices) || [];
    if (sel.startsWith('pack:')) return vs.find((v) => 'pack:' + v.id === sel) ? sel.slice(5) : (vs[0] && vs[0].id) || null;
    return !sel && vs.length ? vs[0].id : null;
  },

  say(text, force, keys) {
    if ((!this.voice && !force) || !text) return;
    const pv = this.packVoice();
    if (pv && keys && keys.length) {
      Pack.play(pv, keys, store.get('navRate', 1)).catch(() => this.sayTTS(text));
      return;
    }
    this.sayTTS(text);
  },

  sayTTS(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'de-DE';
      const v = this.pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = store.get('navRate', 1);
      u.pitch = 1;
      speechSynthesis.speak(u);
    } catch (e) { /* keine Sprachausgabe */ }
  },

  setupVoiceUI() {
    const sel = $('#voice-select'), rate = $('#voice-rate');
    if (!sel) return;
    const fill = () => {
      const list = this.voices();
      const pv = this.packVoice();
      const cur = pv ? null : this.pickVoice();
      sel.innerHTML = '';
      const packs = (Pack.index && Pack.index.voices) || [];
      if (packs.length) {
        const g = document.createElement('optgroup');
        g.label = 'Mitgelieferte Stimmen (auch offline)';
        for (const v of packs) {
          const o = document.createElement('option');
          o.value = 'pack:' + v.id;
          o.textContent = `${v.name} – ${v.desc}`;
          if (pv === v.id) o.selected = true;
          g.appendChild(o);
        }
        sel.appendChild(g);
      }
      const g2 = document.createElement('optgroup');
      g2.label = 'Stimmen vom Gerät';
      sel.appendChild(g2);
      if (!list.length) { const o = document.createElement('option'); o.value = 'system'; o.textContent = 'Standardstimme'; g2.appendChild(o); return; }
      for (const v of list) {
        const o = document.createElement('option');
        o.value = v.voiceURI;
        const q = /premium/i.test(v.name + v.voiceURI) ? ' · Premium' : /enhanced|erweitert/i.test(v.name + v.voiceURI) ? ' · Erweitert' : '';
        o.textContent = v.name.replace(/\s*\((Premium|Enhanced|Erweitert)\)/i, '') + q + (/AT|CH/.test(v.lang) ? ' (' + v.lang.slice(-2) + ')' : '');
        if (cur && v.voiceURI === cur.voiceURI) o.selected = true;
        g2.appendChild(o);
      }
    };
    fill();
    Pack.load().then(() => { fill(); const pv = this.packVoice(); if (pv) Pack.preload(pv); });
    if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', fill);
    sel.onchange = () => {
      store.set('navVoiceURI', sel.value);
      const pv = this.packVoice();
      if (pv) Pack.preload(pv);
      this.say('Hallo! So klinge ich als deine Navigationsstimme.', true, ['hello']);
    };
    rate.value = store.get('navRate', 1);
    $('#voice-rate-val').textContent = Math.round(rate.value * 100) + ' %';
    rate.oninput = () => { $('#voice-rate-val').textContent = Math.round(rate.value * 100) + ' %'; };
    rate.onchange = () => { store.set('navRate', +rate.value); this.say('In 300 Metern rechts abbiegen.', true, ['d300', 'right']); };
    $('#voice-test').onclick = () => this.say('In 300 Metern rechts abbiegen.', true, ['d300', 'right']);
    const on = $('#voice-on');
    on.checked = this.voice;
    on.onchange = () => { this.voice = on.checked; store.set('navVoice', this.voice); $('#nb-voice').classList.toggle('off', !this.voice); };
  },

  setup() {
    this.setupVoiceUI();
    $('#nf-stop').onclick = () => this.stop();
    $('#nf-overview').onclick = () => this.overview();
    $('#nb-voice').onclick = () => {
      this.voice = !this.voice; store.set('navVoice', this.voice);
      $('#nb-voice').classList.toggle('off', !this.voice);
      if ($('#voice-on')) $('#voice-on').checked = this.voice;
      toast(this.voice ? 'Sprachansagen an' : 'Sprachansagen aus');
      if (this.voice) this.say('Sprachansagen an.', false, ['voice_on']);
    };
    this.restore();
  },

  /* Auswahl im Ziel-Kärtchen: Route oder Luftlinie */
  choose(target) { Planner.open([{ gps: true }, target]); },

  async saveAsTrack(r) {
    if (!r || !r.coords.length) return;
    const st = (r.stops || []).filter(Boolean);
    const label = (s) => (s.gps ? 'Mein Standort' : s.name || 'Punkt');
    const name = st.length >= 2 ? label(st[0]) + ' → ' + label(st[st.length - 1]) : 'Geplante Route';
    // bearbeitbar wie eine gezeichnete Route: Abschnitte an den Zwischenstopps trennen
    const cuts = [0, ...(r.vias || []).map((v) => v.idx), r.coords.length - 1];
    const pts = cuts.map((i) => r.coords[i]);
    const legs = [];
    for (let k = 0; k < cuts.length - 1; k++) legs.push({ mode: 'road', coords: r.coords.slice(cuts[k], cuts[k + 1] + 1) });
    const t = { id: 'trk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), name,
      color: TRACK_COLORS[tracks.length % TRACK_COLORS.length], segments: [r.coords.map((c) => [c[0], c[1]])], visible: true,
      created: Date.now(), source: 'Geplant', note: '', draw: { pts, legs }, length: r.total };
    tracks.push(t);
    await saveTrack(t);
    updateTracksSource();
    toast('Als Track gespeichert: ' + name, 3000);
  },


};
