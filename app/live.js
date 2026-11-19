/* Standort teilen: die eigene Position verschlüsselt an eine Gruppe schicken und die der anderen auf der Karte zeigen.
 * Ein Code enthält Gruppe und Schlüssel, bei „gegenseitig“ auch den Schreibschlüssel. Gesendet wird nur, solange die App offen ist. */
'use strict';

const Live = {
  groups: [],
  peers: {},          // gruppe → mitglied → { name, lat, lon, … }
  markers: {},        // gruppe:mitglied → maplibregl.Marker
  trail: [],          // eigene Spur der letzten Stunden [lat, lon, t]
  last: null,         // letzte eigene Position
  sentAt: {},         // gruppe → Zeit der letzten erfolgreichen Meldung
  sentPos: {},        // gruppe → Position der letzten Meldung
  trying: {},
  etags: {},
  open: null,
  draft: null,
  poll: null,
  card: null,
  COLORS: ['#E8590C', '#1C7ED6', '#2F9E44', '#AE3EC9', '#D6336C', '#0C8599', '#F59F00', '#5F3DC4'],

  url() { return ((Tiles.sources && Tiles.sources.sync) || 'https://ovl-karte.y3m.workers.dev/sync/').replace(/sync\/?$/, 'loc/'); },
  init() {
    const g = store.get('live', []);
    this.groups = Array.isArray(g) ? g : [];
    this.peers = store.get('livePeers', {}) || {};
    this.trail = store.get('liveTrail', []) || [];
  },
  save() { store.set('live', this.groups); },
  savePeers() { store.set('livePeers', this.peers); },
  get(id) { return this.groups.find((g) => g.id === id); },
  sharing() { return this.groups.filter((g) => g.me && g.me.on && (!g.me.until || g.me.until > Date.now())); },
  myName() { return store.get('liveName', '') || ''; },
  color(m) { let h = 0; for (const ch of m) h = (h * 31 + ch.charCodeAt(0)) | 0; return this.COLORS[Math.abs(h) % this.COLORS.length]; },
  code(g, write) { return ['OVL2', g.id, g.key].concat(write && g.w ? [g.w] : []).join('.'); },
  parse(text) {
    const m = String(text || '').match(/OVL2\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})(?:\.([A-Za-z0-9_-]{22}))?/);
    return m ? { id: m[1], key: m[2], w: m[3] || '' } : null;
  },
  until(choice) { return choice === '1h' ? Date.now() + 3600e3 : choice === '8h' ? Date.now() + 8 * 3600e3 : 0; },
  untilText(u) {
    if (!u) return 'ohne Ende';
    const d = new Date(u);
    const today = new Date().toDateString() === d.toDateString();
    return 'bis ' + (today ? '' : d.toLocaleDateString('de', { weekday: 'short' }) + ' ') + d.toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' });
  },
  ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'gerade eben';
    if (m < 60) return `vor ${m} Min.`;
    if (m < 1440) return `vor ${Math.floor(m / 60)} Std.${m % 60 ? ' ' + (m % 60) + ' Min.' : ''}`;
    return 'am ' + new Date(t).toLocaleDateString('de') + ' ' + new Date(t).toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' });
  },

  /* ---------- eigene Position ---------- */
  onPos(cur, speed) {
    this.last = { lat: cur.lat, lon: cur.lon, t: Date.now(), spd: speed, hdg: gps.heading, acc: null };
    const tr = this.trail, lp = tr[tr.length - 1];
    if (!lp || distance({ lat: lp[0], lon: lp[1] }, cur) > 250 || Date.now() / 1000 - lp[2] > 180) {
      tr.push([+cur.lat.toFixed(5), +cur.lon.toFixed(5), Math.round(Date.now() / 1000)]);
      const old = Date.now() / 1000 - 3 * 3600;
      while (tr.length && (tr[0][2] < old || tr.length > 400)) tr.shift();
      store.set('liveTrail', tr);
    }
    this.tick();
  },
  tick(force) {
    if (!this.last) return;
    for (const g of this.groups) {
      if (!g.me || !g.me.on) continue;
      if (g.me.until && g.me.until < Date.now()) { this.stop(g, true); continue; }
      const prev = this.sentPos[g.id];
      const moving = (this.last.spd !== null && this.last.spd > 1.5) || (prev && distance(prev, this.last) > 60);
      const wait = moving ? 30e3 : 300e3;
      const since = Date.now() - (this.sentAt[g.id] || 0);
      if (force || since >= wait) this.send(g);
    }
  },
  async send(g) {
    if (this.trying[g.id] && Date.now() - this.trying[g.id] < 20e3) return;
    if (!navigator.onLine || !this.last) return;
    this.trying[g.id] = Date.now();
    try {
      const p = this.last;
      const body = { n: this.myName() || 'Ich', la: +p.lat.toFixed(6), lo: +p.lon.toFixed(6), sp: p.spd === null ? null : Math.round(p.spd * 10) / 10, hd: p.hdg === null ? null : Math.round(p.hdg), ft: p.t, u: g.me.until || 0, tr: this.trail };
      const box = await Sync.seal(g, body);
      const r = await fetch(`${this.url()}${g.id}/${g.me.mid}?bis=${g.me.until || 0}`, { method: 'PUT', body: Sync.b64u(box), headers: { 'X-Write': g.w, 'Content-Type': 'text/plain' } });
      if (r.status === 501) throw new Error('Standort teilen ist im Cloudflare-Worker noch nicht eingerichtet');
      if (r.status === 403) throw new Error('Diese Gruppe ist nur zum Ansehen');
      if (!r.ok) throw new Error('Server ' + r.status);
      this.sentAt[g.id] = Date.now();
      this.sentPos[g.id] = { lat: p.lat, lon: p.lon };
      g.err = '';
      g.me.at = Date.now();
    } catch (e) {
      g.err = e.message || String(e);
    } finally {
      this.trying[g.id] = 0;
      this.renderPill();
      if (this.open === g.id) this.renderGroup();
    }
  },
  async stop(g, expired) {
    if (!g.me) return;
    g.me.on = false;
    this.save();
    try { await fetch(`${this.url()}${g.id}/${g.me.mid}`, { method: 'DELETE', headers: { 'X-Write': g.w } }); } catch (e) { /* läuft auf dem Server von selbst ab */ }
    if (expired) toast('Standort teilen ist abgelaufen.');
    this.renderPill();
    this.renderMenu();
    if (this.open === g.id) this.renderGroup();
  },
  async start(g, choice) {
    if (!g.w) { toast('In dieser Gruppe kannst du nur ansehen.'); return; }
    g.me = { mid: (g.me && g.me.mid) || Sync.hex(Sync.rand(8)), on: true, until: this.until(choice), since: Date.now() };
    this.save();
    if (gps.watch === null) startGPS();
    this.renderPill();
    this.renderMenu();
    if (this.last) await this.send(g);
    else toast('Standort wird geteilt, sobald GPS eine Position hat.');
  },

  /* ---------- andere empfangen ---------- */
  async fetchAll() {
    if (!this.groups.length || !navigator.onLine || document.hidden) return;
    for (const g of [...this.groups]) {
      try {
        const r = await fetch(this.url() + g.id, { cache: 'no-store', headers: this.etags[g.id] ? { 'If-None-Match': this.etags[g.id] } : {} });
        if (r.status === 304) continue;
        if (r.status === 501) { g.err = 'Standort teilen ist im Cloudflare-Worker noch nicht eingerichtet'; continue; }
        if (!r.ok) continue;
        this.etags[g.id] = r.headers.get('ETag') || '';
        const rows = await r.json();
        const seen = {};
        for (const row of rows) {
          if (g.me && row.m === g.me.mid) continue;
          try {
            const d = await Sync.unseal(g, Sync.unb64u(row.d).buffer);
            seen[row.m] = { name: d.n, lat: d.la, lon: d.lo, spd: d.sp, hdg: d.hd, t: d.ft || row.t, sent: row.t, until: d.u || 0, trail: d.tr || [] };
          } catch (e) { /* falscher Schlüssel oder kaputt */ }
        }
        // wer nicht mehr in der Liste steht, hat aufgehört oder ist abgelaufen
        this.peers[g.id] = seen;
        if (g.err && /eingerichtet/.test(g.err)) g.err = '';
      } catch (e) { /* offline: alte Positionen bleiben stehen */ }
    }
    this.savePeers();
    this.render();
    this.renderMenu();
    if (this.open) this.renderGroup();
  },

  /* ---------- Karte ---------- */
  allPeers() {
    const out = [];
    for (const g of this.groups) for (const [m, p] of Object.entries(this.peers[g.id] || {})) {
      if (p.until && p.until < Date.now()) continue;
      out.push({ g, m, p });
    }
    return out;
  },
  render() {
    if (!map || !map.getStyle) return;
    const peers = this.allPeers();
    const keys = new Set(peers.map(({ g, m }) => g.id + ':' + m));
    for (const [k, mk] of Object.entries(this.markers)) if (!keys.has(k)) { mk.remove(); delete this.markers[k]; }
    const lines = [];
    for (const { g, m, p } of peers) {
      const k = g.id + ':' + m;
      const col = this.color(m);
      let mk = this.markers[k];
      if (!mk) {
        const el = document.createElement('div');
        el.className = 'peer';
        el.innerHTML = '<i class="peer-dir"></i><b></b><span></span>';
        el.addEventListener('click', (e) => { e.stopPropagation(); this.showCard(g.id, m); });
        mk = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lon, p.lat]).addTo(map);
        this.markers[k] = mk;
      }
      mk.setLngLat([p.lon, p.lat]);
      const el = mk.getElement();
      const stale = Date.now() - p.t > 15 * 60e3;
      el.classList.toggle('stale', stale);
      el.style.setProperty('--c', col);
      el.querySelector('b').textContent = (p.name || '?').trim().charAt(0).toUpperCase();
      el.querySelector('span').textContent = p.name + (stale ? ' · ' + this.ago(p.t) : '');
      const dir = el.querySelector('.peer-dir');
      const moving = p.spd !== null && p.spd > 1.5 && p.hdg !== null && !stale;
      dir.hidden = !moving;
      if (moving) dir.style.transform = `rotate(${p.hdg}deg)`;
      const tr = (p.trail || []).map((x) => [x[1], x[0]]);
      tr.push([p.lon, p.lat]);
      if (tr.length > 1) lines.push({ type: 'Feature', properties: { c: col }, geometry: { type: 'LineString', coordinates: tr } });
    }
    const data = { type: 'FeatureCollection', features: lines };
    const src = map.getSource('live-trail');
    if (src) src.setData(data);
    else if (map.isStyleLoaded()) {
      map.addSource('live-trail', { type: 'geojson', data });
      map.addLayer({ id: 'live-trail', type: 'line', source: 'live-trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': 3, 'line-opacity': 0.75, 'line-dasharray': [1, 1.6] } });
    }
    if (this.card) this.fillCard();
  },
  showCard(gid, m) {
    this.closeCard();
    if (typeof Lists !== 'undefined') Lists.closeCard();
    const el = document.createElement('div');
    el.className = 'pin-card panel';
    el.innerHTML = `<div class="pc-top"><span class="pi-icon own peer-ic"></span><span class="pc-txt"><b></b><small></small><p></p></span><button type="button" class="round pc-x" aria-label="Schließen"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      <div class="pc-btns two"><button type="button" class="btn primary pc-route">Route hierhin</button><button type="button" class="btn pc-center">Zeigen</button></div>`;
    document.body.appendChild(el);
    this.card = { el, gid, m };
    document.body.classList.add('card-open');
    el.querySelector('.pc-x').onclick = () => this.closeCard();
    el.querySelector('.pc-route').onclick = () => { const p = this.peers[gid][m]; this.closeCard(); Nav.choose({ name: p.name, lat: p.lat, lon: p.lon }); };
    el.querySelector('.pc-center').onclick = () => { const p = this.peers[gid][m]; gps.follow = false; map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 13) }); };
    this.fillCard();
  },
  fillCard() {
    const { el, gid, m } = this.card;
    const p = (this.peers[gid] || {})[m];
    if (!p) { this.closeCard(); return; }
    const ic = el.querySelector('.peer-ic');
    ic.style.background = this.color(m);
    ic.textContent = (p.name || '?').charAt(0).toUpperCase();
    el.querySelector('b').textContent = p.name;
    const bits = ['Standort ' + this.ago(p.t)];
    if (p.spd !== null && p.spd > 1) bits.push(Math.round(p.spd * 3.6) + ' km/h');
    if (gps.pos) bits.push(fmtDist(distance(gps.pos, p)) + ' entfernt');
    el.querySelector('small').textContent = bits.join(' · ');
    el.querySelector('p').textContent = p.until ? 'Teilt ' + this.untilText(p.until) : '';
  },
  closeCard() { if (this.card) { this.card.el.remove(); this.card = null; } if (!document.querySelector('.pin-card')) document.body.classList.remove('card-open'); },

  /* kleiner Hinweis auf der Karte, solange man selbst teilt */
  renderPill() {
    const pill = $('#live-pill');
    if (!pill) return;
    const on = this.sharing();
    pill.hidden = !on.length;
    if (!on.length) return;
    const err = on.find((g) => g.err);
    pill.classList.toggle('err', !!err);
    pill.querySelector('span').textContent = err ? 'Standort: ' + (navigator.onLine ? 'Fehler' : 'offline') : 'Standort geteilt' + (on.length === 1 && on[0].me.until ? ' · ' + this.untilText(on[0].me.until) : '');
    pill.onclick = () => this.openGroup(on[0].id);
  },

  /* ---------- Menü ---------- */
  title(g) {
    const names = Object.values(this.peers[g.id] || {}).map((p) => p.name).filter(Boolean);
    if (g.me && names.length) return 'Ich und ' + names.join(', ');
    if (names.length) return names.join(', ');
    return g.me ? 'Mein Standort' : 'Wartet auf Standorte';
  },
  renderMenu() {
    const box = $('#live-list');
    if (!box) return;
    box.innerHTML = '';
    for (const g of this.groups) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'place-item';
      const on = g.me && g.me.on && (!g.me.until || g.me.until > Date.now());
      row.innerHTML = `<span class="pi-icon live-ic${on ? ' on' : ''}">${svgPath('M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Zm0-9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z')}</span><span class="pi-txt"><b></b><small></small></span>${svgPath('m9 5 7 7-7 7', 'chev')}`;
      row.querySelector('b').textContent = this.title(g);
      row.querySelector('small').textContent = g.err ? '⚠︎ ' + g.err : (on ? 'Du teilst ' + this.untilText(g.me.until) : 'Du teilst gerade nicht') + (g.w ? '' : ' · nur ansehen');
      row.onclick = () => this.openGroup(g.id);
      box.appendChild(row);
    }
  },
  openNew() {
    this.draft = { dur: '8h', mutual: true };
    $('#ln-name').value = this.myName();
    this.renderNew();
    Sync.page('#live-new-page');
  },
  renderNew() {
    const d = this.draft;
    for (const b of $('#ln-dur').querySelectorAll('button')) { b.setAttribute('aria-checked', String(b.dataset.d === d.dur)); b.onclick = () => { d.dur = b.dataset.d; this.renderNew(); }; }
    const sw = $('#ln-mutual');
    sw.checked = d.mutual;
    sw.onchange = () => { d.mutual = sw.checked; };
  },
  async createFromDraft() {
    const name = $('#ln-name').value.trim();
    if (!name) { $('#ln-name').focus(); toast('Bitte einen Namen eingeben – so erscheinst du bei den anderen.'); return; }
    store.set('liveName', name);
    const g = { id: Sync.hex(Sync.rand(16)), key: Sync.b64u(Sync.rand(32)), w: Sync.b64u(Sync.rand(16)), mutual: this.draft.mutual, created: Date.now(), owner: true };
    this.groups.push(g);
    await this.start(g, this.draft.dur);
    this.showCode(g);
  },
  showCode(g) {
    const write = g.mutual !== false;
    const code = this.code(g, write);
    Sync.codePage({ title: 'Standort von ' + this.myName(), rights: write ? 'Gegenseitig' : 'Nur ansehen', code,
      hint: write ? 'Wer den Code scannt, sieht dich auf der Karte und kann seinen Standort zurück teilen.' : 'Wer den Code scannt, sieht dich auf der Karte. Nur an Leute geben, denen du vertraust.',
      text: `${this.myName()} teilt den Standort mit dir (Overland-Navi).\nSo geht’s: Den Code unten kopieren, die Overland-Navi-App öffnen und den Code ins Suchfeld einfügen (oder Menü → Standort teilen → Code eingeben).\n\n${code}\n\nOhne App: Link öffnen`,
      back: () => this.openGroup(g.id) });
  },
  async join(text) {
    const k = this.parse(text);
    if (!k) { toast('Das ist kein gültiger Standort-Code.'); return null; }
    let g = this.get(k.id);
    if (!g) {
      g = { id: k.id, key: k.key, w: k.w, mutual: !!k.w, created: Date.now() };
      this.groups.push(g);
      this.save();
    }
    await this.fetchAll();
    const n = Object.keys(this.peers[g.id] || {}).length;
    if (!n) toast('Gerade teilt niemand in dieser Gruppe einen Standort – sobald jemand sendet, erscheint er auf der Karte.', 6000);
    if (g.w && !(g.me && g.me.on)) {
      if (!this.myName()) {
        const nm = prompt('Unter welchem Namen sollen dich die anderen sehen?', '');
        if (nm && nm.trim()) store.set('liveName', nm.trim());
      }
      const pick = await Lists.choose('Deinen Standort auch teilen?', [
        { id: '1h', label: 'Ja, 1 Stunde', d: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z' },
        { id: '8h', label: 'Ja, 8 Stunden', d: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z' },
        { id: 'inf', label: 'Ja, ohne Ende', d: 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z' },
        { id: 'no', label: 'Nein, nur ansehen', d: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z' }]);
      if (pick && pick !== 'no') await this.start(g, pick);
    }
    this.save();
    this.renderMenu();
    const first = Object.values(this.peers[g.id] || {})[0];
    if (first && map) { gps.follow = false; map.easeTo({ center: [first.lon, first.lat], zoom: Math.max(map.getZoom(), 11) }); }
    return { live: true, id: g.id };
  },
  openGroup(id) {
    this.open = id;
    this.renderGroup();
    Sync.page('#live-group-page');
  },
  renderGroup() {
    const g = this.get(this.open);
    if (!g) { Sync.page(null); return; }
    $('#lg-title').textContent = this.title(g);
    const on = g.me && g.me.on && (!g.me.until || g.me.until > Date.now());
    const sw = $('#lg-share');
    sw.checked = !!on;
    sw.disabled = !g.w;
    $('#lg-share-txt').textContent = !g.w ? 'Nur ansehen – du kannst hier nicht teilen' : on ? (g.err ? '⚠︎ ' + g.err : 'Du teilst ' + this.untilText(g.me.until) + (g.me.at ? ' · zuletzt gesendet ' + this.ago(g.me.at) : ' · wartet auf GPS')) : 'Aus';
    sw.onchange = async () => {
      if (!sw.checked) { await this.stop(g); return; }
      const pick = await Lists.choose('Wie lange teilen?', [
        { id: '1h', label: '1 Stunde', d: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z' },
        { id: '8h', label: '8 Stunden', d: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z' },
        { id: 'inf', label: 'Ohne Ende', d: 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z' }]);
      if (!pick) { sw.checked = false; return; }
      await this.start(g, pick);
      this.renderGroup();
    };
    const box = $('#lg-peers');
    box.innerHTML = '';
    const peers = Object.entries(this.peers[g.id] || {});
    if (!peers.length) box.innerHTML = '<p class="muted small">Noch niemand sonst teilt hier seinen Standort.</p>';
    for (const [m, p] of peers) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'place-item';
      row.innerHTML = `<span class="pi-icon own peer-ic" style="background:${this.color(m)}"></span><span class="pi-txt"><b></b><small></small></span><span class="pi-dist"></span>`;
      row.querySelector('.peer-ic').textContent = (p.name || '?').charAt(0).toUpperCase();
      row.querySelector('b').textContent = p.name;
      row.querySelector('small').textContent = 'Standort ' + this.ago(p.t) + (p.until ? ' · teilt ' + this.untilText(p.until) : '');
      row.querySelector('.pi-dist').textContent = gps.pos ? fmtDist(distance(gps.pos, p)) : '';
      row.onclick = () => { closeSheet(); gps.follow = false; map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 13) }); this.showCard(g.id, m); };
      box.appendChild(row);
    }
    $('#lg-code').hidden = !g.w;
    $('#lg-code').onclick = () => this.showCode(g);
    $('#lg-leave').onclick = async () => {
      if (g.me && g.me.on) await this.stop(g);
      this.groups = this.groups.filter((x) => x !== g);
      delete this.peers[g.id];
      this.save();
      this.savePeers();
      this.render();
      this.renderMenu();
      this.renderPill();
      this.open = null;
      Sync.page(null);
      toast('Gruppe verlassen');
    };
  },

  setup() {
    this.init();
    $('#btn-live-new').onclick = () => this.openNew();
    $('#ln-back').onclick = () => Sync.page(null);
    $('#ln-go').onclick = () => this.createFromDraft();
    $('#lg-back').onclick = () => { this.open = null; Sync.page(null); };
    this.renderMenu();
    this.renderPill();
    const go = () => { this.render(); this.fetchAll(); };
    if (map && map.isStyleLoaded()) go(); else if (map) map.once('idle', go);
    setInterval(() => this.fetchAll(), 20e3);
    setInterval(() => { this.tick(); this.renderPill(); if (this.card) this.fillCard(); }, 30e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.tick(true); this.fetchAll(); } });
    window.addEventListener('online', () => { this.tick(true); this.fetchAll(); });
  }
};
