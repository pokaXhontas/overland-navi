/* Navigation: Route zu einem Ziel berechnen (online) oder Luftlinie (überall), mit Abbiegehinweisen und Sprachansagen.
 * Eine berechnete Route bleibt gespeichert und funktioniert danach auch ohne Netz. */
'use strict';

const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const TRANSIT = 'https://api.transitous.org';
const BROUTER = 'https://brouter.de/brouter';
const OSRM = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';

/* Mitgelieferte Stimmen: kurze Bausteine („In 300 Metern“ + „rechts abbiegen“), offline nutzbar.
 * iOS gibt Ton erst nach einem echten Fingertipp frei. Deshalb wird bei jedem Tipp „entsperrt“,
 * und wenn Web-Audio trotzdem stumm bleibt, spielt ein normaler Audio-Player die Ansage. */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQIAAAAAAA==';
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const Pack = {
  /* Stummschalter: „playback“ ist trotz Stummschalter hörbar (Musik pausiert kurz), „transient“ macht Musik nur leiser, schweigt aber im Stummmodus */
  session() {
    try { if (navigator.audioSession) navigator.audioSession.type = store.get('voiceSilent', true) ? 'playback' : 'transient'; } catch (e) { /* älteres iOS */ }
  },
  index: null, ctx: null, raw: new Map(), dec: new Map(), playing: [], el: null, elReady: false,
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
      try { this.ctx = new C(); } catch (e) { return null; }
    }
    return this.ctx;
  },
  /* im Fingertipp aufrufen */
  unlock() {
    this.session();
    const ctx = this.ac();
    if (ctx && ctx.state !== 'running') {
      ctx.resume().catch(() => {});
      try { const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, 22050); s.connect(ctx.destination); s.start(0); } catch (e) { /* egal */ }
    }
    if (!this.el) { this.el = new Audio(); this.el.setAttribute('playsinline', ''); this.el.preload = 'auto'; }
    if (!this.elReady) {
      this.el.src = SILENT_WAV;
      const p = this.el.play();
      if (p) p.then(() => { this.elReady = true; }).catch(() => {});
    }
  },
  async running() {
    const ctx = this.ac();
    if (!ctx) return false;
    if (ctx.state !== 'running') {
      try { await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 350))]); } catch (e) { /* bleibt stumm */ }
    }
    return ctx.state === 'running';
  },
  bytes(voice, key) {
    const k = voice + '/' + key;
    if (!this.raw.has(k)) {
      const p = fetch(`voices/${voice}/${key}.mp3`).then((r) => { if (!r.ok) throw new Error('Ansage fehlt'); return r.arrayBuffer(); });
      this.raw.set(k, p);
      p.catch(() => this.raw.delete(k));
    }
    return this.raw.get(k);
  },
  decoded(voice, key) {
    const k = voice + '/' + key;
    if (!this.dec.has(k)) {
      const p = this.bytes(voice, key).then((ab) => new Promise((res, rej) => this.ac().decodeAudioData(ab.slice(0), res, rej)));
      this.dec.set(k, p);
      p.catch(() => this.dec.delete(k));
    }
    return this.dec.get(k);
  },
  stop() {
    for (const s of this.playing) { try { s.stop(); } catch (e) { /* schon fertig */ } }
    this.playing = [];
    if (this.el) { this.el.onended = null; if (!this.el.paused) { try { this.el.pause(); } catch (e) { /* egal */ } } }
    if (this.waitEnd) { const r = this.waitEnd; this.waitEnd = null; r(); }
  },
  /* Drei Wege, nacheinander probiert: Web-Audio (lückenlos), Audio-Player mit einer zusammengesetzten MP3,
   * Audio-Player Baustein für Baustein direkt aus den Dateien (klappt auch dort, wo Blob-Adressen nicht spielen).
   * Erst wenn alle scheitern, gibt es einen Fehler (dann spricht die Gerätestimme). */
  lastError: '',
  native: !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()),
  async play(voice, keys, rate) {
    this.session();
    this.token = (this.token || 0) + 1;
    const my = this.token, errs = [];
    // älteres iOS im Browser ohne audioSession: nur der Audio-Player ist trotz Stummschalter hörbar
    const htmlFirst = IOS && !this.native && !navigator.audioSession && store.get('voiceSilent', true);
    const ways = htmlFirst ? ['blob', 'files', 'webaudio'] : ['webaudio', 'blob', 'files'];
    for (const w of ways) {
      if (my !== this.token) return;   // inzwischen kam eine neuere Ansage
      try {
        await this['via_' + w](voice, keys, rate, my);
        this.how = w; this.lastError = '';
        return;
      } catch (e) { errs.push(w + ': ' + ((e && (e.name + ' ' + e.message)) || e)); }
    }
    this.lastError = errs.join(' | ');
    throw new Error(this.lastError);
  },
  async via_webaudio(voice, keys, rate) {
    if (!await this.running()) throw new Error('Ton gesperrt (' + (this.ctx ? this.ctx.state : 'kein Web-Audio') + ')');
    const bufs = await Promise.all(keys.map((k) => this.decoded(voice, k)));
    this.stop();
    const ctx = this.ctx;
    let t = ctx.currentTime + 0.03;
    for (const b of bufs) {
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.playbackRate.value = rate;
      s.connect(ctx.destination);
      s.start(t);
      t += b.duration / rate;
      this.playing.push(s);
    }
    this.endsAt = Date.now() + (t - ctx.currentTime) * 1000;
  },
  player() {
    if (!this.el) { this.el = new Audio(); this.el.setAttribute('playsinline', ''); this.el.preload = 'auto'; }
    return this.el;
  },
  async via_blob(voice, keys, rate) {
    const parts = await Promise.all(keys.map((k) => this.bytes(voice, k)));
    const el = this.player();
    this.stop();
    if (el.dataset.url) URL.revokeObjectURL(el.dataset.url);
    const url = URL.createObjectURL(new Blob(parts, { type: 'audio/mpeg' }));
    el.dataset.url = url;
    el.src = url;
    el.playbackRate = rate;
    await this.started(el);
  },
  async via_files(voice, keys, rate, my) {
    const el = this.player();
    this.stop();
    for (let i = 0; i < keys.length; i++) {
      if (my !== this.token) return;
      el.src = new URL(`voices/${voice}/${keys[i]}.mp3`, location.href).href;
      el.playbackRate = rate;
      await this.started(el);
      if (i < keys.length - 1) await new Promise((res) => { this.waitEnd = res; el.onended = () => { el.onended = null; this.waitEnd = null; res(); }; });
    }
  },
  /* wartet, bis der Player wirklich spielt (manche Geräte lösen play() auf, ohne zu spielen) */
  started(el) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { done(); rej(new Error('spielt nicht')); }, 2500);
      const ok = () => { done(); this.endsAt = Date.now() + ((el.duration || 2) / (el.playbackRate || 1)) * 1000; res(); };
      const bad = () => { done(); rej(new Error('Datei nicht abspielbar')); };
      const done = () => { clearTimeout(t); el.removeEventListener('playing', ok); el.removeEventListener('error', bad); };
      el.addEventListener('playing', ok);
      el.addEventListener('error', bad);
      const p = el.play();
      if (p) p.catch((e) => { done(); rej(e); });
    });
  },
  preload(voice) {
    for (const k of (this.index && this.index.keys) || []) this.bytes(voice, k).catch(() => {});
    if (this.ac()) for (const k of ['d300', 'right', 'hello']) this.decoded(voice, k).catch(() => {});
  }
};
for (const ev of ['touchend', 'click', 'keydown']) document.addEventListener(ev, () => Pack.unlock(), { capture: true, passive: true });

