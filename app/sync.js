/* Sync-Codes: Orte (und bei „Alles“ auch Tracks) mit anderen Geräten abgleichen.
 * Ein Code enthält Raum-Kennung, Schlüssel und – nur bei „gemeinsam bearbeiten“ – den Schreibschlüssel.
 * Die Daten liegen verschlüsselt im Cloudflare-Speicher, der Schlüssel verlässt nie die Geräte. */
'use strict';

const Sync = {
  conns: [],
  timer: null,
  poll: null,
  running: false,
  applying: false,
  open: null,          // im Menü geöffnete Verbindung
  draft: null,         // neue Verbindung im Aufbau

  init() {
    const saved = store.get('syncs', []);
    this.conns = Array.isArray(saved) ? saved : [];
  },
  save() { store.set('syncs', this.conns); },
  url() { return ((Tiles.sources && Tiles.sources.sync) || 'https://ovl-karte.y3m.workers.dev/sync/').replace(/\/?$/, '/'); },
  get(id) { return this.conns.find((c) => c.id === id); },

  /* ---------- Hilfen ---------- */
  rand(n) { return crypto.getRandomValues(new Uint8Array(n)); },
  hex(b) { return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); },
  b64u(b) { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  unb64u(t) { const s = atob(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
  now() { return new Date().toISOString(); },

  code(c, write) { return ['OVL1', c.id, c.key].concat(write && c.w ? [c.w] : []).join('.'); },
  link(code) { return location.origin + location.pathname.replace(/index\.html$/, '') + '#join=' + code; },
  parse(text) {
    const m = String(text || '').match(/OVL1\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})(?:\.([A-Za-z0-9_-]{22}))?/);
    return m ? { id: m[1], key: m[2], w: m[3] || '' } : null;
  },

  async cryptoKey(c) {
    if (!this._keys) this._keys = new Map();
    if (!this._keys.has(c.key)) this._keys.set(c.key, await crypto.subtle.importKey('raw', this.unb64u(c.key), 'AES-GCM', false, ['encrypt', 'decrypt']));
    return this._keys.get(c.key);
  },
  async gzip(bytes, back) {
    if (typeof CompressionStream === 'undefined') return null;
    const s = new Blob([bytes]).stream().pipeThrough(back ? new DecompressionStream('gzip') : new CompressionStream('gzip'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  },
  async seal(c, obj) {
    const raw = new TextEncoder().encode(JSON.stringify(obj));
    const z = await this.gzip(raw);
    const iv = this.rand(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.cryptoKey(c), z || raw));
    const out = new Uint8Array(13 + ct.length);
    out[0] = z ? 2 : 1;
    out.set(iv, 1);
    out.set(ct, 13);
    return out;
  },
  async unseal(c, buf) {
    const b = new Uint8Array(buf);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(1, 13) }, await this.cryptoKey(c), b.slice(13)));
    const raw = b[0] === 2 ? await this.gzip(pt, true) : pt;
    return JSON.parse(new TextDecoder().decode(raw));
  },

  /* ---------- Was gehört zu einer Verbindung? ---------- */
  inScope(c, p) {
    const s = c.scope;
    const list = p.list || 'mine';
    if (s.type === 'all') return true;
    if (s.type === 'lists') return s.lists.includes(list);
    if (s.type === 'countries') return s.countries.some(([l, cc]) => l === list && (p.cc || '-') === cc);
    if (s.type === 'cats') return s.cats.includes(p.cat);
    if (s.type === 'items') return s.ids.includes(p.id);
    return false;
  },
  scoped(c) { return places.filter((p) => p.lat !== null && p.lat !== undefined && this.inScope(c, p)); },
  describe(c) {
    const s = c.scope;
    const n = this.scoped(c).length;
    const orte = n + (n === 1 ? ' Ort' : ' Orte');
    if (s.type === 'all') return `Alles · ${orte}${c.withTracks !== false ? ' und Tracks' : ''}`;
    if (s.type === 'lists') return s.lists.map((id) => Lists.get(id).name).join(', ') + ' · ' + orte;
    if (s.type === 'countries') return s.countries.map(([l, cc]) => `${Lists.countryName(cc)} (${Lists.get(l).name})`).join(', ') + ' · ' + orte;
    if (s.type === 'cats') return s.cats.map((id) => (CAT[id] || CAT.other).label).join(', ') + ' · ' + orte;
    return 'Ausgewählte Orte · ' + orte;
  },
  scopeOut(c) {
    const s = c.scope;
    if (s.type === 'lists') return { type: 'lists', lists: s.lists.map((id) => Lists.get(id).name) };
    if (s.type === 'countries') return { type: 'countries', countries: s.countries.map(([l, cc]) => [Lists.get(l).name, cc]) };
    if (s.type === 'cats') return { type: 'cats', cats: s.cats.map((id) => this.catOut(id)) };
    return { type: s.type };
  },
  catOut(id) { const c = CAT[id] || CAT.other; return { cat: c.id, catLabel: c.label, catColor: c.color, catIcon: c.custom ? c.d : '' }; },

  pack(p) {
    const l = Lists.get(p.list || 'mine');
    const it = { id: p.id, name: p.name, lat: p.lat, lon: p.lon, ele: p.ele || null, note: p.note || '', rating: p.rating || 0, feats: p.feats || [],
      time: p.time || '', updated: p.updated || p.time || '', url: p.url || '', cc: p.cc || '', auto: !!p.auto, list: l.id === 'mine' ? '' : l.name, listColor: l.color, ...this.catOut(p.cat) };
    return it;
  },
  /* einen Ort von außen übernehmen (neu oder Änderung) */
  unpack(c, it) {
    let list = 'mine';
    if (it.list) {
      const map = c.listMap || {};
      list = map[it.list] && Lists.all.some((l) => l.id === map[it.list]) ? map[it.list] : Lists.ensure(it.list, it.listColor);
      if (!map[it.list]) { c.listMap = { ...map, [it.list]: list }; }
    }
    const cat = Lists.catFromExt(it) || 'other';
    let p = places.find((x) => x.id === it.id);
    if (!p) { p = { id: it.id, photos: [] }; places.push(p); }
    Object.assign(p, { name: it.name, lat: it.lat, lon: it.lon, ele: it.ele || null, note: it.note || '', rating: it.rating || 0, feats: it.feats || [],
      time: it.time || p.time || this.now(), updated: it.updated, url: it.url || '', cc: it.cc || p.cc || '', auto: !!it.auto, list, cat, pend: !it.cc });
    return p;
  },
  packTrack(t) { return { id: t.id, name: t.name, color: t.color, dash: !!t.dash, visible: t.visible !== false, segments: t.segments, created: t.created, updated: t.updated || (t.created ? new Date(t.created).toISOString() : '') }; },
  digest(c) {
    let s = this.scoped(c).map((p) => p.id + ':' + (p.updated || '')).sort().join('|');
    if (c.scope.type === 'all' && c.withTracks !== false) s += '#' + tracks.map((t) => t.id + ':' + (t.updated || t.created || '')).sort().join('|');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  },

  /* ---------- Abgleich ---------- */
  soon() {
    if (this.applying || !this.conns.length) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncAll(), 6000);
  },
  async syncAll(manual) {
    if (this.running) { if (manual) toast('Abgleich läuft gerade …'); return; }
    if (!navigator.onLine) { if (manual) toast('Kein Internet – der Abgleich läuft, sobald du wieder online bist.'); return; }
    this.running = true;
    let changed = 0;
    try {
      for (const c of [...this.conns]) {
        try { changed += await this.syncOne(c); c.err = ''; }
        catch (e) { c.err = e.message || String(e); }
      }
    } finally {
      this.running = false;
      this.save();
      this.renderMenu();
      if (this.open) this.renderConn();
    }
    if (manual) toast(this.conns.some((c) => c.err) ? 'Abgleich teilweise fehlgeschlagen.' : `Abgeglichen${changed ? ` · ${changed} Änderungen übernommen` : ''} ✓`);
  },
  async fetchRemote(c, etag) {
    const r = await fetch(this.url() + c.id, { cache: 'no-store', headers: etag ? { 'If-None-Match': etag } : {} });
    if (r.status === 304) return { same: true, etag };
    if (r.status === 404) return { data: null, etag: '' };
    if (r.status === 501) throw new Error('Sync ist im Cloudflare-Worker noch nicht eingerichtet');
    if (!r.ok) throw new Error('Server ' + r.status);
    return { data: await this.unseal(c, await r.arrayBuffer()), etag: r.headers.get('ETag') || '' };
  },
  async syncOne(c, tries = 0) {
    if (c.ended) return 0;
    const dirty = this.digest(c) !== c.digest;
    const rem = await this.fetchRemote(c, dirty ? '' : c.etag);
    if (rem.same) { c.at = this.now(); return 0; }
    if (!rem.data && c.etag && c.role !== 'owner') { c.ended = true; throw new Error('Die Verbindung wurde vom Ersteller beendet'); }
    const R = rem.data || { v: 1, items: {}, tomb: {}, tracks: {}, ttomb: {} };
    R.items = R.items || {}; R.tomb = R.tomb || {}; R.tracks = R.tracks || {}; R.ttomb = R.ttomb || {};
    if (R.name && c.role !== 'owner') c.name = R.name;
    const canWrite = !!c.w;
    const last = new Set(c.last || []);
    const res = this.merge(c, R, last, canWrite);
    let applied = res.applied;
    if (c.scope.type === 'all' && c.withTracks !== false) applied += await this.mergeTracks(c, R, new Set(c.lastT || []), canWrite, res);
    if (applied) {
      this.applying = true;
      try { savePlaces(); Lists.refresh(); renderDataCats(); updateTracksSource(); } finally { this.applying = false; }
    }
    let etag = rem.etag;
    if (canWrite && (res.upload || !rem.data)) {
      const body = await this.seal(c, R);
      const r = await fetch(this.url() + c.id, { method: 'PUT', body, headers: { 'X-Write': c.w, 'Content-Type': 'application/octet-stream', ...(rem.etag ? { 'If-Match': rem.etag } : {}) } });
      if (r.status === 412 && tries < 2) return applied + await this.syncOne(c, tries + 1);
      if (r.status === 403) throw new Error('Nur ansehen – Änderungen werden nicht verschickt');
      if (r.status === 501) throw new Error('Sync ist im Cloudflare-Worker noch nicht eingerichtet');
      if (!r.ok) throw new Error('Speichern fehlgeschlagen (' + r.status + ')');
      etag = r.headers.get('ETag') || etag;
    }
    c.etag = etag;
    c.last = this.scoped(c).map((p) => p.id);
    if (c.scope.type === 'all') c.lastT = tracks.map((t) => t.id);
    if (c.scope.type === 'items') c.scope.ids = c.last.slice();
    c.digest = this.digest(c);
    c.at = this.now();
    c.n = c.last.length;
    return applied;
  },
  /* führt eigenen Stand und den aus der Ablage zusammen; R wird dabei zum neuen gemeinsamen Stand */
  merge(c, R, last, canWrite) {
    const local = new Map(this.scoped(c).map((p) => [String(p.id), p]));
    const ids = new Set([...local.keys(), ...Object.keys(R.items)]);
    let applied = 0, upload = false;
    const del = new Set();
    if (c.role === 'owner') {
      const head = JSON.stringify([c.name, this.scopeOut(c), c.withTracks !== false]);
      if (JSON.stringify([R.name, R.scope, R.withTracks]) !== head) { [R.name, R.scope, R.withTracks] = JSON.parse(head); upload = true; }
    }
    for (const id of ids) {
      const l = local.get(id), r = R.items[id];
      if (l && r) {
        const lu = l.updated || '', ru = r.updated || '';
        if (ru > lu || (!canWrite && ru !== lu)) { this.unpack(c, r); applied++; }
        else if (lu > ru && canWrite) { R.items[id] = this.pack(l); upload = true; }
      } else if (r) {
        const p = places.find((x) => String(x.id) === id);
        if (canWrite && (last.has(Number(id)) || last.has(id))) {
          // war dabei und ist hier gelöscht oder aus der Auswahl genommen
          delete R.items[id]; R.tomb[id] = this.now(); upload = true;
        } else if (canWrite && p && (p.updated || '') > (r.updated || '')) {
          delete R.items[id]; R.tomb[id] = this.now(); upload = true;
        } else {
          if (c.scope.type === 'items' && !c.scope.ids.includes(r.id)) c.scope.ids.push(r.id);
          this.unpack(c, r); applied++;
        }
      } else if (l) {
        const t = R.tomb[id];
        if (t && t >= (l.updated || '')) { del.add(l.id); applied++; }
        else if (!canWrite) { if (last.has(l.id)) { del.add(l.id); applied++; } }
        else { R.items[id] = this.pack(l); delete R.tomb[id]; upload = true; }
      }
    }
    if (del.size) {
      places = places.filter((p) => !del.has(p.id));
      if (c.scope.type === 'items') c.scope.ids = c.scope.ids.filter((x) => !del.has(x));
    }
    // alte Löschvermerke nach 90 Tagen vergessen
    const old = new Date(Date.now() - 90 * 864e5).toISOString();
    for (const [k, t] of Object.entries(R.tomb)) if (t < old) { delete R.tomb[k]; upload = true; }
    return { applied, upload };
  },
  async mergeTracks(c, R, last, canWrite, res) {
    let applied = 0;
    const local = new Map(tracks.map((t) => [String(t.id), t]));
    const ids = new Set([...local.keys(), ...Object.keys(R.tracks)]);
    for (const id of ids) {
      const l = local.get(id), r = R.tracks[id];
      if (l && r) {
        const lu = l.updated || '', ru = r.updated || '';
        if (ru > lu || (!canWrite && ru !== lu)) { Object.assign(l, r); await this.putTrack(l); applied++; }
        else if (lu > ru && canWrite) { R.tracks[id] = this.packTrack(l); res.upload = true; }
      } else if (r) {
        if (canWrite && (last.has(r.id) || last.has(id))) { delete R.tracks[id]; R.ttomb[id] = this.now(); res.upload = true; }
        else { const t = { ...r }; tracks.push(t); await this.putTrack(t); applied++; }
      } else if (l) {
        const t = R.ttomb[id];
        if ((t && t >= (l.updated || '')) || (!canWrite && last.has(l.id))) {
          tracks = tracks.filter((x) => x !== l);
          try { await DB.run('tracks', 'readwrite', (st) => st.delete(l.id)); } catch (e) { /* egal */ }
          applied++;
        } else if (canWrite) { R.tracks[id] = this.packTrack(l); delete R.ttomb[id]; res.upload = true; }
      }
    }
    return applied;
  },
  async putTrack(t) { this.applying = true; try { await DB.run('tracks', 'readwrite', (s) => s.put(t)); } finally { this.applying = false; } },

  /* ---------- Verbindung anlegen, beitreten, trennen ---------- */
  async create({ name, scope, write, withTracks }) {
    const c = { id: this.hex(this.rand(16)), key: this.b64u(this.rand(32)), w: this.b64u(this.rand(16)), name, role: 'owner', share: write ? 'edit' : 'view', scope, withTracks, last: [], created: this.now() };
    this.conns.push(c);
    this.save();
    try { await this.syncOne(c); c.err = ''; } catch (e) { c.err = e.message; }
    this.save();
    return c;
  },
  async join(text) {
    if (/OVL2\./.test(String(text || '')) && typeof Live !== 'undefined') return Live.join(text);
    const k = this.parse(text);
    if (!k) { toast('Das ist kein gültiger Code. Er beginnt mit OVL1.'); return null; }
    const have = this.get(k.id);
    if (have) {
      if (k.w && !have.w) { have.w = k.w; this.save(); toast('Du darfst jetzt mitbearbeiten.'); }
      else toast('Diese Verbindung hast du schon.');
      return have;
    }
    if (!navigator.onLine) { toast('Zum Verbinden brauchst du Internet.'); return null; }
    const c = { id: k.id, key: k.key, w: k.w, role: 'member', scope: { type: 'items', ids: [] }, last: [], created: this.now(), listMap: {} };
    let rem;
    try { rem = await this.fetchRemote(c, ''); } catch (e) { toast(/OperationError|decrypt/i.test(e.name + e.message) ? 'Der Code passt nicht zu den Daten.' : 'Verbinden ging nicht: ' + e.message, 5000); return null; }
    if (!rem.data) { toast('Unter diesem Code liegt (noch) nichts. Ist die Verbindung beendet worden?', 5000); return null; }
    const R = rem.data;
    c.name = R.name || 'Geteilte Orte';
    c.withTracks = R.withTracks !== false;
    // Bereich in eigene Listen übersetzen; gleichnamige Listen: zusammenlegen oder getrennt halten
    const listNames = [...new Set(Object.values(R.items || {}).map((it) => it.list).filter(Boolean).concat(R.scope && R.scope.type === 'lists' ? R.scope.lists : []).concat(R.scope && R.scope.type === 'countries' ? R.scope.countries.map((x) => x[0]) : []))];
    for (const ln of listNames) {
      const mine = Lists.all.find((l) => l.id !== 'mine' && norm(l.name).trim() === norm(ln).trim());
      if (mine && places.some((p) => p.list === mine.id)) {
        const pick = await Lists.choose(`„${ln}“ gibt es bei dir schon`, [
          { id: 'merge', label: 'Mit meiner Liste zusammenlegen', d: SYMBOLS.bookmark, color: mine.color, ink: Lists.inkFor(mine.color), sq: true },
          { id: 'apart', label: `Getrennt halten: „${ln} (${c.name})“`, d: 'M12 5v14M5 12h14' }
        ]);
        if (!pick) return null;
        c.listMap[ln] = pick === 'merge' ? mine.id : Lists.ensure(`${ln} (${c.name})`, mine.color);
      }
    }
    const s = R.scope || { type: 'items' };
    if (s.type === 'all') c.scope = { type: 'all' };
    else if (s.type === 'lists') c.scope = { type: 'lists', lists: s.lists.map((n) => c.listMap[n] || Lists.ensure(n, (Object.values(R.items).find((it) => it.list === n) || {}).listColor)) };
    else if (s.type === 'countries') c.scope = { type: 'countries', countries: s.countries.map(([n, cc]) => [c.listMap[n] || (n ? Lists.ensure(n) : 'mine'), cc]) };
    else if (s.type === 'cats') c.scope = { type: 'cats', cats: s.cats.map((x) => Lists.catFromExt(x) || 'other') };
    else c.scope = { type: 'items', ids: Object.values(R.items || {}).map((it) => it.id) };
    for (const [n, id] of Object.entries(c.listMap)) c.listMap[n] = id;
    this.conns.push(c);
    try { await this.syncOne(c); c.err = ''; } catch (e) { c.err = e.message; }
    this.save();
    Lists.refresh();
    renderDataCats();
    Lists.enrich();
    toast(`Verbunden mit „${c.name}“ · ${c.n || 0} Orte${c.w ? '' : ' (nur ansehen)'}`, 5000);
    return c;
  },
  async remove(c, { server, dropPlaces } = {}) {
    if (server && c.w) {
      try { await fetch(this.url() + c.id, { method: 'DELETE', headers: { 'X-Write': c.w } }); } catch (e) { toast('Konnte die Ablage nicht löschen (kein Internet?).'); }
    }
    if (dropPlaces) {
      const ids = new Set(this.scoped(c).map((p) => p.id));
      places = places.filter((p) => !ids.has(p.id));
      savePlaces();
      Lists.refresh();
    }
    this.conns = this.conns.filter((x) => x !== c);
    this.save();
  },
  /* einzelne Orte einer bestehenden Verbindung hinzufügen */
  addItems(c, items) {
    for (const p of items) if (!c.scope.ids.includes(p.id)) c.scope.ids.push(p.id);
    this.save();
    this.syncAll();
    toast(`${items.length} ${items.length === 1 ? 'Ort' : 'Orte'} zu „${c.name}“ hinzugefügt`);
  },

  /* ---------- Teilen-Menü: GPX oder Verbindung ---------- */
  async shareMenu(items, title, scope, trks) {
    const opts = [{ id: 'gpx', label: 'Als GPX-Datei senden', d: 'M12 4v11M7 10l5 5 5-5M5 20h14' },
      { id: 'sync', label: 'Live verbinden (Sync-Code)', d: 'M7 7h10l-3-3M17 17H7l3 3' }];
    if (scope && scope.type === 'items') for (const c of this.conns.filter((x) => x.scope.type === 'items' && x.w)) opts.push({ id: 'add:' + c.id, label: `Zu „${c.name}“ hinzufügen`, d: 'M12 5v14M5 12h14' });
    const pick = await Lists.choose(title + ' teilen', opts);
    if (!pick) return;
    if (pick === 'gpx') { Lists.share(items, title, trks); return; }
    if (pick.startsWith('add:')) { this.addItems(this.get(pick.slice(4)), items); return; }
    this.openNew({ name: title, scope: scope || { type: 'items', ids: items.map((p) => p.id) } });
  },

  /* ---------- Menü ---------- */
  renderMenu() {
    const box = $('#sync-list');
    if (!box) return;
    box.innerHTML = '';
    for (const c of this.conns) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'place-item sync-row';
      row.innerHTML = `<span class="pi-icon sync-ic${c.err ? ' err' : ''}">${svgPath('M7 7h10l-3-3M17 17H7l3 3')}</span><span class="pi-txt"><b></b><small></small></span>${svgPath('m9 5 7 7-7 7', 'chev')}`;
      row.querySelector('b').textContent = c.name;
      row.querySelector('small').textContent = (c.err ? '⚠︎ ' + c.err : (c.role === 'owner' ? 'von dir' : 'verbunden') + ' · ' + (c.w ? 'gemeinsam bearbeiten' : 'nur ansehen') + ' · ' + this.ago(c.at));
      row.onclick = () => this.openConn(c.id);
      box.appendChild(row);
    }
  },
  ago(t) {
    if (!t) return 'noch nicht abgeglichen';
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    return m < 1 ? 'gerade abgeglichen' : m < 60 ? `vor ${m} Min. abgeglichen` : m < 1440 ? `vor ${Math.round(m / 60)} Std. abgeglichen` : `am ${new Date(t).toLocaleDateString('de')} abgeglichen`;
  },
  page(id) {
    for (const p of ['#sync-new-page', '#sync-code-page', '#sync-join-page', '#sync-conn-page', '#live-new-page', '#live-group-page']) $(p).hidden = p !== id;
    if (id) { $('#sheet').hidden = false; $(id + ' .sheet-body').scrollTop = 0; }
  },

  /* neue Verbindung: Name, Umfang, Rechte */
  openNew(preset) {
    this.draft = { name: (preset && preset.name) || '', scope: (preset && preset.scope) || { type: 'all' }, write: true, fixed: !!(preset && preset.scope), withTracks: true };
    $('#sn-name').value = this.draft.name;
    this.renderNew();
    this.page('#sync-new-page');
  },
  renderNew() {
    const d = this.draft;
    const seg = $('#sn-scope');
    seg.hidden = d.fixed;
    for (const b of seg.querySelectorAll('button')) { b.setAttribute('aria-checked', String(b.dataset.scope === d.scope.type)); b.onclick = () => { d.scope = b.dataset.scope === 'lists' ? { type: 'lists', lists: [] } : b.dataset.scope === 'cats' ? { type: 'cats', cats: [] } : { type: 'all' }; this.renderNew(); }; }
    const box = $('#sn-pick');
    box.innerHTML = '';
    const tick = (label, on, set, icon) => {
      const r = document.createElement('label');
      r.className = 'row';
      r.innerHTML = `<span class="sn-lab">${icon || ''}<b></b></span><input type="checkbox" class="switch">`;
      r.querySelector('b').textContent = label;
      const sw = r.querySelector('input');
      sw.checked = on;
      sw.onchange = () => set(sw.checked);
      box.appendChild(r);
    };
    if (d.fixed) {
      const p = document.createElement('p');
      p.className = 'sn-fixed';
      p.textContent = this.describe({ scope: d.scope, withTracks: false });
      box.appendChild(p);
    } else if (d.scope.type === 'all') {
      tick('Tracks mit abgleichen', d.withTracks, (v) => { d.withTracks = v; });
    } else if (d.scope.type === 'lists') {
      for (const l of Lists.all) tick(`${l.name} (${places.filter((p) => (p.list || 'mine') === l.id).length})`, d.scope.lists.includes(l.id), (v) => { d.scope.lists = v ? [...d.scope.lists, l.id] : d.scope.lists.filter((x) => x !== l.id); },
        `<span class="pi-icon${l.id === 'mine' ? ' own' : ' sq'} mini" style="background:${l.color}"></span>`);
    } else if (d.scope.type === 'cats') {
      for (const c of CATS) { const n = places.filter((p) => p.cat === c.id).length; if (n || c.custom) tick(`${c.label} (${n})`, d.scope.cats.includes(c.id), (v) => { d.scope.cats = v ? [...d.scope.cats, c.id] : d.scope.cats.filter((x) => x !== c.id); }, `<span class="pi-icon own mini" style="background:${c.color}"></span>`); }
    }
    for (const b of $('#sn-rights').querySelectorAll('button')) { b.setAttribute('aria-checked', String((b.dataset.w === '1') === d.write)); b.onclick = () => { d.write = b.dataset.w === '1'; this.renderNew(); }; }
    $('#sn-rights-hint').textContent = d.write ? 'Alle mit dem Code können Orte ändern, hinzufügen und löschen. Änderungen kommen bei allen an.' : 'Die anderen sehen deine Orte und bekommen deine Änderungen, können selbst aber nichts ändern.';
  },
  async createFromDraft() {
    const d = this.draft;
    const name = $('#sn-name').value.trim();
    if (!name) { $('#sn-name').focus(); toast('Bitte einen Namen eingeben, z. B. „Island mit Freunden“.'); return; }
    if (d.scope.type === 'lists' && !d.scope.lists.length) { toast('Bitte mindestens eine Liste wählen.'); return; }
    if (d.scope.type === 'cats' && !d.scope.cats.length) { toast('Bitte mindestens eine Kategorie wählen.'); return; }
    if (!navigator.onLine) { toast('Zum Anlegen brauchst du Internet.'); return; }
    const btn = $('#sn-create');
    btn.disabled = true;
    btn.textContent = 'Wird angelegt …';
    try {
      const c = await this.create({ name, scope: d.scope, write: d.write, withTracks: d.withTracks });
      if (c.err) toast(c.err, 6000);
      this.renderMenu();
      this.showCode(c, d.write);
    } finally { btn.disabled = false; btn.textContent = 'Verbindung anlegen'; }
  },

  /* Code als QR und Text */
  async showCode(c, write) {
    this.open = c.id;
    const code = this.code(c, write);
    await this.codePage({ title: c.name, rights: write ? 'Gemeinsam bearbeiten' : 'Nur ansehen', code,
      text: `Overland-Navi: „${c.name}“ (${write ? 'gemeinsam bearbeiten' : 'nur ansehen'}).\nSo geht’s: Den Code unten kopieren, die Overland-Navi-App öffnen und den Code ins Suchfeld einfügen (oder Menü → Verbindungen → Code eingeben).\n\n${code}\n\nOhne App: Link öffnen`,
      back: () => this.openConn(c.id) });
  },
  /* QR, Link und Code zeigen (auch für Standort teilen) */
  async codePage({ title, rights, code, text, back, hint }) {
    const link = this.link(code);
    $('#sc-name').textContent = title;
    $('#sc-rights').textContent = rights;
    $('#sc-hint').textContent = hint || 'Den QR-Code mit dem anderen Handy scannen oder den Link schicken. Wer den Code hat, bekommt die Orte – nur an Leute geben, denen du vertraust.';
    $('#sc-code').textContent = code;
    const qr = $('#sc-qr');
    qr.innerHTML = '';
    try {
      if (typeof qrcode === 'undefined') await loadScript('vendor/qrcode.js');
      const q = qrcode(0, 'M');
      q.addData(link);
      q.make();
      qr.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } catch (e) { qr.innerHTML = '<p class="muted small">QR-Code gerade nicht verfügbar – schick den Link oder den Code.</p>'; }
    $('#sc-share').onclick = async () => {
      if (navigator.share) { try { await navigator.share({ title, text, url: link }); return; } catch (e) { if (e.name === 'AbortError') return; } }
      this.copy(text + '\n' + link);
    };
    $('#sc-copy').onclick = () => this.copy(code);
    this._codeBack = back || null;
    this.page('#sync-code-page');
  },
  async copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Kopiert ✓'); }
    catch (e) { const r = document.createRange(); r.selectNodeContents($('#sc-code')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Code markiert – jetzt kopieren.'); }
  },

  /* beitreten */
  openJoin(prefill) {
    $('#sj-code').value = prefill || '';
    const inBrowser = !!prefill && !(window.matchMedia('(display-mode: standalone)').matches || navigator.standalone);
    $('#sj-browser').hidden = !inBrowser;
    $('#sj-go').textContent = inBrowser ? 'Nein, hier im Browser verbinden' : 'Verbinden';
    $('#sj-go').classList.toggle('primary', !inBrowser);
    $('#sj-scan').hidden = !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    this.page('#sync-join-page');
  },
  async doJoin() {
    const btn = $('#sj-go');
    btn.disabled = true;
    try {
      const c = await this.join($('#sj-code').value);
      if (c && c.live) Live.openGroup(c.id);
      else if (c) { this.renderMenu(); this.openConn(c.id); }
    } finally { btn.disabled = false; }
  },
  async scan() {
    const box = $('#sj-cam');
    let stream = null, stop = false;
    const end = () => { stop = true; if (stream) for (const t of stream.getTracks()) t.stop(); box.hidden = true; box.innerHTML = ''; };
    try {
      if (typeof jsQR === 'undefined') await loadScript('vendor/jsqr.js');
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (e) { end(); toast('Kamera nicht verfügbar. Code einfügen geht immer.'); return; }
    box.hidden = false;
    box.innerHTML = '<video playsinline muted></video><button type="button" class="btn">Abbrechen</button>';
    box.querySelector('button').onclick = end;
    const v = box.querySelector('video');
    v.srcObject = stream;
    await v.play();
    const cv = document.createElement('canvas');
    const g = cv.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (stop) return;
      if (v.videoWidth) {
        cv.width = v.videoWidth; cv.height = v.videoHeight;
        g.drawImage(v, 0, 0);
        const r = jsQR(g.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, { inversionAttempts: 'dontInvert' });
        if (r && this.parse(r.data)) { $('#sj-code').value = r.data; end(); this.doJoin(); return; }
      }
      requestAnimationFrame(tick);
    };
    tick();
  },

  /* eine Verbindung im Menü */
  openConn(id) {
    this.open = id;
    this.renderConn();
    this.page('#sync-conn-page');
  },
  renderConn() {
    const c = this.get(this.open);
    if (!c) { this.page(null); return; }
    $('#scn-name').textContent = c.name;
    $('#scn-what').textContent = this.describe(c);
    $('#scn-rights').textContent = (c.role === 'owner' ? 'Von dir angelegt' : 'Du bist verbunden') + ' · ' + (c.w ? 'gemeinsam bearbeiten' : 'nur ansehen');
    $('#scn-status').textContent = c.err ? '⚠︎ ' + c.err : this.ago(c.at);
    $('#scn-status').classList.toggle('err', !!c.err);
    $('#scn-sync').onclick = () => this.syncAll(true);
    $('#scn-code-edit').hidden = !c.w;
    $('#scn-code-edit').onclick = () => this.showCode(c, true);
    $('#scn-code-view').onclick = () => this.showCode(c, false);
    const del = $('#scn-del');
    delete del.dataset.sure;
    del.textContent = c.role === 'owner' ? 'Verbindung beenden' : 'Verbindung trennen';
    del.onclick = async () => {
      if (c.role === 'owner') {
        const pick = await Lists.choose('Verbindung beenden', [
          { id: 'all', label: 'Für alle beenden (Ablage löschen)', d: 'M6 6l12 12M18 6 6 18' },
          { id: 'me', label: 'Nur auf diesem Gerät trennen', d: 'M7 7h10l-3-3M17 17H7l3 3' }]);
        if (!pick) return;
        await this.remove(c, { server: pick === 'all' });
      } else {
        const pick = await Lists.choose('Verbindung trennen', [
          { id: 'keep', label: 'Trennen, Orte behalten', d: 'M5 12l5 5 9-10' },
          { id: 'drop', label: 'Trennen und Orte löschen', d: 'M6 6l12 12M18 6 6 18' }]);
        if (!pick) return;
        await this.remove(c, { dropPlaces: pick === 'drop' });
      }
      toast('Verbindung getrennt');
      this.open = null;
      this.renderMenu();
      renderDataCats();
      this.page(null);
    };
  },

  setup() {
    this.init();
    $('#btn-sync-new').onclick = () => this.openNew(null);
    $('#btn-sync-join').onclick = () => this.openJoin('');
    if ($('#btn-live-join')) $('#btn-live-join').onclick = () => this.openJoin('');
    $('#sn-back').onclick = () => this.page(null);
    $('#sn-create').onclick = () => this.createFromDraft();
    $('#sc-back').onclick = () => { if (this._codeBack) this._codeBack(); else this.page(null); };
    $('#sj-back').onclick = () => this.page(null);
    $('#sj-go').onclick = () => this.doJoin();
    $('#sj-scan').onclick = () => this.scan();
    $('#sj-paste').onclick = async () => { try { $('#sj-code').value = await navigator.clipboard.readText(); } catch (e) { toast('Einfügen nicht erlaubt – lange ins Feld tippen und „Einsetzen“ wählen.'); } };
    $('#sj-copy').onclick = () => { navigator.clipboard.writeText($('#sj-code').value).then(() => toast('Code kopiert – jetzt die App vom Home-Bildschirm öffnen.'), () => toast('Bitte den Code markieren und kopieren.')); };
    $('#scn-back').onclick = () => { this.open = null; this.page(null); };
    this.renderMenu();
    // Link mit Code geöffnet?
    const m = location.hash.match(/join=([^&]+)/);   // Sync- oder Standort-Code
    if (m) {
      history.replaceState(null, '', location.pathname + location.search);
      setTimeout(() => this.openJoin(decodeURIComponent(m[1])), 800);
    }
    setTimeout(() => this.syncAll(), 4000);
    this.poll = setInterval(() => { if (!document.hidden) this.syncAll(); }, 90000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(() => this.syncAll(), 1500); });
    window.addEventListener('online', () => setTimeout(() => this.syncAll(), 2000));
  }
};
