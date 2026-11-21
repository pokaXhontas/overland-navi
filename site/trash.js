/* Papierkorb: Gelöschtes (Orte, Listen, eigene Kategorien, Tracks) bleibt 30 Tage und lässt sich zurückholen.
 * Orte, Listen und Kategorien liegen als Kopie im Speicher „trash“; Tracks bleiben in der Datenbank und tragen „trashed“. */
'use strict';

const Trash = {
  DAYS: 30,
  list: [],

  init() {
    this.list = store.get('trash', []);
    this.purge();
  },
  save() {
    store.set('trash', this.list);
    this.render();
    if (typeof Menu !== 'undefined') Menu.refresh();
  },
  push(e) {
    e.tid = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    e.time = Date.now();
    this.list.unshift(e);
    this.save();
    return e;
  },
  after() {
    savePlaces();
    Lists.refresh();
    Lists.rerenderPages();
    renderDataCats();
    const ps = map && map.getSource('places');
    if (ps) ps.setData(placesGeoJSON());
  },
  undo(e, msg) { toast(msg, 6000, { label: 'Rückgängig', run: () => this.restore(e) }); },

  /* ---------- in den Papierkorb ---------- */
  places(ps, label) {
    if (!ps.length) return;
    const ids = new Set(ps.map((p) => p.id));
    places = places.filter((p) => !ids.has(p.id));
    this.after();
    const name = label || (ps.length === 1 ? ps[0].name || 'Ort' : ps.length + ' Orte');
    const e = this.push({ kind: 'places', name, places: ps });
    this.undo(e, (ps.length === 1 ? `„${name}“` : name) + ' gelöscht');
  },
  listDel(id) {
    const l = Lists.all.find((x) => x.id === id);
    if (!l || id === 'mine') return;
    const ps = places.filter((p) => (p.list || 'mine') === id);
    places = places.filter((p) => (p.list || 'mine') !== id);
    Lists.all = Lists.all.filter((x) => x.id !== id);
    Lists.saveMeta();
    if (Lists.open === id) Lists.closeList();
    this.after();
    const e = this.push({ kind: 'list', name: l.name, list: JSON.parse(JSON.stringify(l)), places: ps });
    this.undo(e, `Liste „${l.name}“ gelöscht`);
  },
  catDel(id) {
    const c = customCats().find((x) => x.id === id);
    if (!c) return;
    const now = new Date().toISOString();
    const moved = [];
    for (const p of places) if (p.cat === id) { p.cat = 'other'; p.updated = now; moved.push(p.id); }
    setCustomCats(customCats().filter((x) => x.id !== id));
    if (typeof openCat !== 'undefined' && openCat === id) closeCatPage();
    this.after();
    const e = this.push({ kind: 'cat', name: c.label, cat: c, moved });
    this.undo(e, `Kategorie „${c.label}“ gelöscht`);
  },
  async track(t) {
    t.trashed = Date.now();
    try { await DB.run('tracks', 'readwrite', (st) => st.put(t)); } catch (err) { /* egal */ }
    tracks = tracks.filter((x) => x !== t);
    updateTracksSource();
    if (typeof Sync !== 'undefined') Sync.soon();
    const e = this.push({ kind: 'track', name: t.name || 'Track', trackId: t.id });
    this.undo(e, `Track „${e.name}“ gelöscht`);
  },

  /* ---------- zurückholen ---------- */
  putBack(ps) {
    const now = new Date().toISOString();
    const have = new Set(places.map((p) => p.id));
    for (const p of ps || []) {
      if (have.has(p.id)) continue;
      p.updated = now;
      if (!Lists.all.some((x) => x.id === (p.list || 'mine'))) p.list = 'mine';
      if (!CAT[p.cat]) p.cat = 'other';
      places.push(p);
    }
  },
  async restore(e) {
    if (!this.list.includes(e)) return;
    if (e.kind === 'list' && !Lists.all.some((x) => x.id === e.list.id)) { Lists.all.push(e.list); Lists.saveMeta(); }
    if (e.kind === 'cat') {
      if (!customCats().some((c) => c.id === e.cat.id)) setCustomCats([...customCats(), e.cat]);
      const now = new Date().toISOString(), ids = new Set(e.moved);
      for (const p of places) if (ids.has(p.id) && p.cat === 'other') { p.cat = e.cat.id; p.updated = now; }
    }
    if (e.kind === 'places' || e.kind === 'list') this.putBack(e.places);
    if (e.kind === 'track') {
      let t = null;
      try { t = await DB.run('tracks', 'readonly', (st) => st.get(e.trackId)); } catch (err) { /* egal */ }
      if (t && !tracks.some((x) => x.id === t.id)) {
        delete t.trashed;
        tracks.push(t);
        tracks.sort((a, b) => (a.created || 0) - (b.created || 0));
        await saveTrack(t);
        updateTracksSource();
      }
    }
    this.list = this.list.filter((x) => x !== e);
    this.save();
    this.after();
    toast(`„${e.name}“ ist wieder da`);
  },

  /* ---------- endgültig löschen ---------- */
  async destroy(e) {
    for (const p of e.places || []) {
      if (places.some((x) => x.id === p.id)) continue;   // inzwischen wieder da (z. B. über eine Verbindung)
      for (const ph of p.photos || []) { try { await PhotoDB.del(ph); } catch (err) { /* egal */ } }
    }
    if (e.kind === 'track' && !tracks.some((x) => x.id === e.trackId)) {
      try { await DB.run('tracks', 'readwrite', (st) => st.delete(e.trackId)); } catch (err) { /* egal */ }
    }
  },
  async purge() {
    const cut = Date.now() - this.DAYS * 864e5;
    const old = this.list.filter((e) => e.time < cut);
    if (!old.length) return;
    for (const e of old) await this.destroy(e);
    this.list = this.list.filter((e) => e.time >= cut);
    this.save();
  },
  async remove(e) {
    await this.destroy(e);
    this.list = this.list.filter((x) => x !== e);
    this.save();
  },
  async empty() {
    const b = $('#trash-empty');
    if (!b.dataset.sure) {
      b.dataset.sure = '1';
      b.textContent = 'Wirklich alles endgültig löschen?';
      setTimeout(() => { delete b.dataset.sure; b.textContent = 'Papierkorb leeren'; }, 4000);
      return;
    }
    delete b.dataset.sure;
    b.textContent = 'Papierkorb leeren';
    for (const e of this.list) await this.destroy(e);
    this.list = [];
    this.save();
    toast('Papierkorb ist leer');
  },

  /* ---------- Anzeige ---------- */
  summary() {
    const n = this.list.length;
    return n ? `${n} ${n === 1 ? 'Eintrag' : 'Einträge'} · bleiben ${this.DAYS} Tage` : 'Leer';
  },
  render() {
    const box = $('#trash-list');
    if (!box) return;
    box.innerHTML = '';
    $('#trash-empty').hidden = !this.list.length;
    if (!this.list.length) { box.innerHTML = '<p class="muted small">Der Papierkorb ist leer.</p>'; return; }
    const KIND = { places: 'Ort', list: 'Liste', cat: 'Kategorie', track: 'Track' };
    const ICON = { places: SYMBOLS.pin, list: SYMBOLS.bookmark, cat: 'M3 12V4h8l10 10-8 8ZM7.5 8h.01', track: 'M4 19c3 0 3-6 7-6s4-7 9-7' };
    for (const e of this.list) {
      const left = Math.max(1, Math.ceil((e.time + this.DAYS * 864e5 - Date.now()) / 864e5));
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'place-item trash-item';
      const color = e.kind === 'list' ? e.list.color : e.kind === 'cat' ? e.cat.color : e.kind === 'track' ? '#4F6FE0' : ((CAT[(e.places[0] || {}).cat] || CAT.other).color);
      b.innerHTML = `<span class="pi-icon${e.kind === 'list' ? ' sq' : ''}" style="background:${color};color:#fff">${svgPath(ICON[e.kind])}</span><span class="pi-txt"><b></b><small></small></span><span class="trash-back">Zurückholen</span>`;
      b.querySelector('b').textContent = e.name;
      const what = e.kind === 'places' ? (e.places.length === 1 ? 'Ort' : `${e.places.length} Orte`) : e.kind === 'list' ? `Liste mit ${e.places.length} ${e.places.length === 1 ? 'Ort' : 'Orten'}` : KIND[e.kind];
      b.querySelector('small').textContent = `${what} · noch ${left} ${left === 1 ? 'Tag' : 'Tage'}`;
      b.onclick = () => this.restore(e);
      box.appendChild(Swipe.row(b, { label: 'Endgültig', onDelete: () => this.remove(e) }));
    }
  },
  setup() {
    $('#trash-empty').onclick = () => this.empty();
    this.render();
  }
};