/* Straßennetz-Dateien für das Offline-Routing (eine pro Land, im gleichen Download-Bereich wie die Wanderwege) */
const RouteData = {
  index: store.get('routeIndex', {}),   // Kennung → { size, date, ts, bbox, name }
  local: new Map(),                      // Gebiet → Set der offline gespeicherten Kennungen
  localDate: new Map(),

  keys() { return Object.keys(this.index); },
  url(key) { return Tiles.sources.hike ? Tiles.sources.hike.replace('{id}', key + '-route') : null; },
  dlUrl(key) { const u = this.url(key), m = this.index[key]; return u && m && m.date ? u + '?v=' + m.date : u; },
  async loadIndex() {
    if (!Tiles.sources.hike || !navigator.onLine) return;
    try {
      const r = await originalFetch(Tiles.sources.hike.replace('{id}', 'route-index').replace('.pmtiles', '.json'), { cache: 'no-cache' });
      if (r.ok) { this.index = await r.json(); store.set('routeIndex', this.index); }
    } catch (e) { /* alte Liste behalten */ }
  },
  keysFor(boxes) {
    return this.keys().filter((k) => {
      const b = this.index[k].bbox;
      return b && boxes.some((x) => x[0] <= b[2] && x[2] >= b[0] && x[1] <= b[3] && x[3] >= b[1]);
    });
  },
  stale(rid, key) {
    const d = this.localDate.get(rid + '/' + key), m = this.index[key];
    return !!(d && m && m.date && d < Date.parse(m.ts || m.date + 'T00:00:00Z'));
  },
  regionDone(r) {
    const ks = this.keysFor(r.boxes), have = this.local.get(r.id);
    return ks.length > 0 && !!have && ks.every((k) => have.has(k) && !this.stale(r.id, k));
  },
  regionStale(r) { const have = this.local.get(r.id); return !!have && this.keysFor(r.boxes).some((k) => have.has(k) && this.stale(r.id, k)); },
  async scan() {
    this.local.clear();
    this.localDate.clear();
    const root = await Tiles.opfs();
    if (!root || !root.keys) return;
    for await (const name of root.keys()) {
      const m = name.match(/^(.+)-rt-([a-z0-9-]+)\.idx\.ok$/);
      if (!m) continue;
      if (!this.local.has(m[1])) this.local.set(m[1], new Set());
      this.local.get(m[1]).add(m[2]);
      try { this.localDate.set(m[1] + '/' + m[2], (await (await root.getFileHandle(`${m[1]}-rt-${m[2]}.dat`)).getFile()).lastModified); } catch (e) { /* ohne Datum */ }
    }
  },
  /* Dateien für eine Route: zuerst die offline gespeicherten, mit Internet auch die Länderdateien selbst */
  sources(pts, online) {
    const out = [];
    const lo = Math.min(...pts.map((p) => p.lon)), hi = Math.max(...pts.map((p) => p.lon));
    const la = Math.min(...pts.map((p) => p.lat)), ha = Math.max(...pts.map((p) => p.lat));
    for (const r of Tiles.regions) {
      const have = this.local.get(r.id);
      if (!have) continue;
      for (const key of have) {
        const b = (this.index[key] && this.index[key].bbox) || null;
        out.push({ local: `${r.id}-rt-${key}`, bbox: b });
      }
    }
    if (online) {
      for (const key of this.keys()) {
        const b = this.index[key].bbox;
        if (!b || b[0] > hi + 1 || b[2] < lo - 1 || b[1] > ha + 1 || b[3] < la - 1) continue;
        if (out.some((o) => o.local && o.local.endsWith('-rt-' + key))) continue;
        out.push({ url: this.url(key), bbox: b });
      }
    }
    return out;
  }
};

