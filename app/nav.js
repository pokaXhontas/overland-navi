/* Navigation: Route zu einem Ziel berechnen (online) oder Luftlinie (überall), mit Abbiegehinweisen und Sprachansagen.
 * Eine berechnete Route bleibt gespeichert und funktioniert danach auch ohne Netz. */
'use strict';

const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const OSRM = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';

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

  async valhalla(from, to) {
    // Spielstraßen und „Anlieger frei“ nicht künstlich meiden, sonst entstehen in Wohngebieten große Umwege
    const town = { use_living_streets: 0.6, destination_only_penalty: 120, service_penalty: 10 };
    const opts = {
      tracks: { use_tracks: 0.8, use_highways: 0.6, exclude_unpaved: false, use_ferry: 0.5, ...town },
      short: { shortest: true, use_tracks: 0, use_ferry: 0.5, ...town, use_living_streets: 1 },
      road: { use_tracks: 0, use_highways: 1, use_ferry: 0.5, ...town }
    }[this.profile] || {};
    const loc = { lat: from.lat, lon: from.lon };
    if (gps.heading !== null && gps.speed > 2) { loc.heading = Math.round(gps.heading); loc.heading_tolerance = 60; }
    const q = {
      locations: [loc, { lat: to.lat, lon: to.lon }],
      costing: 'auto', costing_options: { auto: opts },
      directions_options: { units: 'kilometers', language: 'de-DE' },
      alternates: 2
    };
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

  async osrm(from, to) {
    const r = await fetch(`${OSRM}${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true&alternatives=true`);
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

  prepare(target, res, mode) {
    const coords = res ? res.coords : [];
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distance({ lon: coords[i - 1][0], lat: coords[i - 1][1] }, { lon: coords[i][0], lat: coords[i][1] }));
    const maneuvers = res ? res.maneuvers.map((m) => ({ ...m, at: cum[Math.min(m.idx, cum.length - 1)] })) : [];
    return { target, mode, coords, cum, total: cum[cum.length - 1] || 0, maneuvers, time: res ? res.time : 0, source: res ? res.source : '',
      along: 0, seg: 0, off: 0, offCount: 0, lastReroute: Date.now(), spoken: {}, created: Date.now() };
  },

  /* Zwei unabhängige Routenrechner fragen und die Vorschläge zusammenlegen.
     Für Straßen kommen so mehr echte Alternativen zusammen; auf Pisten zählt nur Valhalla. */
  async calc(from, target) {
    const jobs = [this.valhalla(from, target)];
    if (this.profile !== 'tracks') jobs.push(this.osrm(from, target));
    const results = await Promise.allSettled(jobs);
    let list = [];
    for (const r of results) if (r.status === 'fulfilled') list.push(...r.value);
    if (!list.length && this.profile === 'tracks') { try { list = await this.osrm(from, target); } catch (e) { /* nichts */ } }
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

  async start(target, mode) {
    if (this.busy) return;
    this.busy = true;
    try {
      const from = await this.position();
      if (!from) { toast('Kein GPS-Standort. Bitte Ortung erlauben und kurz warten.', 4000); return; }
      if (mode === 'line') {
        this.active = this.prepare(target, null, 'line');
      } else {
        if (!navigator.onLine) {
          toast('Ohne Internet keine Routenberechnung. Ich zeige dir die Luftlinie.', 4500);
          this.active = this.prepare(target, null, 'line');
        } else {
          toast('Route wird berechnet …', 8000);
          try {
            const list = (await this.calc(from, target)).map((r) => this.prepare(target, r, 'route'));
            if (list.length > 1) { $('#toast').classList.remove('show'); this.pickRoute(target, list); return; }
            this.active = list[0];
            toast(`Route: ${fmtDist(this.active.total)} · ${this.fmtTime(this.active.time)}`, 3000);
          } catch (e) {
            toast('Keine Route gefunden (' + e.message + '). Ich zeige dir die Luftlinie.', 5000);
            this.active = this.prepare(target, null, 'line');
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
    };
    render();
    $('#na-go').onclick = () => {
      const p = this.pending;
      this.pending = null;
      box.hidden = true;
      this.active = p.list[p.sel];
      this.go(gps.pos);
    };
    $('#na-cancel').onclick = () => { this.pending = null; box.hidden = true; this.draw(); };
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
      this.say(this.active.mode === 'route' ? 'Route gestartet.' : 'Luftlinie zum Ziel.');
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
      const res = await this.calc(pos, a.target);
      if (this.active !== a) return;
      this.active = this.prepare(a.target, res[0], 'route');
      this.save();
      this.say('Route neu berechnet.');
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

  announce() {
    const a = this.active, m = this.next();
    if (!m) return;
    const d = m.at - a.along;
    const key = m.idx + ':' + m.at;
    const fast = (gps.speed || 0) > 18;
    const far = fast ? 1500 : 500;
    const st = a.spoken[key] || 0;
    if (st < 1 && d <= far && d > 150) { a.spoken[key] = 1; this.say('In ' + this.speakDist(d) + ' ' + m.alert); }
    else if (st < 2 && d <= (fast ? 120 : 60)) { a.spoken[key] = 2; this.say(m.verbal); }
  },

  arrive() {
    this.say('Du hast dein Ziel erreicht.');
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
    if (a.off > 60) {
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
    document.body.classList.toggle('navigating', on);
    $('#nb-voice').classList.toggle('off', !this.voice);
  },

  say(text) {
    if (!this.voice || !text || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'de-DE';
      const v = speechSynthesis.getVoices().find((x) => /^de/i.test(x.lang));
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch (e) { /* keine Sprachausgabe */ }
  },

  setup() {
    $('#nf-stop').onclick = () => this.stop();
    $('#nf-overview').onclick = () => this.overview();
    $('#nb-voice').onclick = () => {
      this.voice = !this.voice; store.set('navVoice', this.voice);
      $('#nb-voice').classList.toggle('off', !this.voice);
      toast(this.voice ? 'Sprachansagen an' : 'Sprachansagen aus');
      if (this.voice) this.say('Sprachansagen an.');
    };
    this.restore();
  },

  /* Auswahl im Ziel-Kärtchen: Route oder Luftlinie */
  choose(target) {
    const sheet = $('#nav-choose');
    $('#nc-name').textContent = target.name || 'Ziel';
    $('#nc-dist').textContent = gps.pos ? 'Luftlinie ' + fmtDist(distance(gps.pos, target)) : '';
    sheet.querySelectorAll('[data-profile]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.profile === this.profile));
      b.onclick = () => { this.profile = b.dataset.profile; store.set('navProfile2', this.profile); this.choose(target); };
    });
    $('#nc-route').onclick = () => { sheet.hidden = true; this.start(target, 'route'); };
    $('#nc-line').onclick = () => { sheet.hidden = true; this.start(target, 'line'); };
    $('#nc-cancel').onclick = () => { sheet.hidden = true; };
    sheet.hidden = false;
  }
};