const Nav = {
  active: null,
  profile: store.get('navProfile2', 'road'),
  travel: store.get('navTravel', 'car'),     // car | foot | transit
  when: { mode: 'now', at: '' },              // Bus & Bahn: jetzt | dep (Abfahrt um) | arr (Ankunft um)
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

  async valhalla(pts, variant, split) {
    // Spielstraßen und „Anlieger frei“ nicht künstlich meiden, sonst entstehen in Wohngebieten große Umwege
    const town = { use_living_streets: 0.6, destination_only_penalty: 120, service_penalty: 10 };
    const opts = {
      tracks: { use_tracks: 0.8, use_highways: 0.6, exclude_unpaved: false, use_ferry: 0.5, ...town },
      short: { shortest: true, use_tracks: 0, use_ferry: 0.5, ...town, use_living_streets: 1 },
      road: { use_tracks: 0, use_highways: 1, use_ferry: 0.5, ...town }
    }[this.profile] || {};
    if (variant) Object.assign(opts, variant);
    // Fähren-Stopp: Punkt auf See, die Route fährt nur hindurch (kein Halt, kein Wenden)
    const locs = pts.map((p) => ({ lat: p.lat, lon: p.lon, type: p.ferry ? 'through' : 'break' }));
    if (pts[0].gps && gps.heading !== null && gps.speed > 2) { locs[0].heading = Math.round(gps.heading); locs[0].heading_tolerance = 60; }
    const q = {
      locations: locs,
      costing: 'auto', costing_options: { auto: opts },
      directions_options: { units: 'kilometers', language: 'de-DE' }
    };
    if (pts.length === 2 && !variant && !split) q.alternates = 2;
    const r = await fetch(VALHALLA + '?json=' + encodeURIComponent(JSON.stringify(q)));
    const j = await r.json();
    // sehr lange Routen mit Zwischenstopps: der Server erlaubt nur 1.500 km am Stück, dann Abschnitt für Abschnitt rechnen
    if (!j.trip && j.error_code === 154 && pts.length > 2) return [await this.valhallaSplit(pts, variant)];
    if (!r.ok || !j.trip) throw new Error((j && (j.error || j.status_message)) || 'Keine Route gefunden');
    return [j.trip, ...(j.alternates || []).map((a) => a.trip)].filter(Boolean).map((t) => this.parseTrip(t));
  },

  /* Zu Fuß / Wandern: zuerst BRouter (Wander-Profil, folgt markierten Wanderrouten),
     dazu Valhalla als Fußgänger mit der eingestellten SAC-Stufe */
  async foot(pts) {
    const jobs = [this.brouterFoot(pts), this.valhallaFoot(pts)];
    const res = await Promise.allSettled(jobs);
    const list = [];
    for (const r of res) if (r.status === 'fulfilled') list.push(...r.value);
    if (!list.length) throw (res.find((r) => r.status === 'rejected') || {}).reason || new Error('Kein Weg gefunden');
    for (const x of list) x.len = x.len || trackLength(x.coords);
    // doppelte Vorschläge (fast gleich lang) weglassen, Wanderrouten-Vorschlag zuerst
    const uniq = [];
    for (const r of list) if (!uniq.some((u) => Math.abs(u.len - r.len) < Math.max(80, u.len * 0.03))) uniq.push(r);
    return uniq.slice(0, 4);
  },

  async valhallaFoot(pts) {
    const locs = pts.map((p) => ({ lat: p.lat, lon: p.lon, type: 'break' }));
    const max = typeof Hike !== 'undefined' ? Hike.max() : 3;
    const q = { locations: locs, costing: 'pedestrian',
      costing_options: { pedestrian: { max_hiking_difficulty: max, use_tracks: 1, walking_speed: 4.5, use_hills: 0.5 } },
      directions_options: { units: 'kilometers', language: 'de-DE' } };
    if (pts.length === 2) q.alternates = 1;
    const r = await fetch(VALHALLA + '?json=' + encodeURIComponent(JSON.stringify(q)));
    const j = await r.json();
    if (!r.ok || !j.trip) throw new Error((j && (j.error || j.status_message)) || 'Kein Weg gefunden');
    return [j.trip, ...(j.alternates || []).map((a) => a.trip)].filter(Boolean).map((t) => ({ ...this.parseTrip(t), travel: 'foot', source: 'Valhalla' }));
  },

  async brouterFoot(pts) {
    const ll = pts.map((p) => p.lon.toFixed(6) + ',' + p.lat.toFixed(6)).join('|');
    const r = await fetch(`${BROUTER}?lonlats=${ll}&profile=hiking-mountain&alternativeidx=0&format=geojson&timode=3`);
    if (!r.ok) throw new Error('BRouter: ' + (await r.text()).slice(0, 120));
    const j = await r.json();
    const f = j.features && j.features[0];
    if (!f) throw new Error('BRouter: kein Weg');
    const p = f.properties;
    const coords = f.geometry.coordinates.map((c) => [c[0], c[1]]);
    // Anteil auf markierten Wanderrouten und an größeren Straßen, schwierigste Stelle
    const msgs = p.messages || [];
    const hdr = msgs[0] || [];
    const wi = hdr.indexOf('WayTags'), di = hdr.indexOf('Distance');
    let tot = 0, route = 0, road = 0, sac = 0;
    const SACN = { hiking: 1, mountain_hiking: 2, demanding_mountain_hiking: 3, alpine_hiking: 4, demanding_alpine_hiking: 5, difficult_alpine_hiking: 6 };
    for (const m of msgs.slice(1)) {
      const d = +m[di] || 0, tags = m[wi] || '';
      tot += d;
      if (/route_(hiking|foot)_/.test(tags)) route += d;
      if (/highway=(primary|secondary|tertiary|trunk)(_link)?\b/.test(tags)) road += d;
      const sm = tags.match(/sac_scale=(\w+)/);
      if (sm && SACN[sm[1]]) sac = Math.max(sac, SACN[sm[1]]);
    }
    // Abbiegehinweise: [Punkt, Befehl, Ausfahrt, Abstand, Winkel]
    const CMD = { 2: 15, 3: 16, 4: 14, 5: 10, 6: 9, 7: 11, 8: 24, 9: 23, 10: 13, 11: 13, 12: 13, 14: 26, 15: 26 };
    const TXT = { 15: 'Links abbiegen', 16: 'Halb links', 14: 'Scharf links', 10: 'Rechts abbiegen', 9: 'Halb rechts', 11: 'Scharf rechts', 24: 'Links halten', 23: 'Rechts halten', 13: 'Umdrehen', 26: 'Im Kreisverkehr' };
    const man = [{ idx: 0, type: 1, text: 'Loslaufen', alert: 'Loslaufen', verbal: 'Loslaufen', street: '' }];
    for (const v of p.voicehints || []) {
      const t = CMD[v[1]];
      if (!t) continue;
      const text = t === 26 ? `Im Kreisverkehr die ${v[2] || ''}. Ausfahrt nehmen` : TXT[t];
      man.push({ idx: v[0], type: t, text, alert: text, verbal: text, street: '', exit: v[2] || 0 });
    }
    man.push({ idx: coords.length - 1, type: 4, text: 'Ziel erreicht', alert: 'erreichst du dein Ziel', verbal: 'Du hast dein Ziel erreicht.', street: '' });
    const walk = { routePct: tot ? Math.round(100 * route / tot) : 0, roadPct: tot ? Math.round(100 * road / tot) : 0, sac };
    return [{ coords, maneuvers: man, time: +p['total-time'] || tot / 1.2, source: 'BRouter', travel: 'foot', len: +p['track-length'] || tot, walk, up: +p['filtered ascend'] || 0 }];
  },

  /* Bus & Bahn: Verbindungen von Transitous (freie Fahrplandaten, MOTIS) */
  async transit(pts) {
    if (pts.length > 2) toast('Bei Bus & Bahn zählen nur Start und Ziel, Zwischenstopps werden übergangen.', 4000);
    const a = pts[0], b = pts[pts.length - 1];
    let when = '';
    if (this.when.mode !== 'now' && this.when.at) {
      const t = new Date(this.when.at);   // Eingabe ist Ortszeit des Geräts
      if (!isNaN(t)) when = `&time=${encodeURIComponent(t.toISOString())}${this.when.mode === 'arr' ? '&arriveBy=true' : ''}`;
    }
    const url = `${TRANSIT}/api/v5/plan?fromPlace=${a.lat.toFixed(6)},${a.lon.toFixed(6)}&toPlace=${b.lat.toFixed(6)},${b.lon.toFixed(6)}&numItineraries=5&language=de${when}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('Fahrplanauskunft nicht erreichbar (' + r.status + ')');
    const j = await r.json();
    const its = (j.itineraries || []).filter((it) => it.legs.some((l) => l.mode !== 'WALK'));
    if (j.direct && j.direct.length && !its.length) throw new Error('keine Verbindung mit Bus oder Bahn, besser zu Fuß');
    if (!its.length) throw new Error('keine Verbindung gefunden');
    return its.slice(0, 5).map((it) => this.parseItinerary(it));
  },

  parseItinerary(it) {
    const coords = [], man = [];
    const clock = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const modeName = { BUS: 'Bus', COACH: 'Fernbus', TRAM: 'Straßenbahn', SUBWAY: 'U-Bahn', SUBURBAN: 'S-Bahn', RAIL: 'Zug', REGIONAL_RAIL: 'Regionalzug', REGIONAL_FAST_RAIL: 'Regionalexpress',
      HIGHSPEED_RAIL: 'Fernzug', LONG_DISTANCE: 'Fernzug', NIGHT_RAIL: 'Nachtzug', FERRY: 'Fähre', AERIAL_LIFT: 'Seilbahn', FUNICULAR: 'Standseilbahn', METRO: 'S-Bahn', ODM: 'Rufbus' };
    const dirType = { LEFT: 15, RIGHT: 10, SLIGHTLY_LEFT: 16, SLIGHTLY_RIGHT: 9, HARD_LEFT: 14, HARD_RIGHT: 11, UTURN_LEFT: 13, UTURN_RIGHT: 13, CIRCLE_CLOCKWISE: 26, CIRCLE_COUNTERCLOCKWISE: 26 };
    const dirText = { 15: 'Links abbiegen', 10: 'Rechts abbiegen', 16: 'Halb links', 9: 'Halb rechts', 14: 'Scharf links', 11: 'Scharf rechts', 13: 'Umdrehen', 26: 'In den Kreisverkehr' };
    const legs = [];
    for (const leg of it.legs) {
      const pts = leg.legGeometry ? this.decode6(leg.legGeometry.points) : [[leg.from.lon, leg.from.lat], [leg.to.lon, leg.to.lat]];
      const off = coords.length ? coords.length - 1 : 0;
      coords.push(...(coords.length ? pts.slice(1) : pts));
      if (leg.mode === 'WALK') {
        const to = leg.to.name === 'END' ? 'zum Ziel' : 'zu ' + leg.to.name;
        man.push({ idx: off, type: 8, text: 'Zu Fuß ' + to, alert: 'Zu Fuß ' + to, verbal: 'Zu Fuß ' + to, street: '', tts: true });
        let from = off;
        for (const st of leg.steps || []) {
          const t = dirType[st.relativeDirection];
          const p0 = st.polyline ? this.decode6(st.polyline.points)[0] : null;
          if (!t || !p0) continue;
          let best = from, bd = Infinity;
          for (let i = from; i < coords.length; i++) { const d = Math.abs(coords[i][0] - p0[0]) + Math.abs(coords[i][1] - p0[1]); if (d < bd) { bd = d; best = i; } }
          from = best;
          const text = dirText[t] + (st.streetName ? ' auf ' + st.streetName : '');
          man.push({ idx: best, type: t, text, alert: text, verbal: text, street: st.streetName || '' });
        }
      } else {
        const line = leg.routeShortName || leg.displayName || '';
        const what = (modeName[leg.mode] || 'Linie') + (line ? ' ' + line : '');
        const color = leg.routeColor ? '#' + leg.routeColor : null;
        legs.push({ mode: leg.mode, what, line, color, headsign: leg.headsign || '', from: leg.from.name, to: leg.to.name, dep: clock(leg.startTime), arr: clock(leg.endTime) });
        const board = `Einsteigen: ${what}${leg.headsign ? ' Richtung ' + leg.headsign : ''}, ab ${clock(leg.startTime)} an ${leg.from.name}`;
        man.push({ idx: off, type: 40, text: board, alert: board, verbal: `Steig hier in ${what}${leg.headsign ? ' Richtung ' + leg.headsign : ''} ein.`, street: '', tts: true });
        const end = off + pts.length - 1;
        man.push({ idx: end, type: 41, text: `Aussteigen: ${leg.to.name} (an ${clock(leg.endTime)})`, alert: `an ${leg.to.name} aussteigen`, verbal: `Hier aussteigen: ${leg.to.name}.`, street: '', tts: true });
      }
    }
    man.push({ idx: coords.length - 1, type: 4, text: 'Ziel erreicht', alert: 'erreichst du dein Ziel', verbal: 'Du hast dein Ziel erreicht.', street: '' });
    return { coords, maneuvers: man, time: it.duration, source: 'Transitous', travel: 'transit', len: trackLength(coords),
      transit: { dep: clock(it.startTime), arr: clock(it.endTime), transfers: it.transfers || 0, legs } };
  },

  /* Route in Abschnitten (je zwei Punkte) rechnen und zusammensetzen */
  async valhallaSplit(pts, variant) {
    const legs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = { lat: pts[i].lat, lon: pts[i].lon }, b = { lat: pts[i + 1].lat, lon: pts[i + 1].lon };
      if (i === 0 && pts[0].gps) a.gps = true;
      legs.push(this.valhalla([a, b], variant, true).then((l) => l[0]));
    }
    const parts = await Promise.all(legs);
    const out = { coords: [], maneuvers: [], time: 0, source: 'Valhalla', ferries: [], tolls: [] };
    parts.forEach((p, k) => {
      const off = out.coords.length ? out.coords.length - 1 : 0;
      out.coords.push(...(out.coords.length ? p.coords.slice(1) : p.coords));
      const last = k === parts.length - 1;
      const viaFerry = !last && pts[k + 1].ferry;
      for (const m of p.maneuvers) {
        if (k > 0 && [1, 2, 3].includes(m.type)) continue;                 // „Losfahren“ mitten auf der Strecke weglassen
        if (!last && [4, 5, 6].includes(m.type) && viaFerry) continue;      // auf der Fähre gibt es kein „Ziel erreicht“
        out.maneuvers.push({ ...m, idx: m.idx + off, ...(!last && [4, 5, 6].includes(m.type) ? { type: 5 } : {}) });
      }
      for (const f of p.ferries || []) out.ferries.push({ ...f, idx: f.idx + off, endIdx: (f.endIdx || f.idx) + off });
      // zweite Hälfte der Überfahrt (vom Punkt auf See bis zum Hafen) der Fähre zurechnen
      if (k > 0 && pts[k].ferry && out.ferries.length && p.maneuvers[0]) {
        const f = out.ferries[out.ferries.length - 1];
        f.km += p.maneuvers[0].km || 0; f.time += p.maneuvers[0].sec || 0;
      }
      for (const t of p.tolls || []) out.tolls.push({ ...t, idx: t.idx + off });
      out.time += p.time;
    });
    out.ferries = this.mergeFerries(out.ferries.map((f) => ({ idx: f.idx, name: f.name, km: f.km, time: f.time })));
    return out;
  },

  /* Fährverbindung als Zwischenstopp: ein Punkt auf halber Strecke der Fährlinie */
  async ferryStop(r) {
    let pt = { lat: r.lat, lon: r.lon };
    let name = r.name;
    try {
      let ref = r.osmRef;
      if (r.terminal) {
        // Anleger „Rostock - Trelleborg“: die zugehörige Fährlinie suchen
        const j = await (await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(r.name)}&limit=5&osm_tag=route:ferry&osm_tag=railway:ferry`)).json();
        const f = (j.features || [])[0];
        if (f) { ref = (f.properties.osm_type || 'W') + f.properties.osm_id; pt = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }; }
      }
      if (ref && /^W/.test(ref)) {
        const x = (await (await fetch(`https://nominatim.openstreetmap.org/lookup?osm_ids=${ref}&polygon_geojson=1&format=jsonv2`)).json())[0];
        const g = x && x.geojson;
        const lines = g ? (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []) : [];
        const line = lines.sort((a, b) => b.length - a.length)[0];
        if (line && line.length > 1) {
          // Punkt in der Mitte der Linie (nach Länge)
          const L = trackLength(line);
          let acc = 0;
          for (let i = 1; i < line.length; i++) {
            const d = distance({ lon: line[i - 1][0], lat: line[i - 1][1] }, { lon: line[i][0], lat: line[i][1] });
            if (acc + d >= L / 2) { const t = (L / 2 - acc) / d; pt = { lon: line[i - 1][0] + t * (line[i][0] - line[i - 1][0]), lat: line[i - 1][1] + t * (line[i][1] - line[i - 1][1]) }; break; }
            acc += d;
          }
        }
      }
    } catch (e) { /* mit dem Punkt aus der Suche */ }
    return { name: /fähre/i.test(name) ? name : 'Fähre ' + name, lat: +pt.lat.toFixed(6), lon: +pt.lon.toFixed(6), ferry: true };
  },

  parseTrip(trip) {
    const coords = [], man = [], ferries = [], tolls = [];
    for (const leg of trip.legs) {
      const off = coords.length ? coords.length - 1 : 0;
      const pts = this.decode6(leg.shape);
      coords.push(...(coords.length ? pts.slice(1) : pts));
      for (const m of leg.maneuvers) {
        const name = (m.street_names || [])[0] || '';
        if (m.travel_type === 'ferry' || m.type === 28) {
          if (m.travel_type === 'ferry' || !ferries.some((f) => f.idx === off + m.begin_shape_index))
            ferries.push({ idx: off + m.begin_shape_index, name, km: m.length || 0, time: m.time || 0 });
        }
        if (m.toll) tolls.push({ idx: off + m.begin_shape_index, name, km: m.length || 0 });
        man.push({ idx: off + m.begin_shape_index, type: m.type, text: m.instruction, km: m.length || 0, sec: m.time || 0,
          alert: m.verbal_transition_alert_instruction || m.verbal_pre_transition_instruction || m.instruction, exit: m.roundabout_exit_count || 0,
          verbal: m.verbal_pre_transition_instruction || m.instruction, street: (m.street_names || [])[0] || '' });
      }
    }
    return { coords, maneuvers: man, time: trip.summary.time, source: 'Valhalla', ferries: this.mergeFerries(ferries), tolls };
  },

  /* aufeinanderfolgende Fähr-Abschnitte zu einer Überfahrt zusammenfassen */
  mergeFerries(list) {
    const out = [];
    for (const f of list) {
      const last = out[out.length - 1];
      if (last && (f.idx - last.endIdx <= 2 || (f.name && f.name === last.name))) { last.km += f.km; last.time += f.time; last.endIdx = f.idx; if (!last.name) last.name = f.name; }
      else out.push({ ...f, endIdx: f.idx });
    }
    return out.filter((f) => f.km > 0.3 || f.time > 120);
  },

  osrmText(s) {
    const mod = { left: 'links', right: 'rechts', 'slight left': 'halb links', 'slight right': 'halb rechts', 'sharp left': 'scharf links', 'sharp right': 'scharf rechts', straight: 'geradeaus', uturn: 'wenden' }[s.maneuver.modifier] || '';
    const on = s.name ? ' auf ' + s.name : '';
    switch (s.maneuver.type) {
      case 'depart': return 'Losfahren' + on;
      case 'arrive': return 'Ziel erreicht';
      case 'roundabout': case 'rotary': return `Im Kreisverkehr die ${s.maneuver.exit || ''}. Ausfahrt nehmen${on}`;
      case 'continue': case 'new name': return (mod && mod !== 'geradeaus' ? mod.charAt(0).toUpperCase() + mod.slice(1) + ' halten' : 'Weiter') + on;
      default: return mod === 'wenden' ? 'Wenden' : (mod === 'geradeaus' ? 'Geradeaus weiter' : mod ? mod.charAt(0).toUpperCase() + mod.slice(1) + ' abbiegen' : 'Weiter') + on;
    }
  },

  async osrm(pts) {
    const r = await fetch(`${OSRM}${pts.map((p) => p.lon + ',' + p.lat).join(';')}?overview=full&geometries=geojson&steps=true&alternatives=${pts.length === 2}`);
    const j = await r.json();
    if (!r.ok || !j.routes || !j.routes.length) throw new Error('Keine Route gefunden');
    return j.routes.slice(0, 3).map((route) => this.parseOsrm(route));
  },

  parseOsrm(route) {
    const coords = route.geometry.coordinates, man = [], ferries = [], tolls = [];
    let idx = 0;
    // OSRM misst den Knick nur am allerersten Stück nach der Kreuzung; bei getrennten Fahrbahnen und kurzen
    // Verbindungsstücken (in Städten häufig) kommt so „geradeaus“ statt „links“ heraus. Darum den Knick
    // selbst an der Linie messen: etwa 25 m vor und nach dem Punkt.
    const pt = (c) => ({ lon: c[0], lat: c[1] });
    const walk = (i, m, dir) => {
      let d = 0, k = i;
      while (k + dir >= 0 && k + dir < coords.length && d < m) { d += distance(pt(coords[k]), pt(coords[k + dir])); k += dir; }
      return k;
    };
    const angleAt = (i) => {
      const a = walk(i, 25, -1), b = walk(i, 25, 1);
      if (a === i || b === i) return null;
      let x = bearingDeg(pt(coords[i]), pt(coords[b])) - bearingDeg(pt(coords[a]), pt(coords[i]));
      while (x > 180) x -= 360;
      while (x <= -180) x += 360;
      return x;
    };
    const MOD = { straight: 0, 'slight right': 30, right: 90, 'sharp right': 150, uturn: 180, 'sharp left': -150, left: -90, 'slight left': -30 };
    const TXT = { 9: 'Leicht rechts abbiegen', 10: 'Rechts abbiegen', 11: 'Scharf rechts abbiegen', 12: 'Wenden', 13: 'Wenden', 14: 'Scharf links abbiegen',
      15: 'Links abbiegen', 16: 'Leicht links abbiegen', 17: 'Auffahrt nehmen', 18: 'Auffahrt rechts nehmen', 19: 'Auffahrt links nehmen',
      20: 'Ausfahrt rechts nehmen', 21: 'Ausfahrt links nehmen', 23: 'Rechts halten', 24: 'Links halten', 25: 'Auffahren', 27: 'Kreisverkehr verlassen' };
    const turnType = (a) => { const x = Math.abs(a); return x >= 170 ? 13 : x >= 135 ? (a > 0 ? 11 : 14) : x >= 45 ? (a > 0 ? 10 : 15) : x >= 20 ? (a > 0 ? 9 : 16) : 0; };
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
        const ferry = s.mode === 'ferry';
        if (ferry) ferries.push({ idx, name: s.name || '', km: s.distance / 1000, time: s.duration });
        if ((s.intersections || []).some((x) => (x.classes || []).includes('toll'))) tolls.push({ idx, name: s.name || s.ref || '', km: s.distance / 1000 });
        const t = s.maneuver.type;
        let ang = angleAt(idx);
        if (ang === null) ang = MOD[s.maneuver.modifier || 'straight'] || 0;
        let type;
        if (ferry) type = 28;
        else if (t === 'depart') type = 1;
        else if (t === 'arrive') type = 4;
        else if (t === 'roundabout' || t === 'rotary') type = 26;
        else if (t === 'exit roundabout' || t === 'exit rotary') type = 27;
        else if (t === 'off ramp') type = ang >= 0 ? 20 : 21;
        else if (t === 'on ramp') type = Math.abs(ang) < 15 ? 17 : ang > 0 ? 18 : 19;
        else if (t === 'merge') type = 25;
        else if (t === 'fork') type = ang >= 0 ? 23 : 24;
        else if (t === 'end of road') type = ang >= 0 ? 10 : 15;
        else type = turnType(ang);
        if (!type) continue;                 // es geht einfach geradeaus weiter: kein Hinweis
        const on = s.name ? ' auf ' + s.name : '';
        const text = ferry ? 'Fähre nehmen' + (s.name ? ': ' + s.name : '') : TXT[type] ? TXT[type] + on : this.osrmText(s);
        // Fahrspuren vor der Kreuzung (aus OpenStreetMap, wenn eingetragen)
        const ix = s.intersections && s.intersections[0];
        const lanes = ix && ix.lanes && ix.lanes.length > 1 ? ix.lanes.map((l) => ({ ind: l.indications || ['none'], ok: !!l.valid })) : null;
        man.push({ idx, type, text, alert: text, verbal: text, street: s.name || '', exit: s.maneuver.exit || 0, lanes });
      }
    }
    return { coords, maneuvers: man, time: route.duration, source: 'OSRM', ferries: this.mergeFerries(ferries), tolls };
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
    const at = (i) => cum[Math.min(i, cum.length - 1)] || 0;
    const ferries = res && res.ferries ? res.ferries.map((f) => ({ ...f, at: at(f.idx) })) : [];
    // Maut-Abschnitte zusammenfassen (nah beieinander = ein Abschnitt)
    const tolls = [];
    for (const t of (res && res.tolls) || []) {
      const last = tolls[tolls.length - 1];
      const a0 = at(t.idx);
      if (last && a0 - last.end < 3000) { last.end = a0 + t.km * 1000; if (t.name && !last.names.includes(t.name)) last.names.push(t.name); }
      else tolls.push({ at: a0, end: a0 + t.km * 1000, names: t.name ? [t.name] : [] });
    }
    return { target, mode, coords, cum, total: cum[cum.length - 1] || 0, maneuvers, time: res ? res.time : 0, source: res ? res.source : '', ferries, tolls,
      travel: (res && res.travel) || (mode === 'route' && res && res.source !== 'Track' ? this.travel : 'car'), transit: res ? res.transit || null : null,
      walk: res ? res.walk || null : null, up: res ? res.up || 0 : 0,
      vias, stops: extra.stops || null, joined: extra.joined !== false, startPt: extra.startPt || null,
      along: 0, seg: 0, off: 0, offCount: 0, lastReroute: Date.now(), spoken: {}, created: Date.now() };
  },

  /* ---------- Offline-Routing (auf dem Gerät, aus dem gespeicherten Straßennetz) ---------- */
  routerCall(msg) {
    if (!this.router) {
      this.router = new Worker('router-worker.js');
      this.routerJobs = new Map();
      this.router.onmessage = (e) => {
        const job = this.routerJobs.get(e.data.id);
        if (!job) return;
        this.routerJobs.delete(e.data.id);
        clearTimeout(job.timer);
        if (e.data.ok) job.resolve(e.data.route); else job.reject(new Error(e.data.error));
      };
      this.router.onerror = (e) => {
        for (const j of this.routerJobs.values()) { clearTimeout(j.timer); j.reject(new Error('Routenrechner abgestürzt (zu wenig Arbeitsspeicher?)')); }
        this.routerJobs.clear();
        this.router.terminate(); this.router = null;
      };
    }
    const id = (this.routerSeq = (this.routerSeq || 0) + 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.routerJobs.delete(id); reject(new Error('Berechnung dauert zu lange')); if (this.router) { this.router.terminate(); this.router = null; } }, 120000);
      this.routerJobs.set(id, { resolve, reject, timer });
      this.router.postMessage({ ...msg, id, access: Access.msg() });
    });
  },
  async offline(pts, online) {
    if (this.travel === 'transit') throw new Error('Bus & Bahn geht nur mit Internet');
    const sources = RouteData.sources(pts, online);
    if (!sources.length) throw new Error('Für dieses Gebiet ist kein Straßennetz offline gespeichert (Menü → Offline-Karten → „Offline-Routen laden“)');
    const r = await this.routerCall({
      pts: pts.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name || '' })),
      travel: this.travel === 'foot' ? 'foot' : 'car', profile: this.profile,
      sac: typeof Hike !== 'undefined' ? Hike.max() : 3, sources
    });
    return [r];
  },
  /* online die Server, ohne Netz (oder wenn die Server nicht antworten) der eigene Rechner */
  async calcAny(pts) {
    if (!navigator.onLine) return this.offline(pts, false);
    try { return await this.calc(pts); } catch (e) {
      if (this.travel === 'transit' || !RouteData.keys().length) throw e;
      try { return await this.offline(pts, true); } catch (e2) { throw e; }
    }
  },

  /* Zwei unabhängige Routenrechner fragen und die Vorschläge zusammenlegen.
     Für Straßen kommen so mehr echte Alternativen zusammen; auf Pisten zählt nur Valhalla. */
  async calc(pts) {
    if (this.travel === 'foot') return this.foot(pts);
    if (this.travel === 'transit') return this.transit(pts);
    const jobs = [this.valhalla(pts)];
    // mit gewählter Fähre nur Valhalla: OSRM fängt den Punkt auf See nicht zuverlässig auf der Fähre ein
    const ferryVia = pts.some((p) => p.ferry);
    if (this.profile !== 'tracks' && !ferryVia) jobs.push(this.osrm(pts));
    // lange Strecken: auch eine Fähren-Variante und eine ohne Maut rechnen lassen (wie bei Google Maps)
    const far = distance(pts[0], pts[pts.length - 1]) > 80000;
    if (far && this.profile !== 'tracks') {
      jobs.push(this.valhalla(pts, { use_ferry: 1 }));
      jobs.push(this.valhalla(pts, { use_tolls: 0 }));
    }
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
      // gleiche Strecke von beiden Rechnern: nur einmal, und zwar die zuerst gerechnete (Valhalla, genauere Abbiegehinweise)
      if (!uniq.some((u) => Math.abs(u.len - r.len) < Math.max(80, u.len * 0.02) && (u.source !== r.source || Math.abs(u.time - r.time) < 90))) uniq.push(r);
    }
    uniq.sort(this.profile === 'short' ? (a, b) => a.len - b.len : (a, b) => a.time - b.time);
    const top = uniq.slice(0, 4);
    // eine Route mit Fähre und eine ohne Maut sollen dabei sein, wenn es sie gibt (und sie nicht absurd länger dauern)
    const keep = (want) => {
      if (top.some(want)) return;
      const x = uniq.find((r) => want(r) && r.time < top[0].time * 1.8 + 3600);
      if (x) top.splice(Math.min(top.length, 3), 1, x);
    };
    if (far) {
      keep((r) => r.ferries && r.ferries.length);
      if (top.some((r) => r.tolls && r.tolls.length)) keep((r) => !(r.tolls && r.tolls.length));
    }
    return top;
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
        if (!navigator.onLine && this.travel === 'transit') {
          toast('Bus & Bahn geht nur mit Internet. Ich zeige dir die Luftlinie.', 4500);
          this.active = this.prepare(target, null, 'line', extra);
        } else {
          toast(navigator.onLine ? 'Route wird berechnet …' : 'Ohne Internet: Route wird auf dem Gerät berechnet …', 30000);
          try {
            const list = (await this.calcAny(pts)).map((r) => this.prepare(target, r, 'route', extra));
            $('#toast').classList.remove('show');
            this.pickRoute(target, list);
            return;
            this.active = list[0];
            toast(`Route: ${fmtDist(this.active.total)} · ${this.fmtTime(this.active.time)}`, 3000);
          } catch (e) {
            toast((navigator.onLine ? 'Keine Route gefunden (' : 'Offline keine Route (') + e.message + '). Ich zeige dir die Luftlinie.', 6000);
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
        const info = [];
        for (const f of r.ferries || []) info.push(`<span class="na-tag ferry">⛴ Fähre${f.name ? ' ' + this.esc(f.name) : ''}${f.time ? ' · ' + this.fmtTime(f.time) : ''}</span>`);
        if (r.tolls && r.tolls.length) {
          const names = [...new Set(r.tolls.flatMap((t) => t.names))].slice(0, 2).join(', ');
          info.push(`<span class="na-tag toll">€ Maut${names ? ': ' + this.esc(names) : ''}</span>`);
        } else if (r.source === 'Valhalla' && r.travel !== 'foot' && list.some((x) => x.tolls && x.tolls.length)) info.push('<span class="na-tag free">ohne Maut</span>');
        if (r.walk) {
          if (r.walk.routePct >= 20) info.push(`<span class="na-tag free">🥾 ${r.walk.routePct} % auf markierten Wanderwegen</span>`);
          else info.push('<span class="na-tag toll">⚠ kaum markierte Wanderwege</span>');
          if (r.walk.roadPct >= 15) info.push(`<span class="na-tag toll">${r.walk.roadPct} % an Straßen</span>`);
          if (r.walk.sac) info.push(`<span class="na-tag">bis ${SAC_INFO[r.walk.sac].t}</span>`);
          if (r.up) info.push(`<span class="na-tag">↗ ${r.up.toLocaleString('de-DE')} Hm</span>`);
        } else if (r.travel === 'foot') info.push('<span class="na-tag">beliebige Fußwege und Straßen</span>');
        if (r.source === 'Offline') info.push('<span class="na-tag">📴 auf dem Gerät berechnet</span>');
        // OSRM erkennt Maut auf langen Brücken nicht zuverlässig: dann lieber nichts behaupten
        if (r.transit) {
          const t = r.transit;
          const chips = t.legs.map((l) => `<span class="na-line" style="${l.color ? `background:${l.color};color:#fff` : ''}">${this.esc(l.line || l.what)}</span>`).join('<span class="na-arrow">›</span>');
          b.innerHTML = `<span class="na-main"><b>${t.dep} – ${t.arr}</b><span>${this.fmtTime(r.time)} · ${t.transfers ? t.transfers + '× umsteigen' : 'ohne Umsteigen'}</span></span><span class="na-info">${chips}</span><span class="na-legs">${t.legs.map((l) => `${l.dep} ${this.esc(l.what)} ab ${this.esc(l.from)} → ${this.esc(l.to)}`).join('<br>')}</span>`;
        } else
        b.innerHTML = `<span class="na-main"><b>${this.fmtTime(r.time)}</b><span>${fmtDist(r.total)}${extra}</span></span>${info.length ? `<span class="na-info">${info.join('')}</span>` : ''}`;
        b.onclick = () => { this.pending.sel = i; render(); this.draw(); };
        rows.appendChild(b);
      });
      const cur = list[this.pending.sel];
      $('#na-peek-time').textContent = `${this.fmtTime(cur.time)} · ${fmtDist(cur.total)}`;
    };
    render();
    this.pending.render = render;
    if (!this._altTap) { this._altTap = true; map.on('click', (e) => this.tapAlt(e)); }
    box.classList.remove('peek');
    $('#na-peek-go').onclick = (e) => { e.stopPropagation(); $('#na-go').click(); };
    $('#na-go').onclick = () => {
      const p = this.pending;
      this.pending = null;
      Swipe.hide(box, 'down');
      this.active = p.list[p.sel];
      this.go(gps.pos);
    };
    $('#na-cancel').onclick = () => this.cancelPick();
    $('#na-edit').onclick = () => { const st = list[0].stops; this.pending = null; Swipe.hide(box, 'down'); this.draw(); Planner.open(st); };
    $('#na-save').onclick = () => this.saveAsTrack(this.pending.list[this.pending.sel]);
    $('#na-go').textContent = !list[0].joined ? 'Navigation starten' : list[0].travel === 'foot' ? 'Loslaufen' : list[0].travel === 'transit' ? 'Los geht’s' : 'Losfahren';
    $('#na-title').textContent = list[0].travel === 'transit' ? 'Verbindung auswählen' : list.length > 1 ? 'Route auswählen' : 'Deine Route';
    $('#na-credit').hidden = list[0].travel !== 'transit';
    $('#na-sub').textContent = list.length > 1 ? 'Tippe eine Route an, hier oder auf der Karte' : ((list[0].vias.length ? list[0].vias.length + (list[0].vias.length === 1 ? ' Zwischenstopp' : ' Zwischenstopps') : 'Direkt') + ' · ' + (list[0].startPt && !list[0].startPt.gps ? 'ab ' + list[0].startPt.name : 'ab deinem Standort'));
    const best = list.find((x) => x.walk);
    if (list[0].travel === 'foot' && (!best || best.walk.routePct < 20)) {
      $('#na-sub').textContent = 'Hinweis: Für diese Strecke gibt es keine durchgehende markierte Wanderroute. Der Weg führt über normale Wege' + (best && best.walk.roadPct >= 15 ? ' und ein Stück an Straßen entlang.' : '.');
    }
    Swipe.show(box, 'down');
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
      const tv = this.active.travel;
      const startKey = tv === 'foot' ? 'start_walk' : tv === 'transit' ? 'start_transit' : 'start';
      const startText = tv === 'foot' ? 'Route gestartet. Guten Weg!' : tv === 'transit' ? 'Route gestartet. Gute Reise!' : 'Route gestartet. Gute Fahrt!';
      this.say(this.active.mode === 'route' ? startText : 'Luftlinie zum Ziel.', false, [this.active.mode === 'route' ? startKey : 'line']);
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
    if (!a || a.mode !== 'route' || a.track || a.travel === 'transit' || this.busy) return;
    if (!navigator.onLine && !RouteData.local.size) return;
    this.busy = true;
    a.lastReroute = Date.now();
    try {
      const rest = a.vias.filter((v) => v.at > a.along + 30);
      const res = await this.calcAny([{ ...pos, gps: true }, ...rest, a.target]);
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
    if (map) map.easeTo({ pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
    this.draw();
    if (!silent) toast('Navigation beendet');
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    Pack.stop();
    if (window.reloadWhenIdle) setTimeout(() => window.reloadWhenIdle(), 1500);   // aufgeschobenes Update jetzt laden
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
      // Nach einem Neustart darf das iPhone erst nach einem Fingertipp wieder sprechen
      if (this.voice) setTimeout(() => toast('Navigation läuft weiter. Einmal antippen, damit die Ansagen wieder klingen.', 30000, {
        label: 'Ansagen an', run: () => { Pack.unlock(); this.say('Sprachansagen an.', true, ['voice_on']); }
      }), 1200);
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

  esc(s) { return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); },

  /* Hinweis vor Maut-Abschnitten (Brücken, Tunnel, Autobahnen) */
  tollAlert() {
    const a = this.active;
    for (const t of a.tolls || []) {
      const d = t.at - a.along;
      const key = 'toll:' + Math.round(t.at);
      if (d > 0 && d < ((gps.speed || 0) > 18 ? 3000 : 1000) && !a.spoken[key]) {
        a.spoken[key] = 1;
        const what = t.names.length ? ': ' + t.names.slice(0, 2).join(', ') : '';
        toast('€ Mautpflichtiger Abschnitt in ' + fmtDist(d) + what, 6000);
        this.say('In ' + this.speakDist(d) + ' beginnt ein mautpflichtiger Abschnitt.', false, [this.distKey(d), 'toll']);
      }
    }
  },

  announce() {
    this.tollAlert();
    const a = this.active, m = this.next();
    if (!m || m.type === 27) return;
    const d = m.at - a.along;
    const key = m.idx + ':' + m.at;
    const fast = (gps.speed || 0) > 18;
    const far = fast ? 1500 : 500;
    const st = a.spoken[key] || 0;
    const act = this.actKey(m);
    if (m.tts) {
      // Ein- und Aussteigen, Fußwege bei Bus & Bahn: als ganzer Satz
      if (st < 1 && d <= (m.type === 41 ? 600 : 80)) { a.spoken[key] = 2; this.say(m.type === 41 ? 'Gleich ' + m.alert + '.' : m.verbal); }
      return;
    }
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
    if ($('#nb-lanes')) $('#nb-lanes').hidden = true;
    if (!a.joined) {
      const s = { lon: a.coords[0][0], lat: a.coords[0][1] };
      icon.innerHTML = `<svg viewBox="0 0 24 24" style="transform:rotate(${bearingDeg(pos, s) - map.getBearing()}deg)"><path d="M12 21V4M6 10l6-6 6 6"/></svg>`;
      dist.textContent = fmtDist(distance(pos, s));
      text.textContent = 'Zum Start der Route' + (a.startPt && a.startPt.name ? ': ' + a.startPt.name : '');
    } else if (a.off > 60) {
      const back = distance(pos, { lon: a.proj[0], lat: a.proj[1] });
      icon.innerHTML = `<svg viewBox="0 0 24 24" style="transform:rotate(${bearingDeg(pos, { lon: a.proj[0], lat: a.proj[1] }) - map.getBearing()}deg)"><path d="M12 21V4M6 10l6-6 6 6"/></svg>`;
      dist.textContent = fmtDist(back);
      text.textContent = a.track ? 'Abseits des Tracks · zurück zur Linie' : (navigator.onLine || RouteData.local.size) && a.travel !== 'transit' ? 'Abseits der Route · wird neu berechnet …' : 'Abseits der Route · zurück zur Linie';
    } else {
      const m = this.next();
      icon.innerHTML = this.icon(m ? m.type : 4, m && m.exit);
      dist.textContent = fmtDist(m ? m.at - a.along : a.remaining);
      this.renderLanes(m, m ? m.at - a.along : Infinity);
      text.textContent = m ? m.text : 'Ziel: ' + (a.target.name || '');
    }
    const left = a.total ? a.time * (a.remaining / a.total) : 0;
    const eta = new Date(Date.now() + left * 1000);
    $('#nf-rem').textContent = fmtDist(a.remaining);
    $('#nf-eta').innerHTML = `${this.fmtTime(left)} · <span class="eta-word">Ankunft </span>${eta.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  },

  geojson(pos) {
    const a = this.active;
    const fc = { type: 'FeatureCollection', features: [] };
    const pd = this.pending;
    if (pd) {
      pd.list.forEach((r, i) => { if (i !== pd.sel) fc.features.push({ type: 'Feature', properties: { kind: 'alt', i }, geometry: { type: 'LineString', coordinates: r.coords } }); });
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

  cancelPick() {
    if (!this.pending) return;
    this.pending = null;
    Swipe.hide($('#nav-alts'), 'down');
    this.draw();
  },

  /* andere Route direkt auf der Karte antippen: Nummer der getroffenen Linie oder -1 */
  altAt(pt) {
    const pd = this.pending;
    if (!pd || !map.getLayer('route-alt')) return -1;
    const R = 18;
    const hits = map.queryRenderedFeatures([[pt.x - R, pt.y - R], [pt.x + R, pt.y + R]], { layers: ['route-alt'] });
    if (!hits.length) return -1;
    if (map.queryRenderedFeatures(pt, { layers: ['places-icon', 'poi-icon', 'route-target', 'hike-pts', 'oev-halt', 'tours-pt'].filter((l) => map.getLayer(l)) }).length) return -1;
    // bei mehreren Linien die nächste nehmen
    let best = -1, bd = Infinity;
    for (const i of new Set(hits.map((f) => f.properties.i))) {
      const c = pd.list[i] && pd.list[i].coords;
      if (!c) continue;
      let prev = null;
      for (const q of c) {
        const a = map.project(q);
        if (prev) {
          const dx = a.x - prev.x, dy = a.y - prev.y, l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, ((pt.x - prev.x) * dx + (pt.y - prev.y) * dy) / l2)) : 0;
          const d = Math.hypot(prev.x + t * dx - pt.x, prev.y + t * dy - pt.y);
          if (d < bd) { bd = d; best = i; }
        }
        prev = a;
      }
    }
    return bd <= R * 1.5 ? best : -1;
  },
  tapAlt(e) {
    const i = this.altAt(e.point);
    if (i < 0) return;
    this.pending.sel = i;
    if (this.pending.render) this.pending.render();
    this.draw();
  },

  draw(pos) {
    const src = map && map.getSource && map.getSource('route');
    if (src) src.setData(this.geojson(pos));
  },

  follow() {
    const p = gps.pos;
    gps.follow = true;
    $('#btn-locate').classList.add('active');
    const cam = p && this.camera(p, gps.speed);
    if (cam) map.easeTo({ ...cam, duration: 900 });
    else if (p) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 900, essential: true });
  },

  /* Navi-Kamera: je schneller, desto weiter weg; vor Abzweigungen nah heran, Karte gekippt, Fahrzeug im unteren Drittel */
  camera(cur, speed) {
    const a = this.active;
    if (!a || a.mode !== 'route' || !a.joined || !store.get('navCam', true)) return null;
    const v = (speed || 0) * 3.6;
    let z = v < 20 ? 17.4 : v < 40 ? 17 : v < 60 ? 16.6 : v < 90 ? 16 : 15.3;
    const m = this.next();
    const d = m ? m.at - a.along : Infinity;
    if (d < Math.max(200, (speed || 0) * 14)) z = Math.max(z, v > 70 ? 16.8 : 17.8);
    const center = a.off < 25 && a.proj ? a.proj : [cur.lon, cur.lat];
    const brg = this.routeBearing();
    return {
      center, zoom: z, pitch: store.get('navPitch', true) ? 55 : 0,
      bearing: brg === null ? map.getBearing() : brg,
      padding: this.camPadding(),
      duration: 1000, easing: (t) => t, essential: true
    };
  },

  /* freien Kartenbereich zwischen den Navi-Leisten bestimmen und das Fahrzeug dort ins untere Drittel setzen */
  camPadding() {
    const box = map.getContainer();
    const W = box.clientWidth, H = box.clientHeight;
    const b = $('#nav-banner').getBoundingClientRect(), f = $('#nav-foot').getBoundingClientRect();
    const side = window.matchMedia('(max-height: 500px) and (orientation: landscape)').matches;
    if (side && b.width) {
      // iPhone quer: Leisten links, Karte rechts daneben
      const left = Math.round(Math.max(b.right, f.right) + 8);
      return { left: Math.min(left, W * 0.6), top: Math.round(H * 0.32), bottom: 0, right: 0 };
    }
    const top = b.height ? b.bottom : 0;
    const bottom = f.height ? f.top : H;
    const y = top + 0.72 * (bottom - top);
    return { top: Math.round(Math.max(0, 2 * y - bottom)), bottom: Math.round(H - bottom), left: 0, right: 0 };
  },

  /* Richtung der Route ein Stück voraus: ruhiger als der GPS-Kurs, auch bei Schritttempo */
  routeBearing() {
    const a = this.active;
    if (!a || !a.coords.length || a.off > 40) return gps.heading;
    const from = a.proj || a.coords[a.seg];
    let i = a.seg + 1;
    while (i < a.coords.length - 1 && a.cum[i] < a.along + 30) i++;
    const to = a.coords[Math.min(i, a.coords.length - 1)];
    if (!to || (to[0] === from[0] && to[1] === from[1])) return gps.heading;
    return bearingDeg({ lon: from[0], lat: from[1] }, { lon: to[0], lat: to[1] });
  },

  /* Spurhinweis als kleine Pfeile */
  laneSvg(ind) {
    const P = { straight: 'M12 21V5M7 10l5-5 5 5', none: 'M12 21V5M7 10l5-5 5 5',
      'slight right': 'M10 21v-8l6-7M11 6h5v5', 'slight left': 'M14 21v-8L8 6M13 6H8v5',
      right: 'M9 21v-7a4 4 0 0 1 4-4h6M15 6l4 4-4 4', left: 'M15 21v-7a4 4 0 0 0-4-4H5M9 6 5 10l4 4',
      'sharp right': 'M9 21V9l8 8M17 11v6h-6', 'sharp left': 'M15 21V9l-8 8M7 11v6h6',
      uturn: 'M15 21V10a4 4 0 0 0-8 0v4M4 11l3 3 3-3' };
    return `<svg viewBox="0 0 24 24">${ind.map((k) => `<path d="${P[k] || P.straight}"/>`).join('')}</svg>`;
  },
  renderLanes(m, d) {
    const box = $('#nb-lanes');
    if (!box) return;
    const show = m && m.lanes && d < 1200 && m.lanes.some((l) => !l.ok);
    box.hidden = !show;
    if (!show) return;
    box.innerHTML = m.lanes.map((l) => `<span class="lane${l.ok ? ' ok' : ''}">${this.laneSvg(l.ind)}</span>`).join('');
  },

  overview() {
    const a = this.active;
    if (!a) return;
    const pts = a.mode === 'route' ? a.coords : [[a.target.lon, a.target.lat], ...(gps.pos ? [[gps.pos.lon, gps.pos.lat]] : [])];
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const p of pts) b.extend(p);
    gps.follow = false;
    $('#btn-locate').classList.remove('active');
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    map.fitBounds(b, { padding: { top: 140, bottom: 140, left: 60, right: 90 }, maxZoom: 15, bearing: 0, pitch: 0, duration: 800 });
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
    if ((!this.voice && !force) || !text) return Promise.resolve(false);
    const pv = this.packVoice();
    if (pv && keys && keys.length) {
      return Pack.play(pv, keys, store.get('navRate', 1)).then(() => true).catch(() => {
        // beim Ausprobieren sagen, warum die gewählte Stimme nicht klingt, statt still die Gerätestimme zu nehmen
        if (force) toast('Die gewählte Stimme ließ sich nicht abspielen, ersatzweise spricht die Gerätestimme. (' + Pack.lastError.slice(0, 160) + ')', 9000);
        return this.sayTTS(text);
      });
    }
    return Promise.resolve(this.sayTTS(text));
  },

  sayTTS(text) {
    if (!('speechSynthesis' in window)) return false;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'de-DE';
      const v = this.pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = store.get('navRate', 1);
      u.pitch = 1;
      // iOS verschluckt eine Ansage direkt nach cancel(), daher kurz warten
      if (speechSynthesis.speaking || speechSynthesis.pending) { speechSynthesis.cancel(); setTimeout(() => speechSynthesis.speak(u), 120); }
      else speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
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
    const test = $('#voice-test');
    test.onclick = async () => {
      Pack.unlock();
      test.textContent = 'Spielt …';
      Pack.endsAt = 0;
      const ok = await this.say('In 300 Metern rechts abbiegen.', true, ['d300', 'right']);
      setTimeout(() => { test.textContent = 'Probe hören'; }, Math.max(600, Math.min(5000, (Pack.endsAt || Date.now() + 1800) - Date.now())));
      if (!ok) toast('Kein Ton möglich. Ist das iPad stumm oder ganz leise gestellt?', 4500);
    };
    for (const [id, key] of [['#t-navcam', 'navCam'], ['#t-navpitch', 'navPitch']]) {
      const el = $(id);
      el.checked = store.get(key, true);
      el.onchange = () => { store.set(key, el.checked); if (this.active && gps.pos) this.follow(); };
    }
    const silent = $('#voice-silent');
    silent.checked = store.get('voiceSilent', true);
    silent.onchange = () => { store.set('voiceSilent', silent.checked); Pack.unlock(); };
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
    Promise.all([RouteData.scan(), RouteData.loadIndex()]).then(() => { if (typeof renderRegions === 'function') renderRegions(); });
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
